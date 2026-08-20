import { act, renderHook } from '@testing-library/react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSoundPlayer } from './useSoundPlayer';
import type { AudioOutputMessage } from '../models/messages';

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

  beforeEach(() => {
    originalAudioContext = globalThis.AudioContext;
    originalAudioWorkletNode = globalThis.AudioWorkletNode;
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
        disconnect: vi.fn(),
        getByteFrequencyData: vi.fn(),
      }),
      createGain: () => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        gain: { setValueAtTime: vi.fn() },
      }),
      createBufferSource,
      destination: {},
      decodeAudioData,
      close: vi.fn().mockResolvedValue(undefined),
      sampleRate: 48000,
    }));

    globalThis.AudioWorkletNode = vi.fn().mockImplementation(() => ({
      port: fakePort,
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
  });

  afterEach(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.AudioWorkletNode = originalAudioWorkletNode;
    vi.restoreAllMocks();
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

    let staleInit = Promise.resolve();
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
