import { act, renderHook } from '@testing-library/react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSoundPlayer } from './useSoundPlayer';
import type { AudioOutputMessage } from '../models/messages';
import { loadAudioWorklet } from '../utils/loadAudioWorklet';

vi.mock('./generateEmptyFft', () => ({
  generateEmptyFft: () => new Uint8Array(32).fill(0),
}));

vi.mock('./convertFrequencyScale', () => ({
  convertLinearFrequenciesToBark: (data: Uint8Array) => Array.from(data),
  convertLinearFrequenciesToBarkInto: (
    data: Uint8Array,
    _sampleRate: number,
    out: number[],
  ) => {
    for (let i = 0; i < out.length; i++) {
      out[i] = data[i] ?? 0;
    }
    return out;
  },
}));

vi.mock('hume', () => ({
  convertBase64ToBlob: (base64: string) => ({
    arrayBuffer: () =>
      Promise.resolve(Uint8Array.from([base64.charCodeAt(0)]).buffer),
  }),
}));

vi.mock('../utils/loadAudioWorklet', () => ({
  loadAudioWorklet: vi.fn(() => Promise.resolve(true)),
}));

const createFakeAudioBuffer = (index: number): AudioBuffer =>
  ({
    getChannelData: () => new Float32Array([index]),
    sampleRate: 48000,
  }) as unknown as AudioBuffer;

const createDeferred = <T>() => {
  let resolve = (_value: T): void => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

const fakePort: MessagePort & { postMessage: Mock } = {
  postMessage: vi.fn(),
  close: vi.fn(),
  onmessage: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
} as unknown as MessagePort & { postMessage: Mock };

type FakeBufferSource = {
  connect: Mock;
  disconnect: Mock;
  onended: (() => void) | null;
  start: Mock;
  stop: Mock;
};

describe('useSoundPlayer', () => {
  let originalAudioContext: typeof globalThis.AudioContext;
  let originalAudioWorkletNode: typeof globalThis.AudioWorkletNode;
  let bufferSources: FakeBufferSource[];
  let createBufferSource: Mock;
  let decodeAudioData: Mock;
  let audioContextState: AudioContextState;
  let resumeAudioContext: Mock;
  let closeAudioContext: Mock;
  let disconnectAnalyserNode: Mock;
  let disconnectGainNode: Mock;
  let gainSetters: Mock[];

  beforeEach(() => {
    originalAudioContext = globalThis.AudioContext;
    originalAudioWorkletNode = globalThis.AudioWorkletNode;
    audioContextState = 'running';
    resumeAudioContext = vi.fn().mockResolvedValue(undefined);
    closeAudioContext = vi.fn().mockResolvedValue(undefined);
    disconnectAnalyserNode = vi.fn();
    disconnectGainNode = vi.fn();
    gainSetters = [];
    decodeAudioData = vi.fn((buffer: ArrayBuffer) =>
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      Promise.resolve(createFakeAudioBuffer(new Uint8Array(buffer)[0]!)),
    );
    bufferSources = [];
    createBufferSource = vi.fn(() => {
      const source: FakeBufferSource = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
      };
      bufferSources.push(source);
      return source;
    });

    globalThis.AudioContext = vi.fn().mockImplementation(() => ({
      createAnalyser: () => ({
        fftSize: 2048,
        frequencyBinCount: 1024,
        connect: vi.fn(),
        disconnect: disconnectAnalyserNode,
        getByteFrequencyData: vi.fn(),
      }),
      createGain: () => {
        const setValueAtTime = vi.fn();
        gainSetters.push(setValueAtTime);
        return {
          connect: vi.fn(),
          disconnect: disconnectGainNode,
          gain: { setValueAtTime },
        };
      },
      createBufferSource,
      destination: {},
      decodeAudioData,
      close: closeAudioContext,
      get state() {
        return audioContextState;
      },
      resume: resumeAudioContext,
      sampleRate: 48000,
      currentTime: 0,
    }));

    globalThis.AudioWorkletNode = vi.fn().mockImplementation(() => ({
      port: fakePort,
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.AudioContext = originalAudioContext;
    globalThis.AudioWorkletNode = originalAudioWorkletNode;
  });

  it('returns false when a suspended AudioContext rejects resume', async () => {
    audioContextState = 'suspended';
    resumeAudioContext.mockRejectedValueOnce(new Error('autoplay blocked'));
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    let initialized = true;
    await act(async () => {
      initialized = await result.current.initPlayer();
    });

    expect(initialized).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('autoplay policy'),
      'audio_player_initialization_failure',
    );
    expect(globalThis.AudioWorkletNode).not.toHaveBeenCalled();
    expect(closeAudioContext).toHaveBeenCalledOnce();
  });

  it('reports initialization failure before an owned context close times out', async () => {
    vi.useFakeTimers();
    audioContextState = 'suspended';
    resumeAudioContext.mockRejectedValueOnce(new Error('autoplay blocked'));
    closeAudioContext.mockReturnValueOnce(new Promise<void>(() => {}));
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    let initialization = Promise.resolve(true);
    let settled = false;
    act(() => {
      initialization = result.current.initPlayer();
      void initialization.then(() => {
        settled = true;
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('autoplay policy'),
      'audio_player_initialization_failure',
    );
    expect(closeAudioContext).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await expect(initialization).resolves.toBe(false);
  });

  it('returns false when resume resolves but the context stays suspended', async () => {
    audioContextState = 'suspended';
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    let initialized = true;
    await act(async () => {
      initialized = await result.current.initPlayer();
    });

    expect(initialized).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('autoplay policy'),
      'audio_player_initialization_failure',
    );
    expect(globalThis.AudioWorkletNode).not.toHaveBeenCalled();
  });

  it('returns false when resuming a suspended AudioContext times out', async () => {
    vi.useFakeTimers();
    audioContextState = 'suspended';
    resumeAudioContext.mockReturnValueOnce(new Promise<void>(() => {}));
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    let initialization = Promise.resolve(true);
    act(() => {
      initialization = result.current.initPlayer();
    });
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    await expect(initialization).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('autoplay policy'),
      'audio_player_initialization_failure',
    );
    expect(globalThis.AudioWorkletNode).not.toHaveBeenCalled();
    expect(closeAudioContext).toHaveBeenCalledOnce();
  });

  it('releases owned nodes and context when worklet loading fails', async () => {
    vi.mocked(loadAudioWorklet).mockResolvedValueOnce(false);
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    await expect(result.current.initPlayer()).resolves.toBe(false);

    expect(disconnectAnalyserNode).toHaveBeenCalledOnce();
    expect(disconnectGainNode).toHaveBeenCalledOnce();
    expect(closeAudioContext).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      'Failed to load audio worklet',
      'audio_worklet_load_failure',
    );
  });

  it('disconnects failed initialization nodes without closing a shared context', async () => {
    vi.mocked(loadAudioWorklet).mockResolvedValueOnce(false);
    const sharedAnalyserDisconnect = vi.fn();
    const sharedGainDisconnect = vi.fn();
    const sharedContextClose = vi.fn().mockResolvedValue(undefined);
    const sharedContext = {
      state: 'running',
      createAnalyser: () => ({
        fftSize: 2048,
        frequencyBinCount: 1024,
        connect: vi.fn(),
        disconnect: sharedAnalyserDisconnect,
        getByteFrequencyData: vi.fn(),
      }),
      createGain: () => ({
        connect: vi.fn(),
        disconnect: sharedGainDisconnect,
        gain: { setValueAtTime: vi.fn() },
      }),
      destination: {},
      sampleRate: 48000,
      close: sharedContextClose,
    } as unknown as AudioContext;
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    await expect(
      result.current.initPlayer(undefined, sharedContext),
    ).resolves.toBe(false);

    expect(sharedAnalyserDisconnect).toHaveBeenCalledOnce();
    expect(sharedGainDisconnect).toHaveBeenCalledOnce();
    expect(sharedContextClose).not.toHaveBeenCalled();
  });

  it('replaces a successful player without disturbing the newer player', async () => {
    const firstWorkletLoad = createDeferred<boolean>();
    vi.mocked(loadAudioWorklet)
      .mockImplementationOnce(() => firstWorkletLoad.promise)
      .mockResolvedValueOnce(true);
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (callback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      },
    );
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const firstAnalyserDisconnect = vi.fn();
    const firstAnalyserRead = vi.fn();
    const firstGainDisconnect = vi.fn();
    const firstContextClose = vi.fn().mockResolvedValue(undefined);
    const secondAnalyserDisconnect = vi.fn();
    const secondGainDisconnect = vi.fn();
    const secondContextClose = vi.fn().mockResolvedValue(undefined);
    const createPort = (): MessagePort & { close: Mock; postMessage: Mock } =>
      ({
        postMessage: vi.fn(),
        close: vi.fn(),
        onmessage: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MessagePort & { close: Mock; postMessage: Mock };
    const firstPort = createPort();
    const secondPort = createPort();
    const firstWorkletDisconnect = vi.fn();
    const secondWorkletDisconnect = vi.fn();
    globalThis.AudioWorkletNode = vi
      .fn()
      .mockImplementationOnce(() => ({
        port: firstPort,
        connect: vi.fn(),
        disconnect: firstWorkletDisconnect,
      }))
      .mockImplementationOnce(() => ({
        port: secondPort,
        connect: vi.fn(),
        disconnect: secondWorkletDisconnect,
      }));
    const createContext = (
      analyserDisconnect: Mock,
      gainDisconnect: Mock,
      close: Mock,
      getByteFrequencyData = vi.fn(),
    ): AudioContext =>
      ({
        state: 'running',
        createAnalyser: () => ({
          fftSize: 2048,
          frequencyBinCount: 1024,
          connect: vi.fn(),
          disconnect: analyserDisconnect,
          getByteFrequencyData,
        }),
        createGain: () => ({
          connect: vi.fn(),
          disconnect: gainDisconnect,
          gain: { setValueAtTime: vi.fn() },
        }),
        createBufferSource,
        decodeAudioData,
        destination: {},
        sampleRate: 48000,
        close,
      }) as unknown as AudioContext;
    const firstContext = createContext(
      firstAnalyserDisconnect,
      firstGainDisconnect,
      firstContextClose,
      firstAnalyserRead,
    );
    const secondContext = createContext(
      secondAnalyserDisconnect,
      secondGainDisconnect,
      secondContextClose,
    );
    globalThis.AudioContext = vi
      .fn()
      .mockReturnValueOnce(firstContext)
      .mockReturnValueOnce(secondContext);
    const onPlayAudio = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio,
        onStopAudio: vi.fn(),
      }),
    );

    let supersededInitialization = Promise.resolve(true);
    act(() => {
      supersededInitialization = result.current.initPlayer();
    });
    await act(async () => {
      firstWorkletLoad.resolve(true);
      await expect(supersededInitialization).resolves.toBe(true);
    });
    expect(globalThis.AudioWorkletNode).toHaveBeenCalledOnce();
    const stalePortHandler = firstPort.onmessage;
    const fftWrite = vi.spyOn(result.current.fftStore, 'write');

    await act(async () => {
      await expect(result.current.initPlayer()).resolves.toBe(true);
    });
    expect(globalThis.AudioWorkletNode).toHaveBeenCalledTimes(2);

    await act(async () => {
      rafCallbacks[0]?.(0);
      stalePortHandler?.call(firstPort, {
        data: { type: 'start_clip', id: 'stale-player', index: 0 },
      } as MessageEvent);
      await Promise.resolve();
    });

    expect(firstAnalyserRead).not.toHaveBeenCalled();
    expect(fftWrite).not.toHaveBeenCalled();
    expect(onPlayAudio).not.toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(false);
    expect(firstAnalyserDisconnect).toHaveBeenCalledOnce();
    expect(firstGainDisconnect).toHaveBeenCalledOnce();
    expect(firstContextClose).toHaveBeenCalledOnce();
    expect(secondAnalyserDisconnect).not.toHaveBeenCalled();
    expect(secondGainDisconnect).not.toHaveBeenCalled();
    expect(secondContextClose).not.toHaveBeenCalled();
    expect(firstPort.close).toHaveBeenCalledOnce();
    expect(firstWorkletDisconnect).toHaveBeenCalledOnce();
    expect(secondPort.close).not.toHaveBeenCalled();
    expect(secondWorkletDisconnect).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    await act(() =>
      result.current.addToQueue({
        id: 'new-player',
        index: 0,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );
    expect(firstPort.postMessage).not.toHaveBeenCalled();
    expect(secondPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-player', type: 'audio' }),
    );

    let stop = Promise.resolve();
    act(() => {
      stop = result.current.stopAll();
      secondPort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(async () => {
      await stop;
    });
    expect(cancelAnimationFrame).toHaveBeenLastCalledWith(2);
  });

  it('does not close a shared context when replacing its player', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (_callback) => 1,
    );
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const createPort = (): MessagePort & { close: Mock; postMessage: Mock } =>
      ({
        postMessage: vi.fn(),
        close: vi.fn(),
        onmessage: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MessagePort & { close: Mock; postMessage: Mock };
    const sharedPort = createPort();
    const ownedPort = createPort();
    const sharedWorkletDisconnect = vi.fn();
    const ownedWorkletDisconnect = vi.fn();
    globalThis.AudioWorkletNode = vi
      .fn()
      .mockImplementationOnce(() => ({
        port: sharedPort,
        connect: vi.fn(),
        disconnect: sharedWorkletDisconnect,
      }))
      .mockImplementationOnce(() => ({
        port: ownedPort,
        connect: vi.fn(),
        disconnect: ownedWorkletDisconnect,
      }));

    const sharedAnalyserDisconnect = vi.fn();
    const sharedGainDisconnect = vi.fn();
    const sharedContextClose = vi.fn().mockResolvedValue(undefined);
    const ownedContextClose = vi.fn().mockResolvedValue(undefined);
    const createContext = (
      analyserDisconnect: Mock,
      gainDisconnect: Mock,
      close: Mock,
    ): AudioContext =>
      ({
        state: 'running',
        createAnalyser: () => ({
          fftSize: 2048,
          frequencyBinCount: 1024,
          connect: vi.fn(),
          disconnect: analyserDisconnect,
          getByteFrequencyData: vi.fn(),
        }),
        createGain: () => ({
          connect: vi.fn(),
          disconnect: gainDisconnect,
          gain: { setValueAtTime: vi.fn() },
        }),
        createBufferSource,
        decodeAudioData,
        destination: {},
        sampleRate: 48000,
        close,
      }) as unknown as AudioContext;
    const sharedContext = createContext(
      sharedAnalyserDisconnect,
      sharedGainDisconnect,
      sharedContextClose,
    );
    const ownedContext = createContext(vi.fn(), vi.fn(), ownedContextClose);
    globalThis.AudioContext = vi.fn().mockReturnValueOnce(ownedContext);

    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    await act(async () => {
      await expect(
        result.current.initPlayer(undefined, sharedContext),
      ).resolves.toBe(true);
      await expect(result.current.initPlayer()).resolves.toBe(true);
    });

    expect(sharedPort.close).toHaveBeenCalledOnce();
    expect(sharedWorkletDisconnect).toHaveBeenCalledOnce();
    expect(sharedAnalyserDisconnect).toHaveBeenCalledOnce();
    expect(sharedGainDisconnect).toHaveBeenCalledOnce();
    expect(sharedContextClose).not.toHaveBeenCalled();
    expect(ownedPort.close).not.toHaveBeenCalled();
    expect(ownedWorkletDisconnect).not.toHaveBeenCalled();
    expect(ownedContextClose).not.toHaveBeenCalled();

    await act(() =>
      result.current.addToQueue({
        id: 'owned-player',
        index: 0,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );
    expect(sharedPort.postMessage).not.toHaveBeenCalled();
    expect(ownedPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owned-player', type: 'audio' }),
    );
  });

  it('does not stop a newer player when cleaning up an older context', async () => {
    const firstContext = new AudioContext();
    const secondContext = new AudioContext();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    await act(() => result.current.initPlayer(undefined, firstContext));
    await act(() => result.current.initPlayer(undefined, secondContext));
    await act(() => result.current.stopAllForContext(firstContext));
    await act(() =>
      result.current.addToQueue({
        id: 'newer-player',
        index: 0,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );

    expect(createBufferSource).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('joins concurrent cleanup requests for the same context', async () => {
    const context = new AudioContext();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer(undefined, context));

    let firstStop = Promise.resolve();
    let secondStop = Promise.resolve();
    let secondSettled = false;
    act(() => {
      firstStop = result.current.stopAllForContext(context);
      secondStop = result.current.stopAllForContext(context).then(() => {
        secondSettled = true;
      });
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(fakePort.postMessage).toHaveBeenCalledTimes(2);

    act(() => {
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(() => Promise.all([firstStop, secondStop]));
    expect(secondSettled).toBe(true);
  });

  it('joins concurrent cleanup requests without an explicit context', async () => {
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());

    let firstStop = Promise.resolve();
    let secondStop = Promise.resolve();
    let secondSettled = false;
    act(() => {
      firstStop = result.current.stopAll();
      secondStop = result.current.stopAll().then(() => {
        secondSettled = true;
      });
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(fakePort.postMessage).toHaveBeenCalledTimes(2);

    act(() => {
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(() => Promise.all([firstStop, secondStop]));
    expect(secondSettled).toBe(true);
  });

  it('plays chunks in correct order when received in order', async () => {
    const onError = vi.fn();
    const onPlayAudio = vi.fn();
    const onStopAudio = vi.fn();

    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio,
        onStopAudio,
      }),
    );

    await act(() => result.current.initPlayer());

    const messages: AudioOutputMessage[] = [
      {
        id: 'abc',
        index: 0,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 1,
        data: '\x00',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 2,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 3,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
    ];

    await act(async () => {
      for (const msg of messages) {
        await result.current.addToQueue(msg);
      }
    });

    expect(fakePort.postMessage).toHaveBeenCalledTimes(4);
    expect(fakePort.postMessage.mock.calls[0]?.[0]).toMatchObject({
      id: 'abc',
      index: 0,
    });
    expect(fakePort.postMessage.mock.calls[1]?.[0]).toMatchObject({
      id: 'abc',
      index: 1,
    });
    expect(fakePort.postMessage.mock.calls[2]?.[0]).toMatchObject({
      id: 'abc',
      index: 2,
    });
    expect(fakePort.postMessage.mock.calls[3]?.[0]).toMatchObject({
      id: 'abc',
      index: 3,
    });
  });

  it('plays chunks in correct order when received out of order', async () => {
    const onError = vi.fn();
    const onPlayAudio = vi.fn();
    const onStopAudio = vi.fn();

    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio,
        onStopAudio,
      }),
    );

    await act(() => result.current.initPlayer());

    const messages: AudioOutputMessage[] = [
      {
        id: 'abc',
        index: 2,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 1,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 0,
        data: '\x00',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
    ];

    await act(async () => {
      for (const msg of messages) {
        await result.current.addToQueue(msg);
      }
    });

    expect(fakePort.postMessage).toHaveBeenCalledTimes(3);
    expect(fakePort.postMessage.mock.calls[0]?.[0]).toMatchObject({
      id: 'abc',
      index: 0,
    });
    expect(fakePort.postMessage.mock.calls[1]?.[0]).toMatchObject({
      id: 'abc',
      index: 1,
    });
    expect(fakePort.postMessage.mock.calls[2]?.[0]).toMatchObject({
      id: 'abc',
      index: 2,
    });
  });

  it('plays chunks in correct order when received out of order after the chunk at index 0 is received in order', async () => {
    const onError = vi.fn();
    const onPlayAudio = vi.fn();
    const onStopAudio = vi.fn();

    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio,
        onStopAudio,
      }),
    );

    await act(() => result.current.initPlayer());

    const messages: AudioOutputMessage[] = [
      {
        id: 'abc',
        index: 0,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 3,
        data: '\x00',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 2,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 1,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 4,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
    ];

    await act(async () => {
      for (const msg of messages) {
        await result.current.addToQueue(msg);
      }
    });

    expect(fakePort.postMessage).toHaveBeenCalledTimes(5);
    expect(fakePort.postMessage.mock.calls[0]?.[0]).toMatchObject({
      id: 'abc',
      index: 0,
    });
    expect(fakePort.postMessage.mock.calls[1]?.[0]).toMatchObject({
      id: 'abc',
      index: 1,
    });
    expect(fakePort.postMessage.mock.calls[2]?.[0]).toMatchObject({
      id: 'abc',
      index: 2,
    });
    expect(fakePort.postMessage.mock.calls[3]?.[0]).toMatchObject({
      id: 'abc',
      index: 3,
    });
    expect(fakePort.postMessage.mock.calls[4]?.[0]).toMatchObject({
      id: 'abc',
      index: 4,
    });
  });

  it('handles chunks from different message ids', async () => {
    const onError = vi.fn();
    const onPlayAudio = vi.fn();
    const onStopAudio = vi.fn();

    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio,
        onStopAudio,
      }),
    );

    await act(() => result.current.initPlayer());

    const messages: AudioOutputMessage[] = [
      {
        id: 'abc',
        index: 0,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 2,
        data: '\x00',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'abc',
        index: 1,
        data: '\x00',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'def',
        index: 1,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'def',
        index: 2,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
      {
        id: 'def',
        index: 0,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      },
    ];

    await act(async () => {
      for (const msg of messages) {
        await result.current.addToQueue(msg);
      }
    });

    expect(fakePort.postMessage).toHaveBeenCalledTimes(6);
    expect(fakePort.postMessage.mock.calls[0]?.[0]).toMatchObject({
      id: 'abc',
      index: 0,
    });
    expect(fakePort.postMessage.mock.calls[1]?.[0]).toMatchObject({
      id: 'abc',
      index: 1,
    });
    expect(fakePort.postMessage.mock.calls[2]?.[0]).toMatchObject({
      id: 'abc',
      index: 2,
    });
    expect(fakePort.postMessage.mock.calls[3]?.[0]).toMatchObject({
      id: 'def',
      index: 0,
    });
    expect(fakePort.postMessage.mock.calls[4]?.[0]).toMatchObject({
      id: 'def',
      index: 1,
    });
    expect(fakePort.postMessage.mock.calls[5]?.[0]).toMatchObject({
      id: 'def',
      index: 2,
    });
  });

  it('ignores a stale non-worklet onended callback after reinitializing', async () => {
    const onStopAudio = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio,
      }),
    );

    await act(() => result.current.initPlayer());
    await act(() =>
      result.current.addToQueue({
        id: 'old-session',
        index: 0,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );
    const oldSource = bufferSources[0];
    expect(oldSource).toBeDefined();
    const staleOnEnded = oldSource?.onended;

    await act(() => result.current.stopAll());
    expect(oldSource?.onended).toBeNull();
    expect(oldSource?.stop).toHaveBeenCalledOnce();

    await act(() => result.current.initPlayer());
    await act(() =>
      result.current.addToQueue({
        id: 'new-session',
        index: 0,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );
    const newSource = bufferSources[1];
    expect(newSource).toBeDefined();

    act(() => {
      staleOnEnded?.();
    });
    expect(result.current.isPlaying).toBe(true);
    expect(onStopAudio).not.toHaveBeenCalled();

    act(() => {
      newSource?.onended?.();
    });
    expect(onStopAudio).toHaveBeenCalledWith('new-session');
  });

  it('finishes non-worklet cleanup when clearQueue stops the active source', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 41);
    const cancelAnimationFrame = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation(() => {});
    const onStopAudio = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio,
      }),
    );
    await act(() => result.current.initPlayer());
    await act(() =>
      result.current.addToQueue({
        id: 'interrupted',
        index: 0,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );
    const source = bufferSources[0];

    act(() => result.current.clearQueue());
    expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
    expect(onStopAudio).toHaveBeenCalledWith('interrupted');
    expect(source?.onended).toBeNull();

    act(() => source?.onended?.());
    expect(onStopAudio).toHaveBeenCalledOnce();
  });

  it('preserves volume and mute state across stop and reinitialization', async () => {
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    act(() => result.current.setVolume(0.25));
    await act(() => result.current.initPlayer());
    expect(gainSetters[0]).toHaveBeenLastCalledWith(0.25, 0);

    act(() => result.current.muteAudio());
    expect(result.current.isAudioMuted).toBe(true);
    await act(() => result.current.stopAll());
    expect(result.current.volume).toBe(0.25);
    expect(result.current.isAudioMuted).toBe(true);

    await act(() => result.current.initPlayer());
    expect(gainSetters[1]).toHaveBeenLastCalledWith(0, 0);
  });

  it('resets the public queue length when stopping a worklet player', async () => {
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());
    act(() => {
      fakePort.onmessage?.({
        data: { type: 'queueLength', length: 3 },
      } as MessageEvent);
    });
    expect(result.current.queueLength).toBe(3);

    let stopping = Promise.resolve();
    act(() => {
      stopping = result.current.stopAll();
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(() => stopping);

    expect(result.current.queueLength).toBe(0);
  });

  it('reports the first teardown failure instead of retrying a detached player', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());
    fakePort.postMessage.mockImplementationOnce(() => {
      throw new Error('worklet post failed');
    });

    let stopping = Promise.resolve();
    act(() => {
      stopping = result.current.stopAll();
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(() => stopping);

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('worklet post failed'),
      'audio_player_closure_failure',
    );
    expect(disconnectAnalyserNode).toHaveBeenCalledOnce();
    expect(disconnectGainNode).toHaveBeenCalledOnce();
  });

  it('does not publish stale nodes after a pending sink selection', async () => {
    const deferredSink = createDeferred<void>();
    const firstCreateAnalyser = vi.fn();
    const secondAnalyser = {
      fftSize: 2048,
      frequencyBinCount: 1024,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteFrequencyData: vi.fn(),
    };
    const createContext = (
      createAnalyser: Mock,
      setSinkId?: Mock,
    ): AudioContext =>
      ({
        close: vi.fn().mockResolvedValue(undefined),
        createAnalyser,
        createBufferSource,
        createGain: () => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
          gain: { setValueAtTime: vi.fn() },
        }),
        decodeAudioData,
        destination: {},
        sampleRate: 48000,
        ...(setSinkId ? { setSinkId } : {}),
      }) as unknown as AudioContext;
    const firstContext = createContext(
      firstCreateAnalyser,
      vi.fn(() => deferredSink.promise),
    );
    const secondContext = createContext(vi.fn(() => secondAnalyser));
    globalThis.AudioContext = vi
      .fn()
      .mockReturnValueOnce(firstContext)
      .mockReturnValueOnce(secondContext);

    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    let staleInit = Promise.resolve(false);
    act(() => {
      staleInit = result.current.initPlayer('old-speaker');
    });
    await act(() => result.current.stopAll());
    await act(() => result.current.initPlayer());
    await act(async () => {
      deferredSink.resolve();
      await staleInit;
    });

    await act(() =>
      result.current.addToQueue({
        id: 'new-session',
        index: 0,
        data: '\x03',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );

    expect(firstCreateAnalyser).not.toHaveBeenCalled();
    expect(bufferSources[0]?.connect).toHaveBeenCalledWith(secondAnalyser);
  });

  it('switches the sink on the existing context without rebuilding playback', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const context = Object.assign(new AudioContext(), { setSinkId });
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer(undefined, context));
    await act(() =>
      result.current.addToQueue({
        id: 'queued-audio',
        index: 0,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );
    const createdSources = createBufferSource.mock.calls.length;

    await act(() => result.current.setOutputDevice('speaker-2'));
    await act(() => result.current.setOutputDevice(null));

    expect(setSinkId.mock.calls).toEqual([['speaker-2'], ['']]);
    expect(globalThis.AudioContext).toHaveBeenCalledOnce();
    expect(createBufferSource).toHaveBeenCalledTimes(createdSources);
    expect(closeAudioContext).not.toHaveBeenCalled();
  });

  it('rejects unsupported non-default output switching', async () => {
    const context = new AudioContext();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer(undefined, context));

    await expect(
      result.current.setOutputDevice('speaker-2'),
    ).rejects.toMatchObject({ name: 'NotSupportedError' });
    await expect(result.current.setOutputDevice(null)).resolves.toBeUndefined();
  });

  describe('waitForQueueToDrain', () => {
    const renderPlayer = (enableAudioWorklet: boolean) =>
      renderHook(() =>
        useSoundPlayer({
          enableAudioWorklet,
          onError: vi.fn(),
          onPlayAudio: vi.fn(),
          onStopAudio: vi.fn(),
        }),
      );

    const postWorkletMessage = (data: unknown) => {
      act(() => {
        fakePort.onmessage?.({ data } as MessageEvent);
      });
    };

    it('resolves immediately when nothing is queued or playing', async () => {
      const { result } = renderPlayer(true);
      await act(() => result.current.initPlayer());

      await expect(result.current.waitForQueueToDrain(1000)).resolves.toBe(
        true,
      );
    });

    it('resolves immediately in non-worklet mode when nothing is queued', async () => {
      const { result } = renderPlayer(false);
      await act(() => result.current.initPlayer());

      await expect(result.current.waitForQueueToDrain(1000)).resolves.toBe(
        true,
      );
    });

    it('waits for queued audio, then resolves once the queue empties', async () => {
      const { result } = renderPlayer(true);
      await act(() => result.current.initPlayer());

      postWorkletMessage({ type: 'queueLength', length: 3 });
      expect(result.current.queueLength).toBe(3);

      let settled = false;
      const pending = result.current.waitForQueueToDrain(5000).then((value) => {
        settled = true;
        return value;
      });

      // Still draining: the wait must not have resolved yet.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
      expect(settled).toBe(false);

      postWorkletMessage({ type: 'queueLength', length: 0 });

      await expect(pending).resolves.toBe(true);
      expect(result.current.queueLength).toBe(0);
    });

    it('does not drain immediately when the worklet starts its final block', async () => {
      const { result } = renderPlayer(true);
      await act(() => result.current.initPlayer());
      await act(() =>
        result.current.addToQueue({
          id: 'final',
          index: 0,
          data: '\x01',
          type: 'audio_output',
          receivedAt: new Date(0),
        }),
      );

      postWorkletMessage({ type: 'start_clip', id: 'final', index: 0 });
      postWorkletMessage({ type: 'queueLength', length: 0 });

      let settled = false;
      const pending = result.current.waitForQueueToDrain(5000).then((value) => {
        settled = true;
        return value;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await expect(pending).resolves.toBe(true);
    });

    it('waits for audio that is still being decoded', async () => {
      let resolveDecode = (_buffer: AudioBuffer): void => {
        throw new Error('Decode promise was not initialized.');
      };
      decodeAudioData.mockImplementationOnce(
        () =>
          new Promise<AudioBuffer>((resolve) => {
            resolveDecode = resolve;
          }),
      );

      const { result } = renderPlayer(true);
      await act(() => result.current.initPlayer());

      let addToQueue = Promise.resolve();
      act(() => {
        addToQueue = result.current.addToQueue({
          id: 'pending',
          index: 0,
          data: '\x01',
          type: 'audio_output',
          receivedAt: new Date(0),
        });
      });

      let settled = false;
      const pendingDrain = result.current
        .waitForQueueToDrain(5000)
        .then((value) => {
          settled = true;
          return value;
        });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
      expect(settled).toBe(false);

      await act(async () => {
        resolveDecode(createFakeAudioBuffer(1));
        await addToQueue;
      });
      await expect(pendingDrain).resolves.toBe(true);
    });

    it('waits on playback notifications instead of polling while busy', async () => {
      vi.useFakeTimers();
      const requestAnimationFrame = vi
        .spyOn(globalThis, 'requestAnimationFrame')
        .mockImplementation(() => 1);
      const { result } = renderPlayer(true);
      await act(() => result.current.initPlayer());
      postWorkletMessage({ type: 'queueLength', length: 2 });

      const pendingDrain = result.current.waitForQueueToDrain(5_000);
      await act(() => vi.advanceTimersToNextTimerAsync());
      await expect(pendingDrain).resolves.toBe(false);
      requestAnimationFrame.mockRestore();
      vi.useRealTimers();
    });

    it.each([true, false])(
      'discards a stale decode after stop and reinitialize (worklet: %s)',
      async (enableAudioWorklet) => {
        const deferredDecode = createDeferred<AudioBuffer>();
        decodeAudioData.mockReturnValueOnce(deferredDecode.promise);

        const { result } = renderPlayer(enableAudioWorklet);
        await act(() => result.current.initPlayer());

        let staleEnqueue = Promise.resolve();
        act(() => {
          staleEnqueue = result.current.addToQueue({
            id: 'old-session',
            index: 0,
            data: '\x01',
            type: 'audio_output',
            receivedAt: new Date(0),
          });
        });
        const staleDrain = result.current.waitForQueueToDrain(5000);

        let stop = Promise.resolve();
        act(() => {
          stop = result.current.stopAll();
          if (enableAudioWorklet) {
            fakePort.onmessage?.({
              data: { type: 'worklet_closed' },
            } as MessageEvent);
          }
        });
        await act(async () => {
          await stop;
        });
        await expect(staleDrain).resolves.toBe(false);

        fakePort.postMessage.mockClear();
        createBufferSource.mockClear();
        await act(() => result.current.initPlayer());
        await act(async () => {
          deferredDecode.resolve(createFakeAudioBuffer(1));
          await staleEnqueue;
        });

        const postedMessages = fakePort.postMessage.mock.calls.map(
          ([message]) => message as { type?: unknown },
        );
        expect(postedMessages.some((message) => message.type === 'audio')).toBe(
          false,
        );
        expect(createBufferSource).not.toHaveBeenCalled();
      },
    );

    it('gives up after the timeout when the queue never empties', async () => {
      const { result } = renderPlayer(true);
      await act(() => result.current.initPlayer());

      postWorkletMessage({ type: 'queueLength', length: 2 });

      await expect(result.current.waitForQueueToDrain(150)).resolves.toBe(
        false,
      );
    });
  });
});
