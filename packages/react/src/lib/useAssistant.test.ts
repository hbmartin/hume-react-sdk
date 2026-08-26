import { AudioEncoding, Channels } from '@humeai/assistant';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssistant } from './useAssistant';

const mocks = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  clientDisconnect: vi.fn(),
  clientOnError: null as null | ((message: string) => void),
  getStream: vi.fn(),
  micStart: vi.fn(),
  micStop: vi.fn(),
  playerInit: vi.fn(),
  playerStop: vi.fn(),
}));

vi.mock('./useMicrophone/useEncoding', () => ({
  useEncoding: () => ({ getStream: mocks.getStream }),
}));

vi.mock('./useMicrophone', () => ({
  useMicrophone: () => ({
    isMuted: false,
    mute: vi.fn(),
    start: mocks.micStart,
    stop: mocks.micStop,
    unmute: vi.fn(),
  }),
}));

vi.mock('./useSoundPlayer', () => ({
  useSoundPlayer: () => ({
    addToQueue: vi.fn(),
    fft: [],
    initPlayer: mocks.playerInit,
    isPlaying: false,
    stopAll: mocks.playerStop,
  }),
}));

vi.mock('./useAssistantClient', () => ({
  useAssistantClient: (props: { onError: (message: string) => void }) => {
    mocks.clientOnError = props.onError;
    return {
      connect: mocks.clientConnect,
      disconnect: mocks.clientDisconnect,
      messages: [],
      readyState: 'idle',
      sendAudio: vi.fn(),
    };
  },
}));

const createStream = () => {
  const stop = vi.fn();
  const stream = {
    getTracks: () => [{ stop }],
  } as unknown as MediaStream;
  return { stop, stream };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('useAssistant', () => {
  beforeEach(() => {
    mocks.clientConnect.mockReset();
    mocks.clientDisconnect.mockReset();
    mocks.clientOnError = null;
    mocks.getStream.mockReset();
    mocks.micStart.mockReset().mockResolvedValue(true);
    mocks.micStop.mockReset();
    mocks.playerInit.mockReset();
    mocks.playerStop.mockReset();
  });

  it('connects on every request with negotiated LINEAR16 settings', async () => {
    const first = createStream();
    const second = createStream();
    mocks.getStream
      .mockResolvedValueOnce({
        stream: first.stream,
        encoding: {
          sampleRate: 44_100,
          channelCount: Channels.STEREO,
        },
      })
      .mockResolvedValueOnce({
        stream: second.stream,
        encoding: {
          sampleRate: 48_000,
          channelCount: Channels.MONO,
        },
      });
    const { result } = renderHook(() =>
      useAssistant({ apiKey: 'test-api-key' }),
    );

    act(() => result.current.connect());
    await waitFor(() =>
      expect(result.current.status).toEqual({ value: 'connected' }),
    );
    act(() => result.current.disconnect());
    act(() => result.current.connect());
    await waitFor(() =>
      expect(result.current.status).toEqual({ value: 'connected' }),
    );

    expect(mocks.clientConnect).toHaveBeenCalledTimes(2);
    expect(mocks.clientConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channels: Channels.STEREO,
        encoding: AudioEncoding.LINEAR16,
        sampleRate: 44_100,
      }),
    );
    expect(mocks.clientConnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channels: Channels.MONO,
        encoding: AudioEncoding.LINEAR16,
        sampleRate: 48_000,
      }),
    );
    expect(result.current.status).toEqual({ value: 'connected' });
  });

  it('cleans up fatal errors without overwriting their status', () => {
    const { result } = renderHook(() =>
      useAssistant({ apiKey: 'test-api-key' }),
    );

    act(() => mocks.clientOnError?.('fatal socket error'));

    expect(mocks.clientDisconnect).toHaveBeenCalled();
    expect(mocks.playerStop).toHaveBeenCalled();
    expect(mocks.micStop).toHaveBeenCalled();
    expect(result.current.status).toEqual({
      value: 'error',
      reason: 'fatal socket error',
    });

    act(() => result.current.disconnect());
    expect(result.current.status).toEqual({
      value: 'error',
      reason: 'fatal socket error',
    });
  });

  it('cancels a pending connection and releases its late stream', async () => {
    const acquisition = deferred<{
      encoding: { sampleRate: number; channelCount: Channels };
      stream: MediaStream;
    }>();
    const candidate = createStream();
    mocks.getStream.mockReturnValue(acquisition.promise);
    const { result } = renderHook(() =>
      useAssistant({ apiKey: 'test-api-key' }),
    );

    act(() => result.current.connect());
    act(() => result.current.disconnect());
    act(() => {
      acquisition.resolve({
        stream: candidate.stream,
        encoding: {
          sampleRate: 48_000,
          channelCount: Channels.MONO,
        },
      });
    });

    await waitFor(() => expect(candidate.stop).toHaveBeenCalledOnce());

    expect(mocks.clientConnect).not.toHaveBeenCalled();
    expect(mocks.micStart).not.toHaveBeenCalled();
    expect(result.current.status).toEqual({ value: 'disconnected' });
  });
});
