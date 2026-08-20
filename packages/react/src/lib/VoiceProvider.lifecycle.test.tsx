import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  clientDisconnect: vi.fn(),
  getStream: vi.fn(),
  micStart: vi.fn(),
  micStop: vi.fn(),
  onCloseHandler: null as
    | null
    | ((event: CloseEvent, consumerInitiated: boolean) => void | Promise<void>),
  playerInit: vi.fn(),
  playerStop: vi.fn(),
  waitForDrain: vi.fn(),
}));

const fftStore = {
  getSnapshot: () => [],
  subscribe: () => () => {},
};

vi.mock('./useVoiceClient', async () => {
  const actual =
    await vi.importActual<typeof import('./useVoiceClient')>(
      './useVoiceClient',
    );
  return {
    ...actual,
    useVoiceClient: (props: Parameters<typeof actual.useVoiceClient>[0]) => {
      mocks.onCloseHandler = props.onClose ?? null;
      return {
        connect: mocks.clientConnect,
        disconnect: mocks.clientDisconnect,
        readyState: actual.VoiceReadyState.OPEN,
        sendAssistantInput: vi.fn(),
        sendAudio: vi.fn(),
        sendPauseAssistantMessage: vi.fn(),
        sendResumeAssistantMessage: vi.fn(),
        sendSessionSettings: vi.fn(),
        sendToolMessage: vi.fn(),
        sendUserInput: vi.fn(),
      };
    },
  };
});

vi.mock('./useSoundPlayer', () => ({
  useSoundPlayer: () => ({
    addToQueue: vi.fn(),
    clearQueue: vi.fn(),
    fftStore,
    initPlayer: mocks.playerInit,
    isAudioMuted: false,
    isPlaying: false,
    muteAudio: vi.fn(),
    queueLength: 0,
    setVolume: vi.fn(),
    stopAll: mocks.playerStop,
    unmuteAudio: vi.fn(),
    volume: 1,
    waitForQueueToDrain: mocks.waitForDrain,
  }),
}));

vi.mock('./useMicrophone', () => ({
  useMicrophone: () => ({
    fftStore,
    isMuted: false,
    mute: vi.fn(),
    start: mocks.micStart,
    stop: mocks.micStop,
    unmute: vi.fn(),
  }),
}));

vi.mock('./useMicrophoneStream', () => ({
  useMicrophoneStream: () => ({
    getStream: mocks.getStream,
    stopStream: vi.fn(),
  }),
}));

import { useVoice, VoiceProvider } from './VoiceProvider';

const createDeferred = <T,>() => {
  let resolve = (_value: T): void => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

describe('VoiceProvider close lifecycle', () => {
  let originalAudioContext: typeof globalThis.AudioContext;

  beforeEach(() => {
    originalAudioContext = globalThis.AudioContext;
    globalThis.AudioContext = vi.fn(() => ({
      close: vi.fn().mockResolvedValue(undefined),
    })) as unknown as typeof AudioContext;

    mocks.clientConnect.mockResolvedValue('open');
    mocks.getStream.mockResolvedValue({});
    mocks.micStop.mockResolvedValue(undefined);
    mocks.playerInit.mockResolvedValue(undefined);
    mocks.playerStop.mockResolvedValue(undefined);
    mocks.waitForDrain.mockResolvedValue(true);
  });

  afterEach(() => {
    globalThis.AudioContext = originalAudioContext;
    vi.clearAllMocks();
    mocks.onCloseHandler = null;
  });

  it('publishes socket closure immediately and ignores stale drain teardown', async () => {
    const deferredDrain = createDeferred<boolean>();
    mocks.waitForDrain.mockReturnValueOnce(deferredDrain.promise);
    const onClose = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider onClose={onClose}>{children}</VoiceProvider>
      ),
    });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    expect(result.current.status.value).toBe('connected');

    act(() => {
      mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
    });
    expect(result.current.status.value).toBe('disconnected');
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1006 }),
    );

    await act(() => result.current.disconnect());
    expect(mocks.playerStop).toHaveBeenCalledTimes(1);

    let reconnect = Promise.resolve();
    act(() => {
      reconnect = result.current.connect({
        auth: { type: 'accessToken', value: 'next-token' },
      });
    });
    expect(mocks.playerInit).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferredDrain.resolve(true);
      await reconnect;
    });

    await waitFor(() => expect(mocks.playerInit).toHaveBeenCalledTimes(2));
    expect(mocks.playerStop).toHaveBeenCalledTimes(1);
    expect(result.current.status.value).toBe('connected');
  });

  it('allows onClose to reconnect after the registered cleanup completes', async () => {
    const deferredDrain = createDeferred<boolean>();
    mocks.waitForDrain.mockReturnValueOnce(deferredDrain.promise);
    let reconnect = Promise.resolve();
    const onClose = vi.fn(() => {
      reconnect = rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'next-token' },
      });
    });
    const rendered = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider onClose={onClose}>{children}</VoiceProvider>
      ),
    });

    await act(() =>
      rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    const stopsBeforeClose = mocks.playerStop.mock.calls.length;

    act(() => {
      mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(rendered.result.current.status.value).toBe('disconnected');
    expect(mocks.playerInit).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferredDrain.resolve(true);
      await reconnect;
    });

    expect(mocks.playerStop).toHaveBeenCalledTimes(stopsBeforeClose + 1);
    expect(mocks.playerInit).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.status.value).toBe('connected');
  });
});
