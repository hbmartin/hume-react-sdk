import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from '@testing-library/react';
import { useCallback, useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PlayerErrorHandler = (
  message: string,
  reason:
    | 'audio_player_initialization_failure'
    | 'audio_player_closure_failure',
) => void;

type MicrophoneErrorHandler = (
  message: string,
  reason: 'mic_closure_failure',
) => void;

const mocks = vi.hoisted(() => ({
  clearMessageStore: vi.fn(),
  clientConnect: vi.fn(),
  clientDisconnect: vi.fn(),
  clientSendAudio: vi.fn(),
  contextClose: vi.fn(),
  getStream: vi.fn(),
  micStart: vi.fn(),
  micReplace: vi.fn(),
  micStop: vi.fn(),
  microphoneProps: null as null | {
    onAudioCaptured: (buffer: ArrayBuffer) => void;
    onError: MicrophoneErrorHandler;
    onStartRecording?: () => void;
    onStopRecording?: () => void;
  },
  onCloseHandler: null as
    | null
    | ((event: CloseEvent, consumerInitiated: boolean) => void | Promise<void>),
  providerOnClose: null as
    | null
    | ((
        event: CloseEvent,
        consumerInitiated: boolean,
        connectionGeneration: number,
      ) => void | Promise<void>),
  connectionCloseHandlers: [] as Array<
    (event: CloseEvent, consumerInitiated: boolean) => void | Promise<void>
  >,
  playerInit: vi.fn(),
  playerSetOutputDevice: vi.fn(),
  playerErrorHandler: null as null | PlayerErrorHandler,
  playerStop: vi.fn(),
  playerStopForContext: vi.fn(),
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
      mocks.providerOnClose = props.onClose ?? null;
      return {
        connect: (
          ...args: Parameters<
            ReturnType<typeof actual.useVoiceClient>['connect']
          >
        ): ReturnType<ReturnType<typeof actual.useVoiceClient>['connect']> => {
          const connectionGeneration = args[2];
          if (connectionGeneration === undefined) {
            throw new Error('VoiceProvider must correlate every socket close.');
          }
          const closeHandler = (
            event: CloseEvent,
            consumerInitiated: boolean,
          ) =>
            mocks.providerOnClose?.(
              event,
              consumerInitiated,
              connectionGeneration,
            );
          mocks.connectionCloseHandlers.push(closeHandler);
          mocks.onCloseHandler = closeHandler;
          return mocks.clientConnect(...args) as ReturnType<
            ReturnType<typeof actual.useVoiceClient>['connect']
          >;
        },
        disconnect: mocks.clientDisconnect,
        readyState: actual.VoiceReadyState.OPEN,
        sendAssistantInput: vi.fn(),
        sendAudio: mocks.clientSendAudio,
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
  useSoundPlayerForVoiceProvider: (props: { onError: PlayerErrorHandler }) => {
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
      setOutputDevice: mocks.playerSetOutputDevice,
      stopAll: mocks.playerStop,
      stopAllForContext: mocks.playerStopForContext,
      unmuteAudio: vi.fn(),
      volume: 1,
      waitForQueueToDrain: mocks.waitForDrain,
    };
  },
}));

vi.mock('./useMicrophone', () => ({
  useMicrophone: (props: {
    onAudioCaptured: (buffer: ArrayBuffer) => void;
    onError: MicrophoneErrorHandler;
    onStartRecording?: () => void;
    onStopRecording?: () => void;
  }) => {
    mocks.microphoneProps = props;
    return {
      fftStore,
      isMuted: false,
      mute: vi.fn(),
      replace: mocks.micReplace,
      start: mocks.micStart,
      stop: mocks.micStop,
      unmute: vi.fn(),
    };
  },
}));

vi.mock('./useMicrophoneStream', () => ({
  useMicrophoneStream: () => ({
    getStream: mocks.getStream,
    stopStream: mocks.stopStream,
  }),
}));

vi.mock('./useMessages', async () => {
  const actual =
    await vi.importActual<typeof UseMessagesModule>('./useMessages');
  return {
    ...actual,
    useMessages: (...args: Parameters<typeof actual.useMessages>) => {
      const messageStore = actual.useMessages(...args);
      const { clearMessages } = messageStore;
      const trackedClearMessages = useCallback(() => {
        mocks.clearMessageStore();
        clearMessages();
      }, [clearMessages]);

      return useMemo(
        () => ({ ...messageStore, clearMessages: trackedClearMessages }),
        [messageStore, trackedClearMessages],
      );
    },
  };
});

import type { VoiceDiagnosticEvent } from './diagnostics';
import {
  isAudioDeviceSwitchError,
  isConcurrentConnectAuthError,
} from './errors';
import type * as UseMessagesModule from './useMessages';
import type * as UseVoiceClientModule from './useVoiceClient';
import { useVoice, VoiceProvider } from './VoiceProvider';

const createDeferred = <T,>() => {
  let resolve = (_value: T): void => {
    throw new Error('Deferred promise was not initialized.');
  };
  let reject = (_reason?: unknown): void => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
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
    mocks.micReplace.mockResolvedValue(undefined);
    mocks.playerInit.mockResolvedValue(true);
    mocks.playerSetOutputDevice.mockResolvedValue(undefined);
    mocks.playerStop.mockResolvedValue(undefined);
    mocks.playerStopForContext.mockResolvedValue(undefined);
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
    mocks.providerOnClose = null;
    mocks.connectionCloseHandlers.length = 0;
    mocks.playerErrorHandler = null;
    mocks.microphoneProps = null;
  });

  it('forwards microphone recording lifecycle callbacks', () => {
    const onStartRecording = vi.fn();
    const onStopRecording = vi.fn();
    renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider
          onStartRecording={onStartRecording}
          onStopRecording={onStopRecording}
        >
          {children}
        </VoiceProvider>
      ),
    });

    mocks.microphoneProps?.onStartRecording?.();
    mocks.microphoneProps?.onStopRecording?.();

    expect(onStartRecording).toHaveBeenCalledOnce();
    expect(onStopRecording).toHaveBeenCalledOnce();
  });

  it('emits correlated, ordered, and credential-safe lifecycle diagnostics', async () => {
    const events: VoiceDiagnosticEvent[] = [];
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider
          diagnostics={{
            level: 'debug',
            logger: false,
            onEvent: (event) => events.push(event),
          }}
        >
          {children}
        </VoiceProvider>
      ),
    });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
        devices: {
          microphoneDeviceId: 'private-input-device',
          speakerDeviceId: 'private-output-device',
        },
      }),
    );
    await act(() => result.current.disconnect());

    const attempt = events.find(
      (event) => event.name === 'connection.attempt_started',
    );
    const connected = events.find(
      (event) => event.name === 'connection.connected',
    );
    const disconnected = events.find(
      (event) => event.name === 'connection.disconnected',
    );

    expect(attempt?.connectionId).toBeTruthy();
    expect(connected).toMatchObject({ connectionId: attempt?.connectionId });
    expect(disconnected).toMatchObject({
      connectionId: attempt?.connectionId,
    });
    expect(connected?.durationMs).toEqual(expect.any(Number));
    expect(disconnected?.durationMs).toEqual(expect.any(Number));
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_event, index) => index + 1),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('test-token');
    expect(serialized).not.toContain('private-input-device');
    expect(serialized).not.toContain('private-output-device');
  });

  it('uses the latest message-clearing preference during unmount', async () => {
    let shouldClearMessages = true;
    const rendered = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider clearMessagesOnDisconnect={shouldClearMessages}>
          {children}
        </VoiceProvider>
      ),
    });
    await act(() =>
      rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    shouldClearMessages = false;
    rendered.rerender();
    expect(mocks.playerStopForContext).not.toHaveBeenCalled();
    rendered.unmount();

    await waitFor(() =>
      expect(mocks.playerStopForContext).toHaveBeenCalledOnce(),
    );
    expect(mocks.clearMessageStore).not.toHaveBeenCalled();
  });

  it('uses the latest enabled message-clearing preference during unmount', async () => {
    let shouldClearMessages = false;
    const rendered = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider clearMessagesOnDisconnect={shouldClearMessages}>
          {children}
        </VoiceProvider>
      ),
    });
    await act(() =>
      rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    shouldClearMessages = true;
    rendered.rerender();
    expect(mocks.playerStopForContext).not.toHaveBeenCalled();
    rendered.unmount();

    await waitFor(() =>
      expect(mocks.playerStopForContext).toHaveBeenCalledOnce(),
    );
    expect(mocks.clearMessageStore).toHaveBeenCalledOnce();
  });

  it('preserves the cleanup grace period for teardown created by unmount', async () => {
    vi.useFakeTimers();
    try {
      const stalledMicrophone = createDeferred<void>();
      mocks.micStop.mockReturnValueOnce(stalledMicrophone.promise);
      const rendered = renderHook(() => useVoice(), {
        wrapper: ({ children }) => (
          <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
        ),
      });
      await act(() =>
        rendered.result.current.connect({
          auth: { type: 'accessToken', value: 'test-token' },
        }),
      );

      rendered.unmount();
      await act(() => Promise.resolve());
      expect(mocks.micStop).toHaveBeenCalledOnce();

      await act(() => vi.advanceTimersByTimeAsync(14_999));
      expect(mocks.stopStream).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(mocks.stopStream).toHaveBeenCalledOnce();

      await act(async () => {
        stalledMicrophone.resolve();
        await stalledMicrophone.promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit a disconnect lifecycle when an idle provider unmounts', async () => {
    const events: VoiceDiagnosticEvent[] = [];
    const rendered = render(
      <VoiceProvider
        diagnostics={{
          level: 'debug',
          logger: false,
          onEvent: (event) => events.push(event),
        }}
      />,
    );

    rendered.unmount();
    await act(() => Promise.resolve());

    expect(mocks.micStop).not.toHaveBeenCalled();
    expect(mocks.stopStream).not.toHaveBeenCalled();
    expect(mocks.clientDisconnect).not.toHaveBeenCalled();
    expect(mocks.playerStop).not.toHaveBeenCalled();
    expect(
      events.filter((event) =>
        ['connection.disconnect_started', 'connection.disconnected'].includes(
          event.name,
        ),
      ),
    ).toHaveLength(0);
  });

  it('keeps the socket writable until the microphone flushes during disconnect', async () => {
    const finalBuffer = new Uint8Array([1, 2, 3]).buffer;
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    mocks.micStop.mockImplementationOnce(() => {
      mocks.microphoneProps?.onAudioCaptured(finalBuffer);
      return Promise.resolve();
    });

    await act(() => result.current.disconnect());

    expect(mocks.clientSendAudio).toHaveBeenCalledWith(finalBuffer);
    expect(mocks.clientDisconnect).toHaveBeenCalledOnce();
    expect(mocks.micStop).toHaveBeenCalledOnce();
    expect(mocks.stopStream).toHaveBeenCalledOnce();
    const micStopOrder = mocks.micStop.mock.invocationCallOrder[0];
    const stopStreamOrder = mocks.stopStream.mock.invocationCallOrder[0];
    if (micStopOrder === undefined || stopStreamOrder === undefined) {
      throw new Error('Expected microphone and stream cleanup calls.');
    }
    expect(micStopOrder).toBeLessThan(stopStreamOrder);
  });

  it('continues teardown and allows reconnect after microphone cleanup fails', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      }),
    );
    mocks.micStop.mockRejectedValueOnce(new Error('microphone stop failed'));

    await act(async () => {
      await expect(result.current.disconnect()).resolves.toBeUndefined();
    });

    expect(mocks.stopStream).toHaveBeenCalledOnce();
    expect(mocks.clientDisconnect).toHaveBeenCalledOnce();
    expect(mocks.playerStopForContext).toHaveBeenCalledOnce();
    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toBe(
      '[Hume Voice][connection] resource.cleanup_failed',
    );
    const cleanupEvent = consoleError.mock.calls[0]?.[1] as unknown as
      | VoiceDiagnosticEvent
      | undefined;
    const failures = cleanupEvent?.details['failures'];
    expect(
      Array.isArray(failures) &&
        failures.some(
          (failure) =>
            typeof failure === 'string' && failure.includes('microphone'),
        ),
    ).toBe(true);

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      }),
    );
    expect(mocks.getStream).toHaveBeenCalledTimes(2);
    expect(result.current.status.value).toBe('connected');
    consoleError.mockRestore();
  });

  it('acknowledges an existing error without repeating completed teardown', async () => {
    const events: VoiceDiagnosticEvent[] = [];
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider
          diagnostics={{
            level: 'debug',
            logger: false,
            onEvent: (event) => events.push(event),
          }}
        >
          {children}
        </VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    act(() => {
      mocks.playerErrorHandler?.(
        'audio playback failed',
        'audio_player_initialization_failure',
      );
    });
    await waitFor(() => expect(result.current.status.value).toBe('error'));
    await waitFor(() =>
      expect(
        events.filter((event) => event.name === 'connection.disconnected'),
      ).toHaveLength(1),
    );

    const cleanupCallCounts = {
      client: mocks.clientDisconnect.mock.calls.length,
      context: mocks.contextClose.mock.calls.length,
      mic: mocks.micStop.mock.calls.length,
      player: mocks.playerStopForContext.mock.calls.length,
    };

    await act(() => result.current.disconnect());

    expect(result.current.status).toEqual({ value: 'disconnected' });
    expect(result.current.error).toBeNull();
    expect(result.current.isError).toBe(false);
    expect(mocks.clientDisconnect).toHaveBeenCalledTimes(
      cleanupCallCounts.client,
    );
    expect(mocks.contextClose).toHaveBeenCalledTimes(cleanupCallCounts.context);
    expect(mocks.micStop).toHaveBeenCalledTimes(cleanupCallCounts.mic);
    expect(mocks.playerStopForContext).toHaveBeenCalledTimes(
      cleanupCallCounts.player,
    );
    expect(
      events.filter((event) => event.name === 'connection.disconnect_started'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.name === 'connection.disconnected'),
    ).toHaveLength(1);
    const errorEvent = events.find((event) => event.name === 'sdk.error');
    const errorClearedEvent = events.find(
      (event) => event.name === 'sdk.error_cleared',
    );
    expect(errorClearedEvent).toMatchObject({
      connectionId: errorEvent?.connectionId,
      details: {
        reason: 'consumer_disconnect',
        type: 'audio_error',
      },
    });
  });

  it('preserves an error raised while explicit disconnect is tearing down', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onError={onError}>
          {children}
        </VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    mocks.micStop.mockImplementationOnce(() => {
      mocks.microphoneProps?.onError(
        'microphone closure failed',
        'mic_closure_failure',
      );
      return Promise.resolve();
    });

    await act(() => result.current.disconnect());

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'microphone closure failed',
        reason: 'mic_closure_failure',
        type: 'mic_error',
      }),
    );
    expect(result.current.error).toMatchObject({
      reason: 'mic_closure_failure',
      type: 'mic_error',
    });
    expect(result.current.isError).toBe(true);
    expect(result.current.status).toEqual({
      value: 'error',
      reason: 'microphone closure failed',
    });
  });

  it('treats disconnect inside onError as acknowledgement after cleanup', async () => {
    let disconnectFromHandler: (() => Promise<void>) | null = null;
    let disconnecting = Promise.resolve();
    const onError = vi.fn(() => {
      if (disconnectFromHandler === null) {
        throw new Error('Expected disconnect to be available.');
      }
      disconnecting = disconnectFromHandler();
    });
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onError={onError}>
          {children}
        </VoiceProvider>
      ),
    });
    disconnectFromHandler = result.current.disconnect;
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    act(() => {
      mocks.playerErrorHandler?.(
        'audio playback failed',
        'audio_player_initialization_failure',
      );
    });
    await act(() => disconnecting);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'audio_player_initialization_failure',
        type: 'audio_error',
      }),
    );
    expect(result.current.status).toEqual({ value: 'disconnected' });
    expect(result.current.error).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('keeps error status and diagnostics stable after a late consumer close', async () => {
    const events: VoiceDiagnosticEvent[] = [];
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider
          diagnostics={{
            level: 'debug',
            logger: false,
            onEvent: (event) => events.push(event),
          }}
        >
          {children}
        </VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    act(() => {
      mocks.playerErrorHandler?.(
        'audio playback failed',
        'audio_player_initialization_failure',
      );
    });
    await waitFor(() =>
      expect(
        events.filter((event) => event.name === 'connection.disconnected'),
      ).toHaveLength(1),
    );
    const cleanupCalls = mocks.playerStopForContext.mock.calls.length;

    act(() => {
      void mocks.onCloseHandler?.({ code: 1000 } as CloseEvent, true);
    });
    await waitFor(() => expect(result.current.status.value).toBe('error'));

    expect(mocks.playerStopForContext).toHaveBeenCalledTimes(cleanupCalls);
    expect(
      events.filter((event) => event.name === 'connection.disconnect_started'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.name === 'connection.disconnected'),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.name === 'connection.disconnected')
        ?.connectionId,
    ).toBeTruthy();
    expect(result.current.error).toMatchObject({ type: 'audio_error' });
  });

  it('serializes error teardown behind an active socket-close cleanup', async () => {
    const closeMicrophone = createDeferred<void>();
    mocks.micStop.mockReturnValueOnce(closeMicrophone.promise);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    act(() => {
      mocks.playerErrorHandler?.(
        'audio playback failed',
        'audio_player_initialization_failure',
      );
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
    });

    await waitFor(() => expect(mocks.micStop).toHaveBeenCalledOnce());
    expect(mocks.clientDisconnect).not.toHaveBeenCalled();
    expect(mocks.stopStream).not.toHaveBeenCalled();
    expect(result.current.status).toEqual({
      value: 'error',
      reason: 'audio playback failed',
    });

    await act(async () => {
      closeMicrophone.resolve();
      await closeMicrophone.promise;
    });
    await waitFor(() => expect(mocks.stopStream).toHaveBeenCalledOnce());
    expect(mocks.micStop).toHaveBeenCalledOnce();
    expect(mocks.clientDisconnect).not.toHaveBeenCalled();
  });

  it('clears an existing error after retrying failed close cleanup', async () => {
    mocks.micStop.mockRejectedValueOnce(new Error('microphone stop failed'));
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    let disconnecting = Promise.resolve();
    act(() => {
      mocks.playerErrorHandler?.(
        'audio playback failed',
        'audio_player_initialization_failure',
      );
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
      disconnecting = result.current.disconnect();
    });
    await act(() => disconnecting);

    expect(mocks.micStop).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.status.value).toBe('disconnected');
  });

  it('lets an adopting teardown publish the final disconnect diagnostic', async () => {
    mocks.micStop.mockRejectedValueOnce(new Error('first stop failed'));
    const events: VoiceDiagnosticEvent[] = [];
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider
          diagnostics={{
            level: 'debug',
            logger: false,
            onEvent: (event) => events.push(event),
          }}
        >
          {children}
        </VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    let disconnecting = Promise.resolve();
    act(() => {
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
      disconnecting = result.current.disconnect();
    });
    await act(() => disconnecting);

    expect(mocks.micStop).toHaveBeenCalledTimes(2);
    const disconnectedEvents = events.filter(
      (event) => event.name === 'connection.disconnected',
    );
    expect(disconnectedEvents).toHaveLength(1);
    expect(disconnectedEvents[0]?.details).toMatchObject({
      cleanupFailureCount: 1,
      cleanupFailures: ['first stop failed'],
      reason: 'server',
    });
  });

  it('suppresses a delayed consumer close from a superseded connection', async () => {
    const secondStream = createDeferred<MediaStream>();
    const onClose = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onClose={onClose}>
          {children}
        </VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      }),
    );
    await act(() => result.current.disconnect());
    const firstConnectionClose = mocks.connectionCloseHandlers[0];
    const messageClearCount = mocks.clearMessageStore.mock.calls.length;

    mocks.getStream.mockReturnValueOnce(secondStream.promise);
    let reconnecting = Promise.resolve();
    act(() => {
      reconnecting = result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      });
    });
    await waitFor(() => expect(mocks.getStream).toHaveBeenCalledTimes(2));
    expect(result.current.status.value).toBe('connecting');

    act(() => {
      void firstConnectionClose?.({ code: 1000 } as CloseEvent, true);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.clearMessageStore).toHaveBeenCalledTimes(messageClearCount);
    expect(result.current.status.value).toBe('connecting');

    await act(async () => {
      secondStream.resolve({} as MediaStream);
      await reconnecting;
    });
    expect(mocks.connectionCloseHandlers).toHaveLength(2);
    expect(result.current.status.value).toBe('connected');
  });

  it('does not let a no-op disconnect overwrite a concurrent connect', async () => {
    const stream = createDeferred<MediaStream>();
    mocks.getStream.mockReturnValueOnce(stream.promise);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });

    let disconnecting = Promise.resolve();
    let connecting = Promise.resolve();
    act(() => {
      disconnecting = result.current.disconnect();
      connecting = result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      });
    });
    await act(() => disconnecting);

    expect(result.current.status.value).toBe('connecting');
    await act(async () => {
      stream.resolve({} as MediaStream);
      await connecting;
    });
    expect(result.current.status.value).toBe('connected');
  });

  it('cancels a connect disconnected before its deferred attempt starts', async () => {
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });

    let connecting = Promise.resolve();
    let disconnecting = Promise.resolve();
    act(() => {
      connecting = result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      });
      disconnecting = result.current.disconnect();
    });

    await act(() => Promise.all([connecting, disconnecting]));

    expect(mocks.getStream).not.toHaveBeenCalled();
    expect(mocks.clientConnect).not.toHaveBeenCalled();
    expect(result.current.status.value).toBe('disconnected');
  });

  it('retries stream cleanup after a server close cleanup fails', async () => {
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    const streamStopError = {
      message: 'microphone stream stop failed',
      name: 'AbortError',
    };
    mocks.stopStream.mockImplementationOnce(() => {
      throw streamStopError;
    });

    act(() => {
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
    });
    await waitFor(() => expect(mocks.contextClose).toHaveBeenCalledOnce());
    expect(mocks.stopStream).toHaveBeenCalledOnce();

    await act(() => result.current.disconnect());

    expect(mocks.micStop).toHaveBeenCalledTimes(2);
    expect(mocks.stopStream).toHaveBeenCalledTimes(2);
    expect(mocks.clientDisconnect).toHaveBeenCalledOnce();
    expect(result.current.status.value).toBe('disconnected');
  });

  it('releases a captured stream when the socket closes before opening', async () => {
    const socketConnection = createDeferred<'open'>();
    mocks.clientConnect.mockReturnValueOnce(socketConnection.promise);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });

    let connecting = Promise.resolve();
    act(() => {
      connecting = result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      });
    });
    await waitFor(() => expect(mocks.clientConnect).toHaveBeenCalledOnce());

    act(() => {
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
    });
    await waitFor(() => expect(mocks.stopStream).toHaveBeenCalledOnce());

    expect(mocks.micStop).not.toHaveBeenCalled();
    expect(mocks.playerStopForContext).toHaveBeenCalledOnce();
    expect(mocks.playerStop).not.toHaveBeenCalled();
    expect(result.current.status.value).toBe('disconnected');

    await act(async () => {
      socketConnection.resolve('open');
      await connecting;
    });
    expect(mocks.stopStream).toHaveBeenCalledOnce();
  });

  it('suppresses a delayed socket close after clientConnect rejects', async () => {
    mocks.clientConnect.mockRejectedValueOnce(new Error('connect failed'));
    const onClose = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onClose={onClose}>
          {children}
        </VoiceProvider>
      ),
    });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    const cleanupCalls = mocks.stopStream.mock.calls.length;

    act(() => {
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.stopStream).toHaveBeenCalledTimes(cleanupCalls);
    expect(result.current.status.value).toBe('disconnected');
  });

  it('does not start server cleanup for a close during rejected-connect cleanup', async () => {
    const contextClosed = createDeferred<void>();
    mocks.clientConnect.mockRejectedValueOnce(new Error('connect failed'));
    mocks.contextClose.mockReturnValueOnce(contextClosed.promise);
    const onClose = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onClose={onClose}>
          {children}
        </VoiceProvider>
      ),
    });

    let connecting = Promise.resolve();
    act(() => {
      connecting = result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      });
    });
    await waitFor(() => expect(mocks.contextClose).toHaveBeenCalledOnce());
    expect(mocks.stopStream).toHaveBeenCalledOnce();

    act(() => {
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.stopStream).toHaveBeenCalledOnce();
    expect(mocks.waitForDrain).not.toHaveBeenCalled();

    await act(async () => {
      contextClosed.resolve();
      await connecting;
    });
    expect(result.current.status.value).toBe('disconnected');
  });

  it('does not publish player cleanup failures from a rejected connect', async () => {
    mocks.clientConnect.mockRejectedValueOnce(new Error('connect failed'));
    mocks.playerStopForContext.mockImplementationOnce(() => {
      mocks.playerErrorHandler?.(
        'player stop failed',
        'audio_player_closure_failure',
      );
      return Promise.resolve();
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onError={onError}>
          {children}
        </VoiceProvider>
      ),
    });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    expect(onError).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('keeps a closing context owned until rejected-connect cleanup settles', async () => {
    const contextClosed = createDeferred<void>();
    mocks.clientConnect.mockRejectedValueOnce(new Error('connect failed'));
    mocks.contextClose.mockReturnValueOnce(contextClosed.promise);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });

    let connecting = Promise.resolve();
    act(() => {
      connecting = result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      });
    });
    await waitFor(() => expect(mocks.contextClose).toHaveBeenCalledOnce());

    let disconnectSettled = false;
    let disconnecting = Promise.resolve();
    act(() => {
      disconnecting = result.current.disconnect().then(() => {
        disconnectSettled = true;
      });
    });
    await act(() => Promise.resolve());
    expect(disconnectSettled).toBe(false);

    await act(async () => {
      contextClosed.resolve();
      await Promise.all([connecting, disconnecting]);
    });

    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(result.current.status.value).toBe('disconnected');
  });

  it('joins a concurrent connect during rejected-connect cleanup', async () => {
    const contextClosed = createDeferred<void>();
    mocks.clientConnect.mockRejectedValueOnce(new Error('connect failed'));
    mocks.contextClose.mockReturnValueOnce(contextClosed.promise);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });

    let firstConnect = Promise.resolve();
    act(() => {
      firstConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    await waitFor(() => expect(mocks.contextClose).toHaveBeenCalledOnce());

    let concurrentConnect = Promise.resolve();
    act(() => {
      concurrentConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    expect(concurrentConnect).toBe(firstConnect);
    expect(mocks.getStream).toHaveBeenCalledOnce();
    expect(mocks.clientConnect).toHaveBeenCalledOnce();
    expect(result.current.status.value).toBe('connecting');

    await act(async () => {
      contextClosed.resolve();
      await firstConnect;
    });
    expect(result.current.status.value).toBe('disconnected');

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'third-token' },
      }),
    );
    expect(mocks.clientConnect).toHaveBeenCalledTimes(2);
    expect(result.current.status.value).toBe('connected');
  });

  it('rejects a concurrent connect that supplies refreshed credentials', async () => {
    const stream = createDeferred<MediaStream>();
    mocks.getStream.mockReturnValueOnce(stream.promise);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });

    let firstConnect = Promise.resolve();
    act(() => {
      firstConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    await waitFor(() => expect(mocks.getStream).toHaveBeenCalledOnce());

    const conflict = await result.current
      .connect({
        auth: { type: 'accessToken', value: 'refreshed-token' },
      })
      .catch((error: unknown) => error);

    expect(isConcurrentConnectAuthError(conflict)).toBe(true);
    expect(conflict).toMatchObject({ reason: 'auth_conflict' });
    expect(mocks.clientConnect).not.toHaveBeenCalled();

    await act(async () => {
      stream.resolve({} as MediaStream);
      await firstConnect;
    });
  });

  it('starts teardown when a connect settles while still owning resources', async () => {
    const microphoneStartError = {
      message: 'microphone start failed',
      name: 'NotSupportedError',
    };
    mocks.micStart.mockImplementationOnce(() => {
      throw microphoneStartError;
    });
    const onError = vi.fn(() => {
      throw new Error('consumer error callback failed');
    });
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onError={onError}>
          {children}
        </VoiceProvider>
      ),
    });

    let firstConnect = Promise.resolve();
    act(() => {
      firstConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    await act(async () => {
      await expect(firstConnect).rejects.toThrow(
        'consumer error callback failed',
      );
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'microphone start failed',
        reason: 'mic_initialization_failure',
      }),
    );

    let retry = Promise.resolve();
    act(() => {
      retry = result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      });
    });
    await act(() => retry);

    expect(mocks.clientDisconnect).toHaveBeenCalledOnce();
    expect(mocks.clientConnect).toHaveBeenCalledTimes(2);
    expect(result.current.status.value).toBe('connected');
  });

  it('joins the active attempt when later non-auth options differ', async () => {
    const stream = createDeferred<MediaStream>();
    mocks.getStream.mockReturnValueOnce(stream.promise);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });

    let firstConnect = Promise.resolve();
    act(() => {
      firstConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
        audioConstraints: { echoCancellation: true },
      });
    });
    await waitFor(() => expect(mocks.getStream).toHaveBeenCalledOnce());

    let concurrentConnect = Promise.resolve();
    act(() => {
      concurrentConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
        audioConstraints: { echoCancellation: false },
        devices: { microphoneDeviceId: 'ignored-device' },
      });
    });

    expect(concurrentConnect).toBe(firstConnect);
    expect(mocks.getStream).toHaveBeenCalledWith({ echoCancellation: true });

    await act(async () => {
      stream.resolve({} as MediaStream);
      await Promise.all([firstConnect, concurrentConnect]);
    });
    expect(mocks.clientConnect).toHaveBeenCalledOnce();
  });

  it('joins a concurrent connect during player initialization cleanup', async () => {
    const contextClosed = createDeferred<void>();
    mocks.playerInit.mockRejectedValueOnce(new Error('player init failed'));
    mocks.contextClose.mockReturnValueOnce(contextClosed.promise);
    const onError = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onError={onError}>
          {children}
        </VoiceProvider>
      ),
    });

    let firstConnect = Promise.resolve();
    act(() => {
      firstConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    await waitFor(() => expect(mocks.contextClose).toHaveBeenCalledOnce());

    let concurrentConnect = Promise.resolve();
    act(() => {
      concurrentConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    expect(concurrentConnect).toBe(firstConnect);
    expect(mocks.getStream).toHaveBeenCalledOnce();
    expect(mocks.playerInit).toHaveBeenCalledOnce();
    expect(result.current.status.value).toBe('connecting');
    expect(onError).not.toHaveBeenCalled();

    await act(async () => {
      contextClosed.resolve();
      await firstConnect;
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'audio_player_initialization_failure',
      }),
    );
    expect(result.current.status.value).toBe('error');
  });

  it('preserves player initialization errors when attempt cleanup fails', async () => {
    mocks.playerInit.mockRejectedValueOnce({
      message: 'player init failed',
      name: 'NotSupportedError',
    });
    mocks.playerStopForContext.mockRejectedValueOnce(
      new Error('player cleanup failed'),
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onError={onError}>
          {children}
        </VoiceProvider>
      ),
    });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'player init failed',
        reason: 'audio_player_initialization_failure',
      }),
    );
    expect(result.current.status).toEqual({
      value: 'error',
      reason: 'player init failed',
    });
  });

  it('retries cleanup when a finalizer fails', async () => {
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    mocks.clearMessageStore.mockImplementationOnce(() => {
      throw new Error('message cleanup failed');
    });

    await act(() => result.current.disconnect());
    expect(mocks.micStop).toHaveBeenCalledOnce();

    await act(() => result.current.disconnect());
    expect(mocks.micStop).toHaveBeenCalledTimes(2);
    expect(mocks.stopStream).toHaveBeenCalledTimes(2);
  });

  it('does not rerender voice consumers for a no-op disconnect', async () => {
    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount += 1;
        return useVoice();
      },
      {
        wrapper: ({ children }) => (
          <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
        ),
      },
    );
    const initialRenderCount = renderCount;

    await act(() => result.current.disconnect());

    expect(renderCount).toBe(initialRenderCount);
    expect(result.current.status).toEqual({ value: 'disconnected' });
    expect(Object.isFrozen(result.current.status)).toBe(true);
  });

  it('blocks reconnect until an explicit disconnect has released old resources', async () => {
    const microphoneStopped = createDeferred<void>();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      }),
    );
    mocks.micStop.mockReturnValueOnce(microphoneStopped.promise);

    let disconnect = Promise.resolve();
    act(() => {
      disconnect = result.current.disconnect();
    });
    await waitFor(() => expect(mocks.micStop).toHaveBeenCalledOnce());

    let reconnect = Promise.resolve();
    act(() => {
      reconnect = result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      });
    });
    expect(mocks.getStream).toHaveBeenCalledOnce();

    await act(async () => {
      microphoneStopped.resolve();
      await disconnect;
      await reconnect;
    });

    expect(mocks.getStream).toHaveBeenCalledTimes(2);
    expect(result.current.status.value).toBe('connected');
  });

  it('cancels a reconnect queued behind an existing disconnect cleanup', async () => {
    const microphoneStopped = createDeferred<void>();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      }),
    );
    mocks.micStop.mockReturnValueOnce(microphoneStopped.promise);

    let firstDisconnect = Promise.resolve();
    act(() => {
      firstDisconnect = result.current.disconnect();
    });
    await waitFor(() => expect(mocks.micStop).toHaveBeenCalledOnce());

    let reconnect = Promise.resolve();
    act(() => {
      reconnect = result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      });
    });
    expect(mocks.getStream).toHaveBeenCalledOnce();

    let secondDisconnect = Promise.resolve();
    act(() => {
      secondDisconnect = result.current.disconnect();
    });

    await act(async () => {
      microphoneStopped.resolve();
      await Promise.all([firstDisconnect, reconnect, secondDisconnect]);
    });

    expect(mocks.getStream).toHaveBeenCalledOnce();
    expect(mocks.clientConnect).toHaveBeenCalledOnce();
    expect(result.current.status.value).toBe('disconnected');
  });

  it('cancels a queued reconnect after cleanup ownership clears', async () => {
    const microphoneStopped = createDeferred<void>();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      }),
    );
    mocks.micStop.mockReturnValueOnce(microphoneStopped.promise);

    let firstDisconnect = Promise.resolve();
    let reconnect = Promise.resolve();
    let secondDisconnect = Promise.resolve();
    act(() => {
      firstDisconnect = result.current.disconnect();
      reconnect = result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      });
      secondDisconnect = firstDisconnect.then(() =>
        result.current.disconnect(),
      );
    });
    await waitFor(() => expect(mocks.micStop).toHaveBeenCalledOnce());

    await act(async () => {
      microphoneStopped.resolve();
      await Promise.all([firstDisconnect, reconnect, secondDisconnect]);
    });

    expect(mocks.getStream).toHaveBeenCalledOnce();
    expect(mocks.clientConnect).toHaveBeenCalledOnce();
    expect(result.current.status.value).toBe('disconnected');
  });

  it('releases the microphone stream when AudioContext construction throws', async () => {
    const onError = vi.fn();
    const contextError = {
      message: 'context unavailable',
      name: 'NotSupportedError',
    };
    globalThis.AudioContext = vi.fn(() => {
      throw contextError;
    }) as unknown as typeof AudioContext;
    const stream = { id: 'captured-stream' } as unknown as MediaStream;
    mocks.getStream.mockResolvedValueOnce(stream);
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
    expect(mocks.stopStream).toHaveBeenCalledWith(stream);
    expect(mocks.playerInit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'context unavailable',
        reason: 'audio_player_initialization_failure',
        type: 'audio_error',
      }),
    );
  });

  it('does not publish an AudioContext error from a canceled connection', async () => {
    const onError = vi.fn();
    let cancelConnection = () => {};
    let disconnecting = Promise.resolve();
    globalThis.AudioContext = vi.fn(() => {
      cancelConnection();
      throw new DOMException('context unavailable', 'NotSupportedError');
    }) as unknown as typeof AudioContext;
    const stream = { id: 'stale-stream' } as unknown as MediaStream;
    mocks.getStream.mockResolvedValueOnce(stream);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider onError={onError}>{children}</VoiceProvider>
      ),
    });
    cancelConnection = () => {
      disconnecting = result.current.disconnect();
    };

    await act(async () => {
      await result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      });
      await disconnecting;
    });

    expect(mocks.stopStream).toHaveBeenCalledWith(stream);
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.status.value).toBe('disconnected');
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
    expect(mocks.stopStream).toHaveBeenCalledOnce();
    expect(mocks.playerStopForContext).toHaveBeenCalled();
    expect(mocks.playerStop).not.toHaveBeenCalled();
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
    expect(result.current.status.value).toBe('disconnected');

    await act(() => result.current.disconnect());
    expect(mocks.stopStream).toHaveBeenCalledOnce();
    expect(mocks.playerStopForContext).toHaveBeenCalledOnce();
    expect(mocks.contextClose).toHaveBeenCalledOnce();
  });

  it('reports and retries a rejected attempt audio-context close', async () => {
    const events: VoiceDiagnosticEvent[] = [];
    mocks.playerInit.mockResolvedValueOnce(false);
    mocks.contextClose.mockRejectedValueOnce(new Error('context close failed'));
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider
          diagnostics={{
            logger: false,
            onEvent: (event) => events.push(event),
          }}
        >
          {children}
        </VoiceProvider>
      ),
    });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    const cleanupEvent = events.find(
      (event) => event.name === 'resource.cleanup_failed',
    );
    expect(cleanupEvent?.details['resource']).toBe('connection_attempt');
    expect(cleanupEvent?.details['failures']).toEqual([
      'Shared audio context cleanup failed: context close failed',
    ]);
    await act(() => result.current.disconnect());
    expect(mocks.contextClose).toHaveBeenCalledTimes(2);
    expect(result.current.status.value).toBe('disconnected');
  });

  it('joins a connection request during silent player cleanup', async () => {
    const deferredClose = createDeferred<void>();
    mocks.playerInit.mockResolvedValueOnce(false);
    mocks.contextClose.mockReturnValueOnce(deferredClose.promise);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });

    let firstConnect = Promise.resolve();
    act(() => {
      firstConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    await waitFor(() => expect(mocks.contextClose).toHaveBeenCalledOnce());
    expect(result.current.status.value).toBe('connecting');

    let concurrentConnect = Promise.resolve();
    act(() => {
      concurrentConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    expect(concurrentConnect).toBe(firstConnect);
    expect(mocks.getStream).toHaveBeenCalledOnce();
    expect(mocks.playerInit).toHaveBeenCalledOnce();

    await act(async () => {
      deferredClose.resolve();
      await firstConnect;
    });
    expect(result.current.status.value).toBe('disconnected');
    consoleWarn.mockRestore();
  });

  it('does not let a stale player initialization cancel a newer connection', async () => {
    const firstInitialization = createDeferred<boolean>();
    const secondInitialization = createDeferred<boolean>();
    const firstStream = { id: 'first-stream' } as unknown as MediaStream;
    const secondStream = { id: 'second-stream' } as unknown as MediaStream;
    mocks.getStream
      .mockResolvedValueOnce(firstStream)
      .mockResolvedValueOnce(secondStream);
    mocks.playerInit
      .mockReturnValueOnce(firstInitialization.promise)
      .mockReturnValueOnce(secondInitialization.promise);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });

    let firstConnect = Promise.resolve();
    act(() => {
      firstConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    await waitFor(() => expect(mocks.playerInit).toHaveBeenCalledOnce());

    await act(() => result.current.disconnect());

    let secondConnect = Promise.resolve();
    act(() => {
      secondConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      });
    });
    await waitFor(() => expect(mocks.playerInit).toHaveBeenCalledTimes(2));

    await act(async () => {
      firstInitialization.resolve(false);
      await firstConnect;
    });
    expect(result.current.status.value).toBe('connecting');
    expect(mocks.stopStream).not.toHaveBeenCalledWith(secondStream);

    await act(async () => {
      secondInitialization.resolve(true);
      await secondConnect;
    });
    expect(result.current.status.value).toBe('connected');
  });

  it('awaits overlapping stale and current attempt cleanups', async () => {
    const firstInitialization = createDeferred<boolean>();
    const secondInitialization = createDeferred<boolean>();
    const stalePlayerStop = createDeferred<void>();
    const currentPlayerStop = createDeferred<void>();
    mocks.playerInit
      .mockReturnValueOnce(firstInitialization.promise)
      .mockReturnValueOnce(secondInitialization.promise);
    mocks.playerStopForContext
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(stalePlayerStop.promise)
      .mockReturnValueOnce(currentPlayerStop.promise);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
      ),
    });

    let firstConnect = Promise.resolve();
    act(() => {
      firstConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });
    });
    await waitFor(() => expect(mocks.playerInit).toHaveBeenCalledOnce());
    await act(() => result.current.disconnect());

    let secondConnect = Promise.resolve();
    act(() => {
      secondConnect = result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      });
    });
    await waitFor(() => expect(mocks.playerInit).toHaveBeenCalledTimes(2));

    act(() => {
      firstInitialization.reject(new Error('stale init failed'));
    });
    await waitFor(() =>
      expect(mocks.playerStopForContext).toHaveBeenCalledTimes(2),
    );

    act(() => {
      secondInitialization.reject(new Error('current init failed'));
    });
    await waitFor(() =>
      expect(mocks.playerStopForContext).toHaveBeenCalledTimes(3),
    );

    let disconnectSettled = false;
    let disconnecting = Promise.resolve();
    act(() => {
      disconnecting = result.current.disconnect().then(() => {
        disconnectSettled = true;
      });
    });
    await act(() => Promise.resolve());
    expect(disconnectSettled).toBe(false);

    await act(async () => {
      currentPlayerStop.resolve();
      await Promise.resolve();
    });
    expect(disconnectSettled).toBe(false);

    await act(async () => {
      stalePlayerStop.resolve();
      await Promise.all([firstConnect, secondConnect, disconnecting]);
    });
    expect(disconnectSettled).toBe(true);
    expect(result.current.status.value).toBe('disconnected');
  });

  it('switches input devices without reconnecting and preserves constraints', async () => {
    const initialStream = { id: 'initial' } as unknown as MediaStream;
    const candidateStream = { id: 'candidate' } as unknown as MediaStream;
    mocks.getStream
      .mockResolvedValueOnce(initialStream)
      .mockResolvedValueOnce(candidateStream);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
        audioConstraints: {
          echoCancellation: false,
          noiseSuppression: false,
        },
        devices: { microphoneDeviceId: 'old-mic' },
      }),
    );

    await act(() => result.current.setInputDevice('new-mic'));

    expect(mocks.getStream).toHaveBeenLastCalledWith({
      echoCancellation: false,
      noiseSuppression: false,
      deviceId: { exact: 'new-mic' },
    });
    expect(mocks.micReplace).toHaveBeenCalledWith(
      candidateStream,
      expect.any(Object),
    );
    expect(mocks.clientDisconnect).not.toHaveBeenCalled();
    expect(result.current.status.value).toBe('connected');

    await act(() => result.current.setInputDevice('new-mic'));
    expect(mocks.getStream).toHaveBeenCalledTimes(2);

    await act(() => result.current.setInputDevice(null));
    expect(mocks.getStream).toHaveBeenLastCalledWith({
      echoCancellation: false,
      noiseSuppression: false,
    });
  });

  it('uses the granted input device for live-switch no-op detection', async () => {
    const initialStream = {
      getAudioTracks: () => [
        { getSettings: () => ({ deviceId: 'granted-mic' }) },
      ],
    } as unknown as MediaStream;
    const candidateStream = {
      getAudioTracks: () => [
        { getSettings: () => ({ deviceId: 'requested-mic' }) },
      ],
    } as unknown as MediaStream;
    mocks.getStream
      .mockResolvedValueOnce(initialStream)
      .mockResolvedValueOnce(candidateStream);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
        devices: { microphoneDeviceId: 'requested-mic' },
      }),
    );
    expect(result.current.requestedInputDeviceId).toBe('requested-mic');
    expect(result.current.activeInputDeviceId).toBe('granted-mic');

    await act(() => result.current.setInputDevice('requested-mic'));
    await act(() => result.current.setInputDevice('requested-mic'));

    expect(mocks.getStream).toHaveBeenCalledTimes(2);
    expect(mocks.getStream).toHaveBeenLastCalledWith({
      deviceId: { exact: 'requested-mic' },
    });
    expect(mocks.micReplace).toHaveBeenCalledOnce();
    expect(result.current.requestedInputDeviceId).toBe('requested-mic');
    expect(result.current.activeInputDeviceId).toBe('requested-mic');
  });

  it('reacquires the default and records explicit intent without rebuilding the active mic', async () => {
    const createStream = (activeDeviceId: string) =>
      ({
        getAudioTracks: () => [
          { getSettings: () => ({ deviceId: activeDeviceId }) },
        ],
      }) as unknown as MediaStream;
    mocks.getStream
      .mockResolvedValueOnce(createStream('initial-physical-mic'))
      .mockResolvedValueOnce(createStream('first-default-mic'))
      .mockResolvedValueOnce(createStream('second-default-mic'));
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
        devices: { microphoneDeviceId: 'initial-request' },
      }),
    );

    await act(() => result.current.setInputDevice(null));
    await act(() => result.current.setInputDevice(null));
    await act(() => result.current.setInputDevice('second-default-mic'));

    expect(mocks.getStream).toHaveBeenCalledTimes(3);
    expect(mocks.getStream).toHaveBeenLastCalledWith({});
    expect(mocks.micReplace).toHaveBeenCalledTimes(2);
    expect(result.current.requestedInputDeviceId).toBe('second-default-mic');
    expect(result.current.activeInputDeviceId).toBe('second-default-mic');
  });

  it('switches output on the live player and treats the active sink as a no-op', async () => {
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
        devices: { speakerDeviceId: 'old-speaker' },
      }),
    );

    await act(() => result.current.setOutputDevice('new-speaker'));
    await act(() => result.current.setOutputDevice('new-speaker'));

    expect(mocks.playerSetOutputDevice).toHaveBeenCalledOnce();
    expect(mocks.playerSetOutputDevice).toHaveBeenCalledWith('new-speaker');
    expect(mocks.playerInit).toHaveBeenCalledOnce();
    expect(mocks.clientDisconnect).not.toHaveBeenCalled();
    expect(result.current.status.value).toBe('connected');
    expect(result.current.requestedOutputDeviceId).toBe('new-speaker');
    expect(result.current.activeOutputDeviceId).toBe('new-speaker');
  });

  it('rejects disconnected switches with typed nonfatal errors', async () => {
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });

    const inputError = await result.current
      .setInputDevice('mic')
      .catch((error: unknown) => error);
    const outputError = await result.current
      .setOutputDevice('speaker')
      .catch((error: unknown) => error);

    expect(isAudioDeviceSwitchError(inputError)).toBe(true);
    expect(inputError).toMatchObject({
      kind: 'audioinput',
      reason: 'not_connected',
    });
    expect(outputError).toMatchObject({
      kind: 'audiooutput',
      reason: 'not_connected',
    });
    expect(result.current.error).toBeNull();
    expect(result.current.status.value).toBe('disconnected');
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'blocked by document policy'],
  ] as const)(
    'maps an input %s without replacing the active microphone',
    async (name, message) => {
      const permissionError =
        name === 'NotAllowedError'
          ? new DOMException(message, name)
          : { message, name };
      const { result } = renderHook(() => useVoice(), {
        wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
      });
      await act(() =>
        result.current.connect({
          auth: { type: 'accessToken', value: 'test-token' },
        }),
      );
      mocks.getStream.mockRejectedValueOnce(permissionError);

      const switchError = await result.current
        .setInputDevice('blocked')
        .catch((error: unknown) => error);

      expect(switchError).toMatchObject({
        cause: permissionError,
        kind: 'audioinput',
        message: `Permission to switch the audio input was denied. ${message}`,
        reason: 'permission_denied',
      });
      expect(mocks.micReplace).not.toHaveBeenCalled();
      expect(result.current.error).toBeNull();
      expect(result.current.status.value).toBe('connected');
    },
  );

  it.each(['NotAllowedError', 'SecurityError'])(
    'maps a name-only %s during connect to microphone permission denial',
    async (name) => {
      const permissionError = { message: 'denied', name };
      mocks.getStream.mockRejectedValueOnce(permissionError);
      const { result } = renderHook(() => useVoice(), {
        wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
      });

      await act(() =>
        result.current.connect({
          auth: { type: 'accessToken', value: 'test-token' },
        }),
      );

      expect(result.current.error).toMatchObject({
        message: 'denied',
        reason: 'mic_permission_denied',
        type: 'mic_error',
      });
    },
  );

  it('maps unsupported output switching without disrupting playback', async () => {
    const unsupportedError = new DOMException(
      'unavailable',
      'NotSupportedError',
    );
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    mocks.playerSetOutputDevice.mockRejectedValueOnce(unsupportedError);

    const switchError = await result.current
      .setOutputDevice('unsupported-speaker')
      .catch((error: unknown) => error);

    expect(switchError).toMatchObject({
      cause: unsupportedError,
      kind: 'audiooutput',
      reason: 'unsupported',
    });
    expect(mocks.playerStop).not.toHaveBeenCalled();
    expect(mocks.playerInit).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
    expect(result.current.status.value).toBe('connected');
  });

  it('maps an aborted output switch to an interrupted device change', async () => {
    const abortError = new DOMException('player changed', 'AbortError');
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    mocks.playerSetOutputDevice.mockRejectedValueOnce(abortError);

    const switchError = await result.current
      .setOutputDevice('new-speaker')
      .catch((error: unknown) => error);

    expect(switchError).toMatchObject({
      cause: abortError,
      kind: 'audiooutput',
      reason: 'interrupted',
    });
    expect(result.current.status.value).toBe('connected');
  });

  it('interrupts an input acquisition that outlives disconnect', async () => {
    const candidateStream = { id: 'late-candidate' } as unknown as MediaStream;
    const candidateAcquisition = createDeferred<MediaStream>();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    mocks.getStream.mockReturnValueOnce(candidateAcquisition.promise);

    let switching = Promise.resolve();
    act(() => {
      switching = result.current.setInputDevice('late-mic');
    });
    await act(() => Promise.resolve());
    await act(() => result.current.disconnect());
    await act(() => {
      candidateAcquisition.resolve(candidateStream);
      return Promise.resolve();
    });

    const switchError = await switching.catch((error: unknown) => error);
    expect(switchError).toMatchObject({
      kind: 'audioinput',
      reason: 'interrupted',
    });
    expect(mocks.stopStream).toHaveBeenCalledWith(candidateStream);
    expect(mocks.micReplace).not.toHaveBeenCalled();
  });

  it('delegates microphone stop while a replacement is still pending', async () => {
    const replacement = createDeferred<void>();
    const candidateStream = { id: 'candidate' } as unknown as MediaStream;
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => <VoiceProvider>{children}</VoiceProvider>,
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    mocks.getStream.mockResolvedValueOnce(candidateStream);
    mocks.micReplace.mockReturnValueOnce(replacement.promise);

    const switching = result.current.setInputDevice('next-mic');
    const switchOutcome = switching.catch((error: unknown) => error);
    await waitFor(() => expect(mocks.micReplace).toHaveBeenCalledOnce());

    let disconnecting = Promise.resolve();
    act(() => {
      disconnecting = result.current.disconnect();
    });
    await act(() => disconnecting);
    expect(mocks.micStop).toHaveBeenCalledOnce();
    expect(mocks.clientDisconnect).toHaveBeenCalledOnce();
    expect(result.current.requestedInputDeviceId).toBeNull();
    expect(result.current.activeInputDeviceId).toBeNull();
    expect(result.current.requestedOutputDeviceId).toBeNull();
    expect(result.current.activeOutputDeviceId).toBeNull();

    await act(async () => {
      replacement.resolve();
      await replacement.promise;
    });

    await expect(switchOutcome).resolves.toMatchObject({
      kind: 'audioinput',
      reason: 'interrupted',
    });
  });

  it('publishes socket closure immediately and serializes later teardown', async () => {
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

    let disconnecting = Promise.resolve();
    act(() => {
      disconnecting = result.current.disconnect();
    });
    expect(mocks.playerStopForContext).not.toHaveBeenCalled();

    let reconnect = Promise.resolve();
    act(() => {
      reconnect = result.current.connect({
        auth: { type: 'accessToken', value: 'next-token' },
      });
    });
    expect(mocks.playerInit).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferredDrain.resolve(true);
      await disconnecting;
      await reconnect;
    });

    await waitFor(() => expect(mocks.playerInit).toHaveBeenCalledTimes(2));
    expect(mocks.playerStopForContext).toHaveBeenCalledTimes(1);
    expect(mocks.playerStop).not.toHaveBeenCalled();
    expect(result.current.status.value).toBe('connected');
  });

  it('cancels a reconnect waiting on close cleanup before microphone access', async () => {
    const deferredDrain = createDeferred<boolean>();
    mocks.waitForDrain.mockReturnValueOnce(deferredDrain.promise);
    let reconnecting = Promise.resolve();
    const onClose = vi.fn();
    const rendered = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onClose={onClose}>
          {children}
        </VoiceProvider>
      ),
    });
    onClose.mockImplementation(() => {
      reconnecting = rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'next-token' },
      });
    });

    await act(() =>
      rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );
    expect(mocks.getStream).toHaveBeenCalledOnce();

    act(() => {
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
    });
    expect(onClose).toHaveBeenCalledOnce();

    let disconnecting = Promise.resolve();
    act(() => {
      disconnecting = rendered.result.current.disconnect();
    });

    await act(async () => {
      deferredDrain.resolve(true);
      await disconnecting;
      await reconnecting;
    });

    expect(mocks.getStream).toHaveBeenCalledOnce();
    expect(mocks.clientConnect).toHaveBeenCalledOnce();
    expect(rendered.result.current.status.value).toBe('disconnected');
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
    const stopsBeforeClose = mocks.playerStopForContext.mock.calls.length;

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

    expect(mocks.playerStopForContext).toHaveBeenCalledTimes(
      stopsBeforeClose + 1,
    );
    expect(mocks.playerStop).not.toHaveBeenCalled();
    expect(mocks.playerInit).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.status.value).toBe('connected');
  });

  it('allows onClose to reconnect when the socket closes before opening', async () => {
    const firstSocketConnection = createDeferred<'open'>();
    const deferredDrain = createDeferred<boolean>();
    mocks.clientConnect
      .mockReturnValueOnce(firstSocketConnection.promise)
      .mockResolvedValueOnce('open');
    mocks.waitForDrain.mockReturnValueOnce(deferredDrain.promise);
    let reconnect = Promise.resolve();
    const onClose = vi.fn();
    const rendered = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider diagnostics={false} onClose={onClose}>
          {children}
        </VoiceProvider>
      ),
    });
    onClose.mockImplementation(() => {
      reconnect = rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'next-token' },
      });
    });

    let firstConnect = Promise.resolve();
    act(() => {
      firstConnect = rendered.result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      });
    });
    await waitFor(() => expect(mocks.clientConnect).toHaveBeenCalledOnce());

    act(() => {
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
      firstSocketConnection.reject(new Error('socket closed before opening'));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.clientConnect).toHaveBeenCalledOnce();

    await act(async () => {
      deferredDrain.resolve(true);
      await Promise.all([firstConnect, reconnect]);
    });

    expect(mocks.clientConnect).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.status.value).toBe('connected');
  });

  it('reports a throwing onClose callback once without propagating it', async () => {
    const events: VoiceDiagnosticEvent[] = [];
    const onClose = vi.fn(() => {
      throw new Error('consumer close failed');
    });
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider
          diagnostics={{
            level: 'debug',
            logger: false,
            onEvent: (event) => events.push(event),
          }}
          onClose={onClose}
        >
          {children}
        </VoiceProvider>
      ),
    });
    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    act(() => {
      expect(() => {
        void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
      }).not.toThrow();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(
      events.filter((event) => event.name === 'consumer.callback_failed'),
    ).toHaveLength(1);
  });

  it('registers connect ownership before diagnostics can reenter', async () => {
    let connectAgain = () => Promise.resolve();
    let reentrantResult = Promise.resolve<unknown>(undefined);
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider
          diagnostics={{
            level: 'debug',
            logger: false,
            onEvent: (event) => {
              if (event.name === 'connection.attempt_started') {
                reentrantResult = connectAgain().catch(
                  (error: unknown) => error,
                );
              }
            },
          }}
        >
          {children}
        </VoiceProvider>
      ),
    });
    connectAgain = () =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      }),
    );

    await expect(reentrantResult).resolves.toBeUndefined();
    expect(mocks.getStream).toHaveBeenCalledOnce();
    expect(mocks.clientConnect).toHaveBeenCalledOnce();
  });

  it('allows disconnect diagnostics to reconnect during synchronous delivery', async () => {
    let connectAgain = () => Promise.resolve();
    let reconnecting = Promise.resolve();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider
          diagnostics={{
            level: 'debug',
            logger: false,
            onEvent: (event) => {
              if (event.name === 'connection.disconnect_started') {
                reconnecting = connectAgain();
              }
            },
          }}
        >
          {children}
        </VoiceProvider>
      ),
    });
    connectAgain = () =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'next-token' },
      });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'first-token' },
      }),
    );

    act(() => {
      void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
    });
    await act(() => reconnecting);

    expect(mocks.clientConnect).toHaveBeenCalledTimes(2);
    expect(result.current.status.value).toBe('connected');
  });

  it('does not join a stalled player stop from the server backstop', async () => {
    vi.useFakeTimers();
    try {
      const playerStopped = createDeferred<void>();
      mocks.playerStopForContext.mockReturnValue(playerStopped.promise);
      const { result } = renderHook(() => useVoice(), {
        wrapper: ({ children }) => (
          <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
        ),
      });
      await act(() =>
        result.current.connect({
          auth: { type: 'accessToken', value: 'test-token' },
        }),
      );

      act(() => {
        void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
      });
      await act(() => Promise.resolve());
      expect(mocks.playerStopForContext).toHaveBeenCalledOnce();
      await act(() => vi.advanceTimersByTimeAsync(15_000));

      expect(mocks.playerStopForContext).toHaveBeenCalledTimes(2);
      expect(mocks.contextClose).toHaveBeenCalledOnce();

      await act(async () => {
        playerStopped.resolve();
        await playerStopped.promise;
        await Promise.resolve();
      });
      expect(mocks.contextClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not join a stalled player stop from the disconnect backstop', async () => {
    vi.useFakeTimers();
    try {
      const playerStopped = createDeferred<void>();
      const events: VoiceDiagnosticEvent[] = [];
      mocks.playerStopForContext.mockReturnValue(playerStopped.promise);
      const { result } = renderHook(() => useVoice(), {
        wrapper: ({ children }) => (
          <VoiceProvider
            diagnostics={{
              level: 'debug',
              logger: false,
              onEvent: (event) => events.push(event),
            }}
          >
            {children}
          </VoiceProvider>
        ),
      });
      await act(() =>
        result.current.connect({
          auth: { type: 'accessToken', value: 'test-token' },
        }),
      );

      let disconnecting = Promise.resolve();
      act(() => {
        disconnecting = result.current.disconnect();
      });
      await act(() => Promise.resolve());
      expect(mocks.playerStopForContext).toHaveBeenCalledOnce();
      await act(() => vi.advanceTimersByTimeAsync(15_000));

      expect(mocks.playerStopForContext).toHaveBeenCalledTimes(2);
      expect(mocks.contextClose).toHaveBeenCalledOnce();
      await act(() => disconnecting);
      expect(
        events.some((event) => {
          const failures = event.details['failures'];
          return (
            event.name === 'resource.cleanup_failed' &&
            Array.isArray(failures) &&
            failures.some(
              (failure) =>
                typeof failure === 'string' &&
                failure.includes(
                  'cleanup did not settle before forced context closure',
                ),
            )
          );
        }),
      ).toBe(true);

      await act(async () => {
        playerStopped.resolve();
        await playerStopped.promise;
      });
      expect(mocks.contextClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminalizes a stalled disconnect without letting late cleanup clobber reconnect', async () => {
    vi.useFakeTimers();
    try {
      const stalledMicrophone = createDeferred<void>();
      mocks.micStop.mockReturnValueOnce(stalledMicrophone.promise);
      const events: VoiceDiagnosticEvent[] = [];
      const { result } = renderHook(() => useVoice(), {
        wrapper: ({ children }) => (
          <VoiceProvider
            diagnostics={{
              level: 'debug',
              logger: false,
              onEvent: (event) => events.push(event),
            }}
          >
            {children}
          </VoiceProvider>
        ),
      });
      await act(() =>
        result.current.connect({
          auth: { type: 'accessToken', value: 'first-token' },
        }),
      );

      let firstDisconnect = Promise.resolve();
      let joinedDisconnect = Promise.resolve();
      act(() => {
        firstDisconnect = result.current.disconnect();
        joinedDisconnect = result.current.disconnect();
      });
      await act(() => Promise.resolve());
      expect(mocks.micStop).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await Promise.all([firstDisconnect, joinedDisconnect]);
      });

      expect(mocks.stopStream).toHaveBeenCalledOnce();
      expect(mocks.clientDisconnect).toHaveBeenCalledOnce();
      expect(mocks.contextClose).toHaveBeenCalledOnce();
      expect(result.current.status.value).toBe('disconnected');
      expect(
        events.filter(
          (event) => event.name === 'connection.disconnect_started',
        ),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.name === 'connection.disconnected'),
      ).toHaveLength(1);

      await act(() =>
        result.current.connect({
          auth: { type: 'accessToken', value: 'second-token' },
        }),
      );
      await act(async () => {
        stalledMicrophone.resolve();
        await stalledMicrophone.promise;
      });

      expect(mocks.contextClose).toHaveBeenCalledOnce();
      expect(result.current.status.value).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a never-settling cleanup block later connections forever', async () => {
    vi.useFakeTimers();
    try {
      const stalledDrain = createDeferred<boolean>();
      mocks.waitForDrain.mockReturnValueOnce(stalledDrain.promise);
      const { result } = renderHook(() => useVoice(), {
        wrapper: ({ children }) => (
          <VoiceProvider diagnostics={false}>{children}</VoiceProvider>
        ),
      });
      await act(() =>
        result.current.connect({
          auth: { type: 'accessToken', value: 'first-token' },
        }),
      );

      act(() => {
        void mocks.onCloseHandler?.({ code: 1006 } as CloseEvent, false);
      });
      let reconnect = Promise.resolve();
      act(() => {
        reconnect = result.current.connect({
          auth: { type: 'accessToken', value: 'second-token' },
        });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await reconnect;
      });

      expect(mocks.clientConnect).toHaveBeenCalledTimes(2);
      expect(mocks.stopStream).toHaveBeenCalledOnce();
      expect(mocks.contextClose).toHaveBeenCalledOnce();
      expect(result.current.status.value).toBe('connected');

      await act(async () => {
        stalledDrain.resolve(true);
        await stalledDrain.promise;
      });
      expect(mocks.contextClose).toHaveBeenCalledOnce();
      expect(result.current.status.value).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });
});
