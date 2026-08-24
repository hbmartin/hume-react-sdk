import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PlayerErrorHandler = (
  message: string,
  reason: 'audio_player_initialization_failure',
) => void;

const mocks = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  clientDisconnect: vi.fn(),
  contextClose: vi.fn(),
  getStream: vi.fn(),
  micStart: vi.fn(),
  micStop: vi.fn(),
  onCloseHandler: null as
    | null
    | ((event: CloseEvent, consumerInitiated: boolean) => void | Promise<void>),
  playerInit: vi.fn(),
  playerErrorHandler: null as null | PlayerErrorHandler,
  playerStop: vi.fn(),
  stopStream: vi.fn(),
  waitForDrain: vi.fn(),
}));

const fftStore = {
  getSnapshot: () => [],
  subscribe: () => () => {},
};

vi.mock('./useVoiceClient', async () => {
  const actual =
    await vi.importActual<typeof UseVoiceClientModule>('./useVoiceClient');
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
  useSoundPlayer: (props: { onError: PlayerErrorHandler }) => {
    mocks.playerErrorHandler = props.onError;

    return {
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
    };
  },
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
    stopStream: mocks.stopStream,
  }),
}));

import type * as UseVoiceClientModule from './useVoiceClient';
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
      close: mocks.contextClose,
    })) as unknown as typeof AudioContext;

    mocks.clientConnect.mockResolvedValue('open');
    mocks.contextClose.mockResolvedValue(undefined);
    mocks.getStream.mockResolvedValue({});
    mocks.micStop.mockResolvedValue(undefined);
    mocks.playerInit.mockResolvedValue(true);
    mocks.playerStop.mockResolvedValue(undefined);
    mocks.waitForDrain.mockResolvedValue(true);
  });

  afterEach(async () => {
    await act(async () => {
      cleanup();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    globalThis.AudioContext = originalAudioContext;
    vi.clearAllMocks();
    mocks.onCloseHandler = null;
    mocks.playerErrorHandler = null;
  });

  it('aborts before opening the socket when player initialization fails', async () => {
    mocks.playerInit.mockImplementationOnce(() => {
      mocks.playerErrorHandler?.(
        'The browser blocked audio playback (autoplay policy).',
        'audio_player_initialization_failure',
      );
      return Promise.resolve(false);
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider onError={onError}>{children}</VoiceProvider>
      ),
    });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    await waitFor(() => expect(result.current.status.value).toBe('error'));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audio_error',
        reason: 'audio_player_initialization_failure',
      }),
    );
    expect(mocks.clientConnect).not.toHaveBeenCalled();
    expect(mocks.micStart).not.toHaveBeenCalled();
    expect(mocks.stopStream).toHaveBeenCalledTimes(2);
    expect(mocks.playerStop).toHaveBeenCalledOnce();
    expect(mocks.contextClose).toHaveBeenCalledOnce();
  });

  it('releases the provider-owned context when player initialization returns false silently', async () => {
    mocks.playerInit.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    expect(mocks.stopStream).toHaveBeenCalledOnce();
    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(mocks.clientConnect).not.toHaveBeenCalled();
    expect(mocks.micStart).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
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
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
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
    const onClose = vi.fn();
    const rendered = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider onClose={onClose}>{children}</VoiceProvider>
      ),
    });
    onClose.mockImplementation(() => {
      reconnect = rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'next-token' },
      });
    });

    await act(() =>
      rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    const stopsBeforeClose = mocks.playerStop.mock.calls.length;

    act(() => {
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
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
