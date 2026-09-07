import { act, renderHook, waitFor } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import type { AudioOutputMessage } from '../models/messages';
import { loadAudioWorklet } from '../utils/loadAudioWorklet';
import {
  createVoiceDiagnosticsReporter,
  type VoiceDiagnosticEvent,
} from './diagnostics';
import {
  useSoundPlayer,
  useSoundPlayerForVoiceProvider,
} from './useSoundPlayer';

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

const createFakePort = (): MessagePort & { close: Mock; postMessage: Mock } =>
  ({
    postMessage: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MessagePort & { close: Mock; postMessage: Mock };

let fakePort: ReturnType<typeof createFakePort>;

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
  let defaultGetByteFrequencyData: Mock;
  let gainSetters: Mock[];

  beforeEach(() => {
    originalAudioContext = globalThis.AudioContext;
    originalAudioWorkletNode = globalThis.AudioWorkletNode;
    fakePort = createFakePort();
    audioContextState = 'running';
    resumeAudioContext = vi.fn().mockResolvedValue(undefined);
    closeAudioContext = vi.fn().mockResolvedValue(undefined);
    disconnectAnalyserNode = vi.fn();
    disconnectGainNode = vi.fn();
    defaultGetByteFrequencyData = vi.fn();
    gainSetters = [];
    decodeAudioData = vi.fn((buffer: ArrayBuffer) =>
      // oxlint-disable-next-line typescript/no-non-null-assertion -- assertion follows the queue population above
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

    globalThis.AudioContext = vi
      .fn()
      .mockImplementation(function AudioContextMock() {
        return {
          createAnalyser: () => ({
            fftSize: 2048,
            frequencyBinCount: 1024,
            connect: vi.fn(),
            disconnect: disconnectAnalyserNode,
            getByteFrequencyData: defaultGetByteFrequencyData,
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
        };
      });

    globalThis.AudioWorkletNode = vi
      .fn()
      .mockImplementation(function AudioWorkletNodeMock() {
        return {
          port: fakePort,
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      });
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

  it('bounds rollback before reporting an initialization failure', async () => {
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

    expect(onError).not.toHaveBeenCalled();
    expect(closeAudioContext).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await expect(initialization).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('autoplay policy'),
      'audio_player_initialization_failure',
    );
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

  it('combines initialization and rollback cleanup failures', async () => {
    vi.mocked(loadAudioWorklet).mockResolvedValueOnce(false);
    const cleanupError = new Error('context close failed');
    closeAudioContext.mockRejectedValueOnce(cleanupError);
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        diagnostics,
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    await expect(result.current.initPlayer()).resolves.toBe(false);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(
        /Failed to load audio worklet.*context close failed/,
      ),
      'audio_worklet_load_failure',
    );
    expect(
      events.find(
        (event) =>
          event.name === 'resource.cleanup_failed' &&
          event.details['message'] ===
            'Failed to clean up an incomplete audio player initialization.',
      ),
    ).toMatchObject({
      category: 'audio_player',
      details: {
        error: {
          message: `Audio context cleanup failed: ${cleanupError.message}`,
        },
      },
    });
  });

  it('retains and retries a context whose replacement disposal failed', async () => {
    const replacementError = new Error('old context close failed');
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await expect(result.current.initPlayer()).resolves.toBe(true);
    closeAudioContext.mockRejectedValueOnce(replacementError);

    await expect(result.current.initPlayer()).resolves.toBe(false);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining(replacementError.message),
      'audio_player_closure_failure',
    );
    expect(globalThis.AudioContext).toHaveBeenCalledOnce();

    await expect(result.current.initPlayer()).resolves.toBe(true);

    expect(closeAudioContext).toHaveBeenCalledTimes(2);
    expect(globalThis.AudioContext).toHaveBeenCalledTimes(2);
  });

  it('cleans up initialization when the consumer error handler throws', async () => {
    vi.mocked(loadAudioWorklet).mockResolvedValueOnce(false);
    const onError = vi.fn(() => {
      throw new Error('consumer callback failed');
    });
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    await expect(result.current.initPlayer()).resolves.toBe(false);

    expect(onError).toHaveBeenCalledOnce();
    expect(disconnectAnalyserNode).toHaveBeenCalledOnce();
    expect(disconnectGainNode).toHaveBeenCalledOnce();
    expect(closeAudioContext).toHaveBeenCalledOnce();
  });

  it('preserves browser error details when initialization throws', async () => {
    const initializationError = new DOMException(
      'audio graph is unavailable',
      'NotSupportedError',
    );
    globalThis.AudioContext = vi
      .fn()
      .mockImplementation(function AudioContextMock() {
        throw initializationError;
      });
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

    expect(onError).toHaveBeenCalledWith(
      'Failed to initialize audio player: audio graph is unavailable',
      'audio_player_initialization_failure',
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
      .mockImplementationOnce(function FirstAudioWorkletNodeMock() {
        return {
          port: firstPort,
          connect: vi.fn(),
          disconnect: firstWorkletDisconnect,
        };
      })
      .mockImplementationOnce(function SecondAudioWorkletNodeMock() {
        return {
          port: secondPort,
          connect: vi.fn(),
          disconnect: secondWorkletDisconnect,
        };
      });
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
      .mockImplementationOnce(function FirstAudioContextMock() {
        return firstContext;
      })
      .mockImplementationOnce(function SecondAudioContextMock() {
        return secondContext;
      });
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
      .mockImplementationOnce(function SharedAudioWorkletNodeMock() {
        return {
          port: sharedPort,
          connect: vi.fn(),
          disconnect: sharedWorkletDisconnect,
        };
      })
      .mockImplementationOnce(function OwnedAudioWorkletNodeMock() {
        return {
          port: ownedPort,
          connect: vi.fn(),
          disconnect: ownedWorkletDisconnect,
        };
      });

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
    globalThis.AudioContext = vi
      .fn()
      .mockImplementationOnce(function OwnedAudioContextMock() {
        return ownedContext;
      });

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

  it('does not let an older implicit stop hide a reinitialized player on unmount', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const { result, unmount } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());

    let firstStop = Promise.resolve();
    act(() => {
      firstStop = result.current.stopAll();
    });
    await act(() => result.current.initPlayer());
    act(() => unmount());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await firstStop;
    });

    expect(closeAudioContext).toHaveBeenCalledTimes(2);
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

  it('continues non-worklet playback when animation cancellation throws', async () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextAnimationId = 0;
    const requestAnimationFrame = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        nextAnimationId += 1;
        rafCallbacks.set(nextAnimationId, callback);
        return nextAnimationId;
      });
    const cancellationError = new Error('animation cancellation failed');
    const cancelAnimationFrame = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementationOnce(() => {
        throw cancellationError;
      })
      .mockImplementation((id) => {
        rafCallbacks.delete(id);
      });
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const onStopAudio = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        diagnostics,
        enableAudioWorklet: false,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio,
      }),
    );
    await act(() => result.current.initPlayer());
    await act(() =>
      result.current.addToQueue({
        id: 'first',
        index: 0,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );
    await act(() =>
      result.current.addToQueue({
        id: 'second',
        index: 0,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );

    const firstSource = bufferSources[0];
    expect(() => act(() => firstSource?.onended?.())).not.toThrow();

    expect(firstSource?.disconnect).toHaveBeenCalledOnce();
    expect(onStopAudio).toHaveBeenCalledWith('first');
    expect(bufferSources).toHaveLength(2);
    expect(result.current.isPlaying).toBe(true);
    // Count only the frames each loop armed for itself. A global call count
    // also sees frames scheduled by the FFT store and by any other live loop.
    const framesArmedFor = (callback: FrameRequestCallback | undefined) =>
      requestAnimationFrame.mock.calls.filter(([armed]) => armed === callback);

    // The first clip's cancellation threw, so its loop survives only if the
    // generation guard misses it. Replaying its frame must not re-arm it.
    const stalePollFft = rafCallbacks.get(1);
    act(() => stalePollFft?.(0));
    expect(framesArmedFor(stalePollFft)).toHaveLength(1);

    // The stale frame must not erase the replacement frame's id; interruption
    // still needs to cancel the live loop.
    act(() => result.current.clearQueue());
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    expect(rafCallbacks.has(2)).toBe(false);
    expect(
      events.find(
        (event) =>
          event.name === 'resource.cleanup_failed' &&
          event.details['message'] ===
            'Failed to cancel the player analyzer animation frame.',
      ),
    ).toMatchObject({
      category: 'audio_player',
      details: { error: { message: cancellationError.message } },
    });
  });

  it('keeps the initialized playback mode until the player is reinitialized', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const { result, rerender } = renderHook(
      ({ enableAudioWorklet }) =>
        useSoundPlayer({
          enableAudioWorklet,
          onError: vi.fn(),
          onPlayAudio: vi.fn(),
          onStopAudio: vi.fn(),
        }),
      { initialProps: { enableAudioWorklet: true } },
    );
    await act(() => result.current.initPlayer());

    rerender({ enableAudioWorklet: false });
    await act(() =>
      result.current.addToQueue({
        id: 'mode-change',
        index: 0,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );
    expect(fakePort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio', id: 'mode-change' }),
    );
    expect(createBufferSource).not.toHaveBeenCalled();
    act(() => result.current.clearQueue());
    expect(fakePort.postMessage).toHaveBeenCalledWith({ type: 'fadeAndClear' });

    let stopping = Promise.resolve();
    act(() => {
      stopping = result.current.stopAll();
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await stopping;
    });

    fakePort.postMessage.mockClear();
    await act(() => result.current.initPlayer());
    await act(() =>
      result.current.addToQueue({
        id: 'reinitialized-mode',
        index: 0,
        data: '\x02',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );

    expect(createBufferSource).toHaveBeenCalledOnce();
    expect(fakePort.postMessage).not.toHaveBeenCalled();
  });

  it('finishes non-worklet cleanup when animation cancellation throws', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 41);
    const cancelAnimationFrame = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation(() => {
        throw new Error('animation cancellation failed');
      });
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

  it('cancels FFT polling when clearQueue runs before onended is installed', async () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (callback) => {
        rafCallbacks.set(41, callback);
        return 41;
      },
    );
    const cancelAnimationFrame = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation((id) => {
        rafCallbacks.delete(id);
      });
    let clearQueue = () => {};
    const onPlayAudio = vi.fn(() => clearQueue());
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError: vi.fn(),
        onPlayAudio,
        onStopAudio: vi.fn(),
      }),
    );
    clearQueue = result.current.clearQueue;
    await act(() => result.current.initPlayer());

    await act(() =>
      result.current.addToQueue({
        id: 'interrupted-before-onended',
        index: 0,
        data: '\x01',
        type: 'audio_output',
        receivedAt: new Date(0),
      }),
    );

    expect(onPlayAudio).toHaveBeenCalledWith('interrupted-before-onended');
    expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
    expect(rafCallbacks.has(41)).toBe(false);
  });

  it.each([
    { enableAudioWorklet: false, label: 'non-worklet' },
    { enableAudioWorklet: true, label: 'worklet' },
  ])(
    'reports a $label analyzer failure and does not re-arm its FFT loop',
    async ({ enableAudioWorklet }) => {
      const rafCallbacks = new Map<number, FrameRequestCallback>();
      let nextAnimationId = 0;
      const requestAnimationFrame = vi
        .spyOn(globalThis, 'requestAnimationFrame')
        .mockImplementation((callback) => {
          nextAnimationId += 1;
          rafCallbacks.set(nextAnimationId, callback);
          return nextAnimationId;
        });
      const analyzerError = new Error('player analyzer failed');
      defaultGetByteFrequencyData.mockImplementationOnce(() => {
        throw analyzerError;
      });
      const events: VoiceDiagnosticEvent[] = [];
      const diagnostics = createVoiceDiagnosticsReporter(() => ({
        logger: false,
        onEvent: (event) => events.push(event),
      }));
      const { result } = renderHook(() =>
        useSoundPlayer({
          diagnostics,
          enableAudioWorklet,
          onError: vi.fn(),
          onPlayAudio: vi.fn(),
          onStopAudio: vi.fn(),
        }),
      );
      await act(() => result.current.initPlayer());
      if (!enableAudioWorklet) {
        await act(() =>
          result.current.addToQueue({
            id: 'analyzer-failure',
            index: 0,
            data: '\x01',
            type: 'audio_output',
            receivedAt: new Date(0),
          }),
        );
      }
      const pollFft = rafCallbacks.get(nextAnimationId);
      rafCallbacks.delete(nextAnimationId);

      expect(() => act(() => pollFft?.(0))).not.toThrow();

      // The loop armed itself exactly once, at startup, and the failing frame
      // did not re-arm it.
      expect(
        requestAnimationFrame.mock.calls.filter(
          ([callback]) => callback === pollFft,
        ),
      ).toHaveLength(1);
      expect(
        events.find((event) => event.name === 'audio.analyzer_failed'),
      ).toMatchObject({
        level: 'warn',
        category: 'audio_player',
        details: {
          message: analyzerError.message,
          error: { message: analyzerError.message },
        },
      });
    },
  );

  it('disposes standalone player resources when unmounting', async () => {
    vi.useFakeTimers();
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextAnimationId = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (callback) => {
        nextAnimationId += 1;
        rafCallbacks.set(nextAnimationId, callback);
        return nextAnimationId;
      },
    );
    const cancelAnimationFrame = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation((id) => {
        rafCallbacks.delete(id);
      });
    const { result, unmount } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());
    const pollFftId = nextAnimationId;

    act(() => unmount());

    expect(fakePort.postMessage.mock.calls).toEqual([
      [{ type: 'fadeAndClear' }],
      [{ type: 'end' }],
    ]);
    expect(closeAudioContext).not.toHaveBeenCalled();

    act(() => {
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(cancelAnimationFrame).toHaveBeenCalledWith(pollFftId);
    expect(rafCallbacks.has(pollFftId)).toBe(false);
    expect(fakePort.close.mock.calls).toHaveLength(1);
    expect(disconnectAnalyserNode).toHaveBeenCalledOnce();
    expect(disconnectGainNode).toHaveBeenCalledOnce();
    expect(closeAudioContext).toHaveBeenCalledOnce();
  });

  it('disposes standalone nodes without closing a shared context on unmount', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 41);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const sharedContext = new AudioContext();
    const { result, unmount } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer(undefined, sharedContext));

    act(() => unmount());
    expect(fakePort.postMessage.mock.calls).toEqual([
      [{ type: 'fadeAndClear' }],
      [{ type: 'end' }],
    ]);
    act(() => {
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(fakePort.close).toHaveBeenCalledOnce();
    expect(disconnectAnalyserNode).toHaveBeenCalledOnce();
    expect(disconnectGainNode).toHaveBeenCalledOnce();
    expect(closeAudioContext).not.toHaveBeenCalled();
  });

  it('reports standalone unmount disposal failures once', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 41);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());
    fakePort.close.mockImplementationOnce(() => {
      throw new Error('port close failed');
    });

    act(() => unmount());
    act(() => {
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('port close failed'),
      'audio_player_closure_failure',
    );
    expect(disconnectAnalyserNode).toHaveBeenCalledOnce();
    expect(disconnectGainNode).toHaveBeenCalledOnce();
    expect(closeAudioContext).toHaveBeenCalledOnce();
  });

  it('reports one failure when unmount joins a public stop', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 41);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());
    fakePort.close.mockImplementationOnce(() => {
      throw new Error('joined stop failed');
    });

    let stopping = Promise.resolve();
    act(() => {
      stopping = result.current.stopAll();
    });
    act(() => unmount());
    act(() => {
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await stopping;
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('joined stop failed'),
      'audio_player_closure_failure',
    );
  });

  it('does not emit stop lifecycle events when an unused player unmounts', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      level: 'debug',
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const { unmount } = renderHook(() =>
      useSoundPlayer({
        diagnostics,
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    unmount();

    expect(
      events.filter(
        (event) =>
          event.name === 'resource.stop_started' ||
          event.name === 'resource.stopped',
      ),
    ).toHaveLength(0);
  });

  it('abandons standalone initialization that finishes after unmount', async () => {
    const workletLoad = createDeferred<boolean>();
    vi.mocked(loadAudioWorklet).mockImplementationOnce(
      () => workletLoad.promise,
    );
    const { result, unmount } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    let initialization = Promise.resolve(true);
    act(() => {
      initialization = result.current.initPlayer();
    });

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    await act(async () => {
      workletLoad.resolve(true);
      await expect(initialization).resolves.toBe(false);
    });

    expect(globalThis.AudioWorkletNode).not.toHaveBeenCalled();
    expect(disconnectAnalyserNode).toHaveBeenCalledOnce();
    expect(disconnectGainNode).toHaveBeenCalledOnce();
    expect(closeAudioContext).toHaveBeenCalledOnce();
  });

  it('contains cleanup failures while abandoning provider initialization', async () => {
    const workletLoad = createDeferred<boolean>();
    vi.mocked(loadAudioWorklet).mockImplementationOnce(
      () => workletLoad.promise,
    );
    closeAudioContext.mockRejectedValueOnce(
      new Error('abandoned context close failed'),
    );
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSoundPlayerForVoiceProvider({
        diagnostics,
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

    act(() => unmount());
    await act(async () => {
      workletLoad.resolve(true);
      await expect(initialization).resolves.toBe(false);
    });

    expect(onError).not.toHaveBeenCalled();
    expect(
      events.find(
        (event) =>
          event.name === 'resource.cleanup_failed' &&
          event.details['message'] ===
            'Failed to clean up an incomplete audio player initialization.',
      ),
    ).toBeDefined();
  });

  it('leaves initialized resources for provider cleanup when unmount cancellation throws', async () => {
    vi.useFakeTimers();
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextAnimationId = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (callback) => {
        nextAnimationId += 1;
        rafCallbacks.set(nextAnimationId, callback);
        return nextAnimationId;
      },
    );
    const cancelAnimationFrame = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation(() => {
        throw new Error('animation cancellation failed');
      });
    const { result, unmount } = renderHook(() =>
      useSoundPlayerForVoiceProvider({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());
    const stopAllForContext = result.current.stopAllForContext;
    const context = vi.mocked(globalThis.AudioContext).mock.results[0]
      ?.value as AudioContext | undefined;
    const stalePollFft = rafCallbacks.get(nextAnimationId);
    if (!context) throw new Error('Expected the initialized audio context.');
    if (!stalePollFft) throw new Error('Expected the FFT polling callback.');

    unmount();
    act(() => stalePollFft(0));

    expect(closeAudioContext).not.toHaveBeenCalled();
    expect(disconnectAnalyserNode).not.toHaveBeenCalled();
    expect(disconnectGainNode).not.toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();

    let stopping = Promise.resolve();
    act(() => {
      stopping = stopAllForContext(context);
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await stopping;
    });

    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(closeAudioContext).toHaveBeenCalledOnce();
    expect(disconnectAnalyserNode).toHaveBeenCalledOnce();
    expect(disconnectGainNode).toHaveBeenCalledOnce();
  });

  it('lets an in-flight provider stop finish its worklet handshake after unmount', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 41);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const { result, unmount } = renderHook(() =>
      useSoundPlayerForVoiceProvider({
        enableAudioWorklet: true,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());
    const context = vi.mocked(globalThis.AudioContext).mock.results[0]
      ?.value as AudioContext | undefined;
    if (!context) throw new Error('Expected the initialized audio context.');

    let stopping = Promise.resolve();
    act(() => {
      stopping = result.current.stopAllForContext(context);
    });
    act(() => unmount());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(closeAudioContext).not.toHaveBeenCalled();
    expect(disconnectAnalyserNode).not.toHaveBeenCalled();

    act(() => {
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await stopping;
    });

    expect(closeAudioContext).toHaveBeenCalledOnce();
    expect(disconnectAnalyserNode).toHaveBeenCalledOnce();
    expect(disconnectGainNode).toHaveBeenCalledOnce();
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

  it('rejects invalid worklet queue lengths and reports the failure once', async () => {
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
    act(() => {
      fakePort.onmessage?.({
        data: { type: 'queueLength', length: 2 },
      } as MessageEvent);
    });

    for (const length of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      act(() => {
        fakePort.onmessage?.({
          data: { type: 'queueLength', length },
        } as MessageEvent);
      });
      expect(result.current.queueLength).toBe(2);
    }

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenLastCalledWith(
      'Audio worklet returned an invalid control message.',
      'malformed_audio',
    );
  });

  it('reports distinct worklet protocol extensions within bounded limits', async () => {
    const onError = vi.fn();
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      level: 'debug',
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const { result } = renderHook(() =>
      useSoundPlayer({
        diagnostics,
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer());

    act(() => {
      fakePort.onmessage?.({
        data: { type: 'protocol_extension', value: true },
      } as MessageEvent);
      fakePort.onmessage?.({
        data: { type: 'protocol_extension', value: false },
      } as MessageEvent);
      fakePort.onmessage?.({
        data: { type: 'another_extension', value: true },
      } as MessageEvent);
      fakePort.onmessage?.({
        data: { type: 'x'.repeat(1024), value: true },
      } as MessageEvent);
      for (let index = 0; index < 20; index += 1) {
        fakePort.onmessage?.({
          data: { type: `extension_${index}`, value: true },
        } as MessageEvent);
      }
    });

    expect(onError).not.toHaveBeenCalled();
    expect(result.current.queueLength).toBe(0);
    expect(result.current.isPlaying).toBe(false);
    const ignoredEvents = events.filter(
      (event) => event.name === 'audio.worklet_message_ignored',
    );
    expect(ignoredEvents).toHaveLength(16);
    expect(ignoredEvents[0]?.level).toBe('debug');
    expect(ignoredEvents[0]?.details['messageType']).toBe('protocol_extension');
    expect(ignoredEvents[1]?.details['messageType']).toBe('another_extension');
    expect(ignoredEvents[2]?.details['messageType']).toBe('x'.repeat(128));
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

  it('reports public context-scoped cleanup failures through onError', async () => {
    const context = new AudioContext();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer(undefined, context));
    fakePort.postMessage.mockImplementationOnce(() => {
      throw new Error('worklet post failed');
    });

    let stopping = Promise.resolve();
    act(() => {
      stopping = result.current.stopAllForContext(context);
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });

    await expect(stopping).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('worklet post failed'),
      'audio_player_closure_failure',
    );
  });

  it('rejects internal context-scoped cleanup failures for provider aggregation', async () => {
    const context = new AudioContext();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayerForVoiceProvider({
        enableAudioWorklet: true,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer(undefined, context));
    fakePort.postMessage.mockImplementationOnce(() => {
      throw new Error('worklet post failed');
    });

    let stopping = Promise.resolve();
    act(() => {
      stopping = result.current.stopAllForContext(context);
      fakePort.onmessage?.({
        data: { type: 'worklet_closed' },
      } as MessageEvent);
    });

    await expect(stopping).rejects.toThrow('worklet post failed');
    expect(onError).not.toHaveBeenCalled();
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
      .mockImplementationOnce(function FirstAudioContextMock() {
        return firstContext;
      })
      .mockImplementationOnce(function SecondAudioContextMock() {
        return secondContext;
      });

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

  it('preserves a cross-realm-shaped sink-selection message', async () => {
    const sinkFailure = {
      message: 'speaker is unavailable',
      name: 'NotFoundError',
    };
    const setSinkId = vi.fn().mockRejectedValue(sinkFailure);
    const context = Object.assign(new AudioContext(), { setSinkId });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError,
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );

    await expect(
      result.current.initPlayer('missing-speaker', context),
    ).resolves.toBe(true);

    expect(onError).toHaveBeenCalledWith(
      'Failed to set speaker device: speaker is unavailable',
      'audio_player_initialization_failure',
    );
  });

  it('rejects a sink selection that finishes after player reinitialization', async () => {
    const deferredSink = createDeferred<void>();
    const setSinkId = vi.fn(() => deferredSink.promise);
    const firstContext = Object.assign(new AudioContext(), { setSinkId });
    const secondContext = new AudioContext();
    const { result } = renderHook(() =>
      useSoundPlayer({
        enableAudioWorklet: false,
        onError: vi.fn(),
        onPlayAudio: vi.fn(),
        onStopAudio: vi.fn(),
      }),
    );
    await act(() => result.current.initPlayer(undefined, firstContext));

    let switching = Promise.resolve();
    let switchOutcome: Promise<unknown> = Promise.resolve();
    act(() => {
      switching = result.current.setOutputDevice('speaker-2');
      switchOutcome = switching.catch((error: unknown) => error);
    });
    await waitFor(() => expect(setSinkId).toHaveBeenCalledOnce());
    await act(() => result.current.stopAll());
    await act(() => result.current.initPlayer(undefined, secondContext));

    await act(async () => {
      deferredSink.resolve();
      await switchOutcome;
    });

    await expect(switchOutcome).resolves.toMatchObject({ name: 'AbortError' });
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

    it('wakes a pending drain immediately when the player unmounts', async () => {
      vi.useFakeTimers();
      const { result, unmount } = renderPlayer(true);
      await act(() => result.current.initPlayer());
      postWorkletMessage({ type: 'queueLength', length: 2 });

      const pendingDrain = result.current.waitForQueueToDrain(5_000);
      act(() => unmount());

      await act(async () => {
        await expect(pendingDrain).resolves.toBe(false);
      });

      act(() => {
        fakePort.onmessage?.({
          data: { type: 'worklet_closed' },
        } as MessageEvent);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
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
