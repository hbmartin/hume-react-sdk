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
  clientSendAudio: vi.fn(),
  contextClose: vi.fn(),
  getStream: vi.fn(),
  micStart: vi.fn(),
  micReplace: vi.fn(),
  micStop: vi.fn(),
  microphoneProps: null as null | {
    onAudioCaptured: (buffer: ArrayBuffer) => void;
    onStartRecording?: () => void;
    onStopRecording?: () => void;
  },
  onCloseHandler: null as
    | null
    | ((event: CloseEvent, consumerInitiated: boolean) => void | Promise<void>),
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
      mocks.onCloseHandler = props.onClose ?? null;
      return {
        connect: mocks.clientConnect,
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

import { isAudioDeviceSwitchError } from './errors';
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
      'Failed to fully disconnect voice resources.',
    );
    const loggedFailure: unknown = consoleError.mock.calls[0]?.[1];
    if (!(loggedFailure instanceof Error)) {
      throw new Error('Expected teardown to log an Error.');
    }
    expect(loggedFailure.message).toContain('microphone');

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      }),
    );
    expect(mocks.getStream).toHaveBeenCalledTimes(2);
    expect(result.current.status.value).toBe('connected');
    consoleError.mockRestore();
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

  it('releases the microphone stream when AudioContext construction throws', async () => {
    const onError = vi.fn();
    globalThis.AudioContext = vi.fn(() => {
      throw new DOMException('context unavailable', 'NotSupportedError');
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
    expect(result.current.status.value).toBe('disconnected');
  });

  it('blocks a new connection until silent player cleanup completes', async () => {
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

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'second-token' },
      }),
    );
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

    await act(() => result.current.setInputDevice('requested-mic'));
    await act(() => result.current.setInputDevice('requested-mic'));

    expect(mocks.getStream).toHaveBeenCalledTimes(2);
    expect(mocks.getStream).toHaveBeenLastCalledWith({
      deviceId: { exact: 'requested-mic' },
    });
    expect(mocks.micReplace).toHaveBeenCalledOnce();
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

  it('maps input permission failures without replacing the active microphone', async () => {
    const permissionError = new DOMException('denied', 'NotAllowedError');
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
      reason: 'permission_denied',
    });
    expect(mocks.micReplace).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.status.value).toBe('connected');
  });

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

  it('waits for an in-progress microphone promotion before disconnecting', async () => {
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
    await act(() => Promise.resolve());
    expect(mocks.micStop).not.toHaveBeenCalled();

    await act(async () => {
      replacement.resolve();
      await disconnecting;
    });

    await expect(switchOutcome).resolves.toMatchObject({
      kind: 'audioinput',
      reason: 'interrupted',
    });
    expect(mocks.micStop).toHaveBeenCalledOnce();
    expect(mocks.clientDisconnect).toHaveBeenCalledOnce();
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
    expect(mocks.playerStopForContext).toHaveBeenCalledTimes(1);

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
    expect(mocks.playerStopForContext).toHaveBeenCalledTimes(1);
    expect(mocks.playerStop).not.toHaveBeenCalled();
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
