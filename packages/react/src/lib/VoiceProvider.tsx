import { type Hume } from 'hume';
import type { FC, PropsWithChildren } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { getAuthStrategyError } from './auth';
import type { ConnectionMessage } from './connection-message';
import {
  createVoiceDiagnosticsReporter,
  type VoiceDiagnosticsOptions,
  type VoiceDiagnosticsReporter,
} from './diagnostics';
import {
  AudioDeviceSwitchError,
  type AudioDeviceSwitchErrorReason,
  isAudioDeviceSwitchError,
} from './errors';
import type { FftSnapshot, FftStore } from './fftStore';
import { useFftSubscription } from './fftStore';
import { noop } from './noop';
import type { CallDurationStore } from './useCallDuration';
import { useCallDuration } from './useCallDuration';
import { useLatestRef } from './useLatestRef';
import { useMessages } from './useMessages';
import { useMicrophone } from './useMicrophone';
import { useMicrophoneStream } from './useMicrophoneStream';
import { useSoundPlayer } from './useSoundPlayer';
import { useToolStatus } from './useToolStatus';
import type { ToolCallErrorSource, ToolCallHandler } from './useVoiceClient';
import {
  type SessionSettingsUpdate,
  type SocketCloseEvent,
  useVoiceClient,
  VoiceReadyState,
} from './useVoiceClient';
import type {
  AudioConstraints,
  AudioDeviceKind,
  ConnectOptions,
} from '../models/connect-options';
import type {
  AssistantProsodyMessage,
  AssistantTranscriptMessage,
  AudioOutputMessage,
  ChatMetadataMessage,
  JSONMessage,
  UserInterruptionMessage,
  UserTranscriptMessage,
} from '../models/messages';
import {
  type AudioContextCloseResult,
  closeAudioContextWithTimeout,
} from '../utils/closeAudioContextWithTimeout';

export type SocketErrorReason =
  | 'socket_connection_failure'
  | 'failed_to_send_audio'
  | 'failed_to_send_message'
  | 'received_assistant_error_message'
  | 'received_tool_call_error';

export type AudioPlayerErrorReason =
  | 'audio_player_initialization_failure'
  | 'audio_worklet_load_failure'
  | 'audio_player_not_initialized'
  | 'malformed_audio'
  | 'audio_player_closure_failure';

export type MicErrorReason =
  | 'mic_permission_denied'
  | 'mic_initialization_failure'
  | 'mic_closure_failure'
  | 'mime_types_not_supported';

type VoiceError =
  | {
      type: 'socket_error';
      reason: SocketErrorReason;
      message: string;
      error?: Error;
    }
  | {
      type: 'audio_error';
      reason: AudioPlayerErrorReason;
      message: string;
      error?: Error;
    }
  | {
      type: 'mic_error';
      reason: MicErrorReason;
      message: string;
      error?: Error;
    };

const getVoiceErrorCategory = (error: VoiceError) => {
  if (error.type === 'socket_error') {
    return 'socket' as const;
  }
  if (error.type === 'mic_error') {
    return 'microphone' as const;
  }
  return 'audio_player' as const;
};

type VoiceStatus =
  | Readonly<{
      value: 'disconnected' | 'connecting' | 'connected';
      reason?: never;
    }>
  | Readonly<{
      value: 'error';
      reason: string;
    }>;

const DISCONNECTED_VOICE_STATUS: VoiceStatus = Object.freeze({
  value: 'disconnected',
});

type VoiceErrorSnapshot = Readonly<{
  error: VoiceError | null;
  version: number;
  connectionId?: string;
  chatId?: string;
}>;

const INITIAL_VOICE_ERROR_SNAPSHOT: VoiceErrorSnapshot = Object.freeze({
  error: null,
  version: 0,
});

type ResourceStatus =
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected';

const getDeviceSwitchReason = (
  error: unknown,
): AudioDeviceSwitchErrorReason => {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? error.name
      : null;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'permission_denied';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'device_not_found';
  }
  if (name === 'NotSupportedError') {
    return 'unsupported';
  }
  if (name === 'AbortError') {
    return 'interrupted';
  }
  return 'switch_failed';
};

const createDeviceSwitchError = (
  kind: AudioDeviceKind,
  reason: AudioDeviceSwitchErrorReason,
  cause?: unknown,
) => {
  const device = kind === 'audioinput' ? 'input' : 'output';
  const detail = cause instanceof Error ? ` ${cause.message}` : '';
  const messages: Record<AudioDeviceSwitchErrorReason, string> = {
    not_connected: `Cannot switch the audio ${device} without an active voice connection.`,
    unsupported: `This browser does not support switching the audio ${device}.${detail}`,
    permission_denied: `Permission to switch the audio ${device} was denied.${detail}`,
    device_not_found: `The requested audio ${device} device was not found.${detail}`,
    switch_failed: `Failed to switch the audio ${device}.${detail}`,
    interrupted: `The audio ${device} switch was interrupted by a connection lifecycle change.`,
  };
  return new AudioDeviceSwitchError(kind, reason, messages[reason], cause);
};

type CurrentRef<T> = { current: T };

const getMonotonicTime = () => globalThis.performance?.now() ?? Date.now();

const invokeConsumerCallback = <Result,>(
  diagnostics: VoiceDiagnosticsReporter,
  callback: string,
  invoke: () => Result,
): Result => {
  try {
    return invoke();
  } catch (error) {
    diagnostics.emit({
      level: 'warn',
      category: 'consumer',
      name: 'consumer.callback_failed',
      details: { callback, error },
    });
    throw error;
  }
};

const getGrantedInputDeviceId = (
  stream: MediaStream,
  requestedDeviceId: string | null,
): string | null => {
  try {
    return (
      stream.getAudioTracks()[0]?.getSettings().deviceId || requestedDeviceId
    );
  } catch {
    return requestedDeviceId;
  }
};

const enqueueDeviceSwitch = <T,>({
  kind,
  queueRef,
  lifecycleGenerationRef,
  isConnected,
  isAlreadyActive,
  onAlreadyActive,
  perform,
  commit,
}: {
  kind: AudioDeviceKind;
  queueRef: CurrentRef<Promise<void>>;
  lifecycleGenerationRef: CurrentRef<number>;
  isConnected: () => boolean;
  isAlreadyActive: () => boolean;
  onAlreadyActive?: () => void;
  perform: (isCurrent: () => boolean) => Promise<T>;
  commit: (result: T) => void;
}): Promise<void> => {
  if (!isConnected()) {
    return Promise.reject(createDeviceSwitchError(kind, 'not_connected'));
  }

  const generation = lifecycleGenerationRef.current;
  const isCurrent = () =>
    generation === lifecycleGenerationRef.current && isConnected();
  const switchDevice = async () => {
    if (!isCurrent()) {
      throw createDeviceSwitchError(kind, 'interrupted');
    }
    if (isAlreadyActive()) {
      onAlreadyActive?.();
      return;
    }

    let result: T;
    try {
      result = await perform(isCurrent);
    } catch (cause) {
      if (!isCurrent()) {
        throw createDeviceSwitchError(kind, 'interrupted', cause);
      }
      if (isAudioDeviceSwitchError(cause)) {
        throw cause;
      }
      throw createDeviceSwitchError(kind, getDeviceSwitchReason(cause), cause);
    }

    if (!isCurrent()) {
      throw createDeviceSwitchError(kind, 'interrupted');
    }
    commit(result);
  };

  const switchPromise = queueRef.current.then(switchDevice, switchDevice);
  queueRef.current = switchPromise.catch(() => undefined);
  return switchPromise;
};

export type VoiceAudioDeviceState = {
  requestedInputDeviceId: string | null;
  activeInputDeviceId: string | null;
  requestedOutputDeviceId: string | null;
  activeOutputDeviceId: string | null;
};

const DISCONNECTED_AUDIO_DEVICE_STATE: VoiceAudioDeviceState = {
  requestedInputDeviceId: null,
  activeInputDeviceId: null,
  requestedOutputDeviceId: null,
  activeOutputDeviceId: null,
};

export type VoiceContextType = VoiceAudioDeviceState & {
  connect: (options: ConnectOptions) => Promise<void>;
  disconnect: () => Promise<void>;
  setInputDevice: (deviceId: string | null) => Promise<void>;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  isMuted: boolean;
  isAudioMuted: boolean;
  isPlaying: boolean;
  messages: (JSONMessage | ConnectionMessage)[];
  lastVoiceMessage: AssistantTranscriptMessage | null;
  lastUserMessage: UserTranscriptMessage | null;
  lastAssistantProsodyMessage: AssistantProsodyMessage | null;
  clearMessages: () => void;
  mute: () => void;
  unmute: () => void;
  muteAudio: () => void;
  unmuteAudio: () => void;
  readyState: VoiceReadyState;
  sendUserInput: (text: string) => void;
  sendAssistantInput: (text: string) => void;
  sendSessionSettings: (sessionSettings: SessionSettingsUpdate) => void;
  sendToolMessage: (
    type:
      | Hume.empathicVoice.ToolResponseMessage
      | Hume.empathicVoice.ToolErrorMessage,
  ) => void;
  pauseAssistant: () => void;
  resumeAssistant: () => void;
  status: VoiceStatus;
  error: VoiceError | null;
  isAudioError: boolean;
  isError: boolean;
  isMicrophoneError: boolean;
  isSocketError: boolean;
  toolStatusStore: ReturnType<typeof useToolStatus>['store'];
  chatMetadata: ChatMetadataMessage | null;
  playerQueueLength: number;
  isPaused: boolean;
  volume: number;
  setVolume: (level: number) => void;
};

const VoiceContext = createContext<VoiceContextType | null>(null);

export type VoiceProviderProps = PropsWithChildren<{
  onMessage?: (message: JSONMessage) => void;
  onError?: (err: VoiceError) => void;
  onOpen?: () => void;
  onClose?: Hume.empathicVoice.chat.ChatSocket.EventHandlers['close'];
  onToolCall?: ToolCallHandler;
  onAudioReceived?: (audioOutputMessage: AudioOutputMessage) => void;
  onAudioStart?: (clipId: string) => void;
  onAudioEnd?: (clipId: string) => void;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onInterruption?: (message: UserInterruptionMessage) => void;
  /**
   * @default true
   * @description Clear messages when the voice is disconnected.
   */
  clearMessagesOnDisconnect?: boolean;
  /**
   * @default 100
   * @description The maximum number of messages to keep in memory.
   */
  messageHistoryLimit?: number;
  enableAudioWorklet?: boolean;
  /**
   * Configure structured SDK diagnostics. By default, sanitized warnings and
   * errors are written to the browser console. Pass `false` to disable them.
   */
  diagnostics?: false | VoiceDiagnosticsOptions;
}>;

export const useVoice = () => {
  const ctx = useContext(VoiceContext);
  if (!ctx) {
    throw new Error('useVoice must be used within an VoiceProvider');
  }
  return ctx;
};

const StoresContext = createContext<{
  playerFftStore: FftStore;
  micFftStore: FftStore;
  callDurationStore: CallDurationStore;
} | null>(null);

export const usePlayerFft = (): FftSnapshot => {
  const ctx = useContext(StoresContext);
  if (!ctx) {
    throw new Error('usePlayerFft must be used within a VoiceProvider');
  }
  return useFftSubscription(ctx.playerFftStore);
};

export const useMicFft = (): FftSnapshot => {
  const ctx = useContext(StoresContext);
  if (!ctx) {
    throw new Error('useMicFft must be used within a VoiceProvider');
  }
  return useFftSubscription(ctx.micFftStore);
};

export const useCallDurationTimestamp = (): string | null => {
  const ctx = useContext(StoresContext);
  if (!ctx) {
    throw new Error(
      'useCallDurationTimestamp must be used within a VoiceProvider',
    );
  }
  return useSyncExternalStore(
    ctx.callDurationStore.subscribe,
    ctx.callDurationStore.getSnapshot,
    ctx.callDurationStore.getServerSnapshot,
  );
};

export const VoiceProvider: FC<VoiceProviderProps> = ({
  children,
  clearMessagesOnDisconnect = true,
  messageHistoryLimit = 100,
  enableAudioWorklet = true,
  diagnostics: diagnosticsConfiguration,
  ...props
}) => {
  const {
    store: callDurationStore,
    start: startTimer,
    stop: stopTimer,
  } = useCallDuration();

  const [status, setStatus] = useState<VoiceStatus>(DISCONNECTED_VOICE_STATUS);
  const setDisconnectedStatus = useCallback(() => {
    setStatus((current) =>
      current.value === 'disconnected' ? current : DISCONNECTED_VOICE_STATUS,
    );
  }, []);
  const setErrorStatus = useCallback((nextError: VoiceError) => {
    setStatus((current) =>
      current.value === 'error' && current.reason === nextError.message
        ? current
        : { value: 'error', reason: nextError.message },
    );
  }, []);
  const isConnectingRef = useRef(false);
  const isFlushingMicrophoneRef = useRef(false);
  const resourceCleanupCompletedRef = useRef(true);
  const lifecycleGenerationRef = useRef(0);
  const currentConnectionGenerationRef = useRef<number | null>(null);
  const pendingCloseCleanupRef = useRef<Promise<void> | null>(null);
  const pendingDisconnectCleanupRef = useRef<Promise<void> | null>(null);
  const inputSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const outputSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeAudioConstraintsRef = useRef<AudioConstraints | null>(null);
  const activeInputDeviceIdRef = useRef<string | null>(null);
  const activeOutputDeviceIdRef = useRef<string | null>(null);
  const [audioDeviceState, setAudioDeviceState] =
    useState<VoiceAudioDeviceState>(DISCONNECTED_AUDIO_DEVICE_STATE);
  const sharedAudioContextRef = useRef<AudioContext | null>(null);
  const sharedAudioContextClosePromisesRef = useRef(
    new WeakMap<AudioContext, Promise<AudioContextCloseResult>>(),
  );
  const isCurrentLifecycleGeneration = useCallback(
    (generation: number) => lifecycleGenerationRef.current === generation,
    [],
  );

  const publishInputDeviceState = useCallback(
    (requestedDeviceId: string | null, activeDeviceId: string | null) => {
      activeInputDeviceIdRef.current = activeDeviceId;
      setAudioDeviceState((current) =>
        current.requestedInputDeviceId === requestedDeviceId &&
        current.activeInputDeviceId === activeDeviceId
          ? current
          : {
              ...current,
              requestedInputDeviceId: requestedDeviceId,
              activeInputDeviceId: activeDeviceId,
            },
      );
    },
    [],
  );

  const publishOutputDeviceState = useCallback(
    (requestedDeviceId: string | null, activeDeviceId: string | null) => {
      activeOutputDeviceIdRef.current = activeDeviceId;
      setAudioDeviceState((current) =>
        current.requestedOutputDeviceId === requestedDeviceId &&
        current.activeOutputDeviceId === activeDeviceId
          ? current
          : {
              ...current,
              requestedOutputDeviceId: requestedDeviceId,
              activeOutputDeviceId: activeDeviceId,
            },
      );
    },
    [],
  );

  const resetAudioDeviceState = useCallback(() => {
    activeInputDeviceIdRef.current = null;
    activeOutputDeviceIdRef.current = null;
    setAudioDeviceState(DISCONNECTED_AUDIO_DEVICE_STATE);
  }, []);

  const closeSharedAudioContext = useCallback(
    async (context = sharedAudioContextRef.current) => {
      if (!context) {
        return null;
      }
      if (sharedAudioContextRef.current === context) {
        sharedAudioContextRef.current = null;
      }
      let closePromise =
        sharedAudioContextClosePromisesRef.current.get(context);
      if (!closePromise) {
        closePromise = closeAudioContextWithTimeout(context);
        sharedAudioContextClosePromisesRef.current.set(context, closePromise);
      }
      return closePromise;
    },
    [],
  );

  // stores information about whether certain resources are being disconnected
  const resourceStatusRef = useRef<{
    mic: ResourceStatus;
    audioPlayer: ResourceStatus;
    socket: ResourceStatus;
  }>({
    mic: 'disconnected',
    audioPlayer: 'disconnected',
    socket: 'disconnected',
  });

  const [isPaused, setIsPaused] = useState(false);

  // error handling
  const [errorSnapshot, setErrorSnapshot] = useState<VoiceErrorSnapshot>(
    INITIAL_VOICE_ERROR_SNAPSHOT,
  );
  const errorSnapshotRef = useRef<VoiceErrorSnapshot>(
    INITIAL_VOICE_ERROR_SNAPSHOT,
  );
  const error = errorSnapshot.error;
  const isError = error !== null;
  const isMicrophoneError = error?.type === 'mic_error';
  const isSocketError = error?.type === 'socket_error';
  const isAudioError = error?.type === 'audio_error';

  const onError = useLatestRef(props.onError ?? noop);
  const onOpen = useLatestRef(props.onOpen ?? noop);
  const onClose = useLatestRef(props.onClose ?? noop);
  const onMessage = useLatestRef(props.onMessage ?? noop);
  const onAudioReceived = useLatestRef(props.onAudioReceived ?? noop);
  const onAudioStart = useLatestRef(props.onAudioStart ?? noop);
  const onAudioEnd = useLatestRef(props.onAudioEnd ?? noop);
  const onInterruption = useLatestRef(props.onInterruption ?? noop);
  const diagnosticsOptionsRef = useLatestRef(diagnosticsConfiguration);
  const diagnosticsReporterRef = useRef<VoiceDiagnosticsReporter | null>(null);
  if (diagnosticsReporterRef.current === null) {
    diagnosticsReporterRef.current = createVoiceDiagnosticsReporter(
      () => diagnosticsOptionsRef.current,
    );
  }
  const diagnostics = diagnosticsReporterRef.current;
  const disconnectDiagnosticRef = useRef<{
    reason: 'consumer' | 'server' | 'error' | 'unmount';
    startedAt: number;
  } | null>(null);

  const beginDisconnectDiagnostic = useCallback(
    (reason: 'consumer' | 'server' | 'error' | 'unmount') => {
      if (disconnectDiagnosticRef.current !== null) {
        return;
      }
      disconnectDiagnosticRef.current = {
        reason,
        startedAt: getMonotonicTime(),
      };
      diagnostics.emit({
        level: 'info',
        category: 'connection',
        name: 'connection.disconnect_started',
        details: { reason },
      });
    },
    [diagnostics],
  );

  const completeDisconnectDiagnostic = useCallback(
    (cleanupFailures: readonly string[] = []) => {
      const pending = disconnectDiagnosticRef.current;
      if (pending === null) {
        return;
      }
      diagnostics.emit({
        level: cleanupFailures.length > 0 ? 'warn' : 'info',
        category: 'connection',
        name: 'connection.disconnected',
        durationMs: getMonotonicTime() - pending.startedAt,
        details: {
          reason: pending.reason,
          cleanupFailureCount: cleanupFailures.length,
          ...(cleanupFailures.length > 0
            ? { cleanupFailures: [...cleanupFailures] }
            : undefined),
        },
      });
      disconnectDiagnosticRef.current = null;
      diagnostics.clearConnection();
    },
    [diagnostics],
  );

  const toolStatus = useToolStatus();

  const onMessageWithDiagnostics = useCallback(
    (message: JSONMessage) =>
      invokeConsumerCallback(diagnostics, 'onMessage', () =>
        onMessage.current?.(message),
      ),
    [diagnostics, onMessage],
  );

  const messageStore = useMessages({
    sendMessageToParent: onMessageWithDiagnostics,
    messageHistoryLimit,
  });

  const hasDisconnectedResource = useCallback(() => {
    return (
      resourceStatusRef.current.mic === 'disconnected' ||
      resourceStatusRef.current.audioPlayer === 'disconnected' ||
      resourceStatusRef.current.socket === 'disconnected'
    );
  }, []);

  const hasDisconnectingResource = useCallback(() => {
    return (
      resourceStatusRef.current.mic === 'disconnecting' ||
      resourceStatusRef.current.audioPlayer === 'disconnecting' ||
      resourceStatusRef.current.socket === 'disconnecting'
    );
  }, []);

  const areAllResourcesDisconnected = useCallback(() => {
    return (
      resourceStatusRef.current.mic === 'disconnected' &&
      resourceStatusRef.current.audioPlayer === 'disconnected' &&
      resourceStatusRef.current.socket === 'disconnected'
    );
  }, []);

  const updateError = useCallback(
    (err: VoiceError) => {
      const correlation = diagnostics.getCorrelation();
      const nextSnapshot: VoiceErrorSnapshot = {
        error: err,
        version: errorSnapshotRef.current.version + 1,
        ...correlation,
      };
      errorSnapshotRef.current = nextSnapshot;
      setErrorSnapshot(nextSnapshot);
      diagnostics.emit({
        level: 'error',
        category: getVoiceErrorCategory(err),
        name: 'sdk.error',
        details: {
          type: err.type,
          reason: err.reason,
          message: err.message,
          ...(err.error ? { error: err.error } : undefined),
        },
      });
      invokeConsumerCallback(diagnostics, 'onError', () =>
        onError.current?.(err),
      );
    },
    [diagnostics, onError],
  );

  const clearError = useCallback(
    (reason: 'connect' | 'consumer_disconnect', expectedVersion?: number) => {
      const currentSnapshot = errorSnapshotRef.current;
      if (
        expectedVersion !== undefined &&
        currentSnapshot.version !== expectedVersion
      ) {
        return false;
      }

      const currentError = currentSnapshot.error;
      if (currentError === null) {
        return true;
      }

      const nextSnapshot: VoiceErrorSnapshot = {
        error: null,
        version: currentSnapshot.version + 1,
      };
      errorSnapshotRef.current = nextSnapshot;
      setErrorSnapshot(nextSnapshot);
      diagnostics.emit({
        level: 'info',
        category: getVoiceErrorCategory(currentError),
        name: 'sdk.error_cleared',
        connectionId: currentSnapshot.connectionId ?? null,
        chatId: currentSnapshot.chatId ?? null,
        details: {
          reason,
          type: currentError.type,
          errorReason: currentError.reason,
        },
      });
      return true;
    },
    [diagnostics],
  );

  const onClientError: NonNullable<
    Parameters<typeof useVoiceClient>[0]['onClientError']
  > = useCallback(
    (msg, err) => {
      stopTimer();
      const message = `A websocket connection could not be established. Error message: ${msg ?? 'unknown'}`;
      updateError({
        type: 'socket_error',
        reason: 'socket_connection_failure',
        message,
        error: err,
      });
    },
    [stopTimer, updateError],
  );

  const micStopFnRef = useRef<null | (() => Promise<void>)>(null);

  const player = useSoundPlayer({
    diagnostics,
    enableAudioWorklet,
    onError: (message, reason) => {
      if (hasDisconnectingResource() || hasDisconnectedResource()) {
        return;
      }
      updateError({ type: 'audio_error', reason, message });
    },
    onPlayAudio: (id: string) => {
      diagnostics.emit({
        level: 'info',
        category: 'audio_player',
        name: 'audio.playback_started',
        details: { clipId: id },
      });
      messageStore.onPlayAudio(id);
      invokeConsumerCallback(diagnostics, 'onAudioStart', () =>
        onAudioStart.current(id),
      );
    },
    onStopAudio: (id: string) => {
      diagnostics.emit({
        level: 'info',
        category: 'audio_player',
        name: 'audio.playback_ended',
        details: { clipId: id },
      });
      invokeConsumerCallback(diagnostics, 'onAudioEnd', () =>
        onAudioEnd.current(id),
      );
    },
  });

  const {
    onMessage: messageStoreOnMessage,
    createConnectMessage,
    createDisconnectMessage,
    createSessionSettingsMessage,
    clearMessages: clearMessageStore,
  } = messageStore;
  const {
    addToQueue: playerAddToQueue,
    clearQueue: playerClearQueue,
    initPlayer: playerInitPlayer,
    setOutputDevice: playerSetOutputDevice,
    stopAllForContext: playerStopAllForContext,
    waitForQueueToDrain: playerWaitForQueueToDrain,
  } = player;
  const { addToStore: toolStatusAddToStore, clearStore: toolStatusClearStore } =
    toolStatus;
  const playerIsPlayingRef = useLatestRef(player.isPlaying);

  const { getStream, stopStream } = useMicrophoneStream();

  const client = useVoiceClient({
    diagnostics,
    onAudioMessage: useCallback(
      (message: AudioOutputMessage) => {
        if (hasDisconnectingResource() || hasDisconnectedResource()) {
          return;
        }
        void playerAddToQueue(message);
        invokeConsumerCallback(diagnostics, 'onAudioReceived', () =>
          onAudioReceived.current(message),
        );
      },
      [
        hasDisconnectedResource,
        hasDisconnectingResource,
        diagnostics,
        onAudioReceived,
        playerAddToQueue,
      ],
    ),
    onMessage: useCallback(
      (message: JSONMessage) => {
        if (hasDisconnectingResource() || hasDisconnectedResource()) {
          return;
        }

        messageStoreOnMessage(message);

        if (message.type === 'user_interruption') {
          if (playerIsPlayingRef.current) {
            invokeConsumerCallback(diagnostics, 'onInterruption', () =>
              onInterruption.current(message),
            );
          }
          playerClearQueue();
        }

        if (
          message.type === 'tool_call' ||
          message.type === 'tool_response' ||
          message.type === 'tool_error'
        ) {
          toolStatusAddToStore(message);
        }

        if (message.type === 'error') {
          const voiceError: VoiceError = {
            type: 'socket_error',
            reason: 'received_assistant_error_message',
            message: message.message,
          };
          diagnostics.emit({
            level: 'error',
            category: 'socket',
            name: 'sdk.error',
            details: {
              type: voiceError.type,
              reason: voiceError.reason,
              message: voiceError.message,
            },
          });
          invokeConsumerCallback(diagnostics, 'onError', () =>
            onError.current?.(voiceError),
          );
        }
      },
      [
        hasDisconnectedResource,
        hasDisconnectingResource,
        diagnostics,
        messageStoreOnMessage,
        onError,
        onInterruption,
        playerClearQueue,
        playerIsPlayingRef,
        toolStatusAddToStore,
      ],
    ),
    onSessionSettings: useCallback(
      (sessionSettings: Hume.empathicVoice.SessionSettings) => {
        if (hasDisconnectingResource() || hasDisconnectedResource()) {
          return;
        }
        createSessionSettingsMessage(sessionSettings);
      },
      [
        createSessionSettingsMessage,
        hasDisconnectedResource,
        hasDisconnectingResource,
      ],
    ),
    onClientError,
    onToolCallError: useCallback(
      (message: string, err?: Error, source?: ToolCallErrorSource) => {
        if (hasDisconnectingResource() || hasDisconnectedResource()) {
          return;
        }
        if (source === 'send_failure') {
          updateError({
            type: 'socket_error',
            reason: 'failed_to_send_message',
            message,
            error: err,
          });
          return;
        }
        const voiceError: VoiceError = {
          type: 'socket_error',
          reason: 'received_tool_call_error',
          message,
          error: err,
        };
        // Tool handlers are application code, not socket infrastructure. Report
        // their failures without moving the live connection into the provider's
        // fatal error state.
        invokeConsumerCallback(diagnostics, 'onError', () =>
          onError.current?.(voiceError),
        );
      },
      [
        hasDisconnectedResource,
        hasDisconnectingResource,
        diagnostics,
        onError,
        updateError,
      ],
    ),
    onOpen: useCallback(() => {
      diagnostics.emit({
        level: 'info',
        category: 'socket',
        name: 'socket.opened',
      });
      startTimer();
      createConnectMessage();
      invokeConsumerCallback(diagnostics, 'onOpen', () => onOpen.current?.());
    }, [createConnectMessage, diagnostics, onOpen, startTimer]),
    onClose: useCallback(
      (
        event: SocketCloseEvent,
        consumerInitiated: boolean,
        connectionGeneration?: number,
      ) => {
        const currentConnectionGeneration =
          currentConnectionGenerationRef.current;
        if (
          currentConnectionGeneration === null ||
          (connectionGeneration !== undefined &&
            connectionGeneration !== currentConnectionGeneration)
        ) {
          return;
        }
        currentConnectionGenerationRef.current = null;

        // A pending teardown owns every provider-wide mutation. Its socket close
        // only publishes the close event for the lifecycle that requested it.
        // In particular, a delayed consumer close must not cancel a reconnect.
        if (consumerInitiated || pendingDisconnectCleanupRef.current !== null) {
          resourceStatusRef.current.socket = 'disconnected';
          if (!clearMessagesOnDisconnect) {
            createDisconnectMessage(event);
          }
          invokeConsumerCallback(diagnostics, 'onClose', () =>
            onClose.current?.(event),
          );
          return;
        }

        beginDisconnectDiagnostic('server');
        const closeGeneration = ++lifecycleGenerationRef.current;
        const closeCleanupStillOwnsResources = () =>
          isCurrentLifecycleGeneration(closeGeneration) ||
          pendingDisconnectCleanupRef.current !== null;
        const sharedContextToClose = sharedAudioContextRef.current;
        // onClose handler needs to handle resource cleanup in the event that the
        // websocket connection is closed by the server and not the user/client
        stopTimer();
        isConnectingRef.current = false;
        resourceStatusRef.current.socket = 'disconnected';
        activeAudioConstraintsRef.current = null;
        resetAudioDeviceState();

        createDisconnectMessage(event);
        if (clearMessagesOnDisconnect) {
          clearMessageStore();
        }
        toolStatusClearStore();
        setIsPaused(false);
        const closeError = errorSnapshotRef.current.error;
        if (closeError === null) {
          setDisconnectedStatus();
        } else {
          setErrorStatus(closeError);
        }

        // The microphone always stops at once: the socket is already gone, so
        // continuing to capture only keeps the recording indicator lit.
        const shouldStopMicRecorder =
          resourceStatusRef.current.mic === 'connected';
        const shouldReleaseMic =
          resourceStatusRef.current.mic !== 'disconnected';
        const shouldStopPlayer =
          resourceStatusRef.current.audioPlayer === 'connected';
        if (shouldReleaseMic) {
          resourceStatusRef.current.mic = 'disconnecting';
        }
        if (shouldStopPlayer) {
          resourceStatusRef.current.audioPlayer = 'disconnecting';
        }

        const micCleanup = (async () => {
          if (!shouldReleaseMic) return;
          const failures: string[] = [];
          if (shouldStopMicRecorder) {
            try {
              await micStopFnRef.current?.();
            } catch (failure) {
              failures.push(
                failure instanceof Error ? failure.message : 'Unknown error',
              );
            }
          }
          if (closeCleanupStillOwnsResources()) {
            try {
              stopStream();
            } catch (failure) {
              failures.push(
                failure instanceof Error ? failure.message : 'Unknown error',
              );
            }
          }
          if (failures.length > 0) {
            throw new Error(failures.join('; '));
          }
        })();
        const playerCleanup = (async () => {
          if (!shouldStopPlayer) return;
          await playerWaitForQueueToDrain();
          if (!closeCleanupStillOwnsResources()) return;
          if (!sharedContextToClose) {
            throw new Error(
              'Audio player cleanup could not find its owning audio context.',
            );
          }
          await playerStopAllForContext(sharedContextToClose);
        })();

        const closeCleanup = Promise.allSettled([
          micCleanup,
          playerCleanup,
        ]).then(async (results) => {
          if (!closeCleanupStillOwnsResources()) return;
          const cleanupFailures = results.flatMap((result) =>
            result.status === 'rejected'
              ? [
                  result.reason instanceof Error
                    ? result.reason.message
                    : 'Unknown cleanup error',
                ]
              : [],
          );
          if (sharedContextToClose) {
            const closeResult =
              await closeSharedAudioContext(sharedContextToClose);
            if (!closeCleanupStillOwnsResources()) return;
            if (closeResult && !closeResult.success) {
              cleanupFailures.push(closeResult.error.message);
            }
          }
          resourceStatusRef.current.audioPlayer = 'disconnected';
          resourceStatusRef.current.mic = 'disconnected';
          resourceCleanupCompletedRef.current = cleanupFailures.length === 0;
          completeDisconnectDiagnostic(cleanupFailures);
        });
        pendingCloseCleanupRef.current = closeCleanup;
        const clearCloseCleanup = () => {
          if (pendingCloseCleanupRef.current === closeCleanup) {
            pendingCloseCleanupRef.current = null;
          }
        };
        void closeCleanup.then(clearCloseCleanup, clearCloseCleanup);
        invokeConsumerCallback(diagnostics, 'onClose', () =>
          onClose.current?.(event),
        );
      },
      [
        beginDisconnectDiagnostic,
        clearMessagesOnDisconnect,
        closeSharedAudioContext,
        completeDisconnectDiagnostic,
        createDisconnectMessage,
        clearMessageStore,
        diagnostics,
        onClose,
        playerStopAllForContext,
        playerWaitForQueueToDrain,
        resetAudioDeviceState,
        setDisconnectedStatus,
        setErrorStatus,
        isCurrentLifecycleGeneration,
        stopStream,
        stopTimer,
        toolStatusClearStore,
      ],
    ),
    onToolCall: props.onToolCall,
  });

  const {
    sendAudio: clientSendAudio,
    sendUserInput: clientSendUserInput,
    sendAssistantInput: clientSendAssistantInput,
    sendSessionSettings: clientSendSessionSettings,
    sendToolMessage: clientSendToolMessage,
    sendPauseAssistantMessage,
    sendResumeAssistantMessage,
    connect: clientConnect,
    disconnect: clientDisconnect,
  } = client;
  const clientReadyStateRef = useLatestRef(client.readyState);

  const mic = useMicrophone({
    diagnostics,
    onStartRecording: props.onStartRecording,
    onStopRecording: props.onStopRecording,
    onAudioCaptured: useCallback(
      (arrayBuffer) => {
        if (
          resourceStatusRef.current.socket === 'disconnected' ||
          (resourceStatusRef.current.socket === 'disconnecting' &&
            !isFlushingMicrophoneRef.current)
        ) {
          // if socket is being disconnected, don't try to send audio
          return;
        }
        try {
          clientSendAudio(arrayBuffer);
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Unknown error';
          updateError({
            type: 'socket_error',
            reason: 'failed_to_send_audio',
            message,
          });
        }
      },
      [clientSendAudio, updateError],
    ),
    onError: useCallback(
      (message, reason) => {
        updateError({ type: 'mic_error', reason, message });
      },
      [updateError],
    ),
  });

  const { replace: micReplace, start: micStart, stop: micStop } = mic;

  useEffect(() => {
    micStopFnRef.current = micStop;
  }, [micStop]);

  const isConnectedForDeviceSwitch = useCallback(
    () =>
      resourceStatusRef.current.socket === 'connected' &&
      resourceStatusRef.current.mic === 'connected' &&
      resourceStatusRef.current.audioPlayer === 'connected',
    [],
  );

  const setInputDevice = useCallback(
    (deviceId: string | null): Promise<void> => {
      const startedAt = getMonotonicTime();
      diagnostics.addRedactionValue(deviceId ?? undefined);
      diagnostics.emit({
        level: 'info',
        category: 'audio_device',
        name: 'audio_device.switch_started',
        details: { kind: 'audioinput', useDefaultDevice: deviceId === null },
      });
      const switching = enqueueDeviceSwitch({
        kind: 'audioinput',
        queueRef: inputSwitchQueueRef,
        lifecycleGenerationRef,
        isConnected: isConnectedForDeviceSwitch,
        isAlreadyActive: () =>
          deviceId !== null && activeInputDeviceIdRef.current === deviceId,
        onAlreadyActive: () => {
          diagnostics.emit({
            level: 'warn',
            category: 'audio_device',
            name: 'audio_device.switch_ignored',
            details: { kind: 'audioinput', reason: 'already_active' },
          });
          publishInputDeviceState(deviceId, activeInputDeviceIdRef.current);
        },
        perform: async (isCurrent) => {
          const audioConstraints = activeAudioConstraintsRef.current;
          const sharedContext = sharedAudioContextRef.current;
          if (!audioConstraints || !sharedContext) {
            throw createDeviceSwitchError('audioinput', 'interrupted');
          }

          const candidateConstraints: MediaTrackConstraints = {
            ...audioConstraints,
          };
          if (deviceId !== null) {
            candidateConstraints.deviceId = { exact: deviceId };
          }

          const candidateStream = await getStream(candidateConstraints);
          if (!isCurrent()) {
            stopStream(candidateStream);
            throw createDeviceSwitchError('audioinput', 'interrupted');
          }

          try {
            await micReplace(candidateStream, sharedContext);
          } catch (cause) {
            stopStream(candidateStream);
            throw createDeviceSwitchError('audioinput', 'switch_failed', cause);
          }

          return getGrantedInputDeviceId(candidateStream, deviceId);
        },
        commit: (grantedDeviceId) => {
          diagnostics.addRedactionValue(grantedDeviceId ?? undefined);
          publishInputDeviceState(deviceId, grantedDeviceId);
        },
      });
      void switching.then(
        () => {
          diagnostics.emit({
            level: 'info',
            category: 'audio_device',
            name: 'audio_device.switch_completed',
            durationMs: getMonotonicTime() - startedAt,
            details: { kind: 'audioinput' },
          });
        },
        (switchError: unknown) => {
          diagnostics.emit({
            level: 'warn',
            category: 'audio_device',
            name: 'audio_device.switch_failed',
            durationMs: getMonotonicTime() - startedAt,
            details: {
              kind: 'audioinput',
              reason: isAudioDeviceSwitchError(switchError)
                ? switchError.reason
                : 'switch_failed',
              error: switchError,
            },
          });
        },
      );
      return switching;
    },
    [
      diagnostics,
      getStream,
      isConnectedForDeviceSwitch,
      micReplace,
      publishInputDeviceState,
      stopStream,
    ],
  );

  const setOutputDevice = useCallback(
    (deviceId: string | null): Promise<void> => {
      const startedAt = getMonotonicTime();
      diagnostics.addRedactionValue(deviceId ?? undefined);
      diagnostics.emit({
        level: 'info',
        category: 'audio_device',
        name: 'audio_device.switch_started',
        details: { kind: 'audiooutput', useDefaultDevice: deviceId === null },
      });
      const switching = enqueueDeviceSwitch({
        kind: 'audiooutput',
        queueRef: outputSwitchQueueRef,
        lifecycleGenerationRef,
        isConnected: isConnectedForDeviceSwitch,
        isAlreadyActive: () => activeOutputDeviceIdRef.current === deviceId,
        onAlreadyActive: () => {
          diagnostics.emit({
            level: 'warn',
            category: 'audio_device',
            name: 'audio_device.switch_ignored',
            details: { kind: 'audiooutput', reason: 'already_active' },
          });
          publishOutputDeviceState(deviceId, activeOutputDeviceIdRef.current);
        },
        perform: async () => {
          await playerSetOutputDevice(deviceId);
          return deviceId;
        },
        commit: (activeDeviceId) => {
          publishOutputDeviceState(deviceId, activeDeviceId);
        },
      });
      void switching.then(
        () => {
          diagnostics.emit({
            level: 'info',
            category: 'audio_device',
            name: 'audio_device.switch_completed',
            durationMs: getMonotonicTime() - startedAt,
            details: { kind: 'audiooutput' },
          });
        },
        (switchError: unknown) => {
          diagnostics.emit({
            level: 'warn',
            category: 'audio_device',
            name: 'audio_device.switch_failed',
            durationMs: getMonotonicTime() - startedAt,
            details: {
              kind: 'audiooutput',
              reason: isAudioDeviceSwitchError(switchError)
                ? switchError.reason
                : 'switch_failed',
              error: switchError,
            },
          });
        },
      );
      return switching;
    },
    [
      diagnostics,
      isConnectedForDeviceSwitch,
      playerSetOutputDevice,
      publishOutputDeviceState,
    ],
  );

  const pauseAssistant = useCallback(() => {
    try {
      sendPauseAssistantMessage();
      setIsPaused(true);
      diagnostics.emit({
        level: 'info',
        category: 'message',
        name: 'control.changed',
        details: { control: 'assistant_pause', value: true },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      updateError({
        type: 'socket_error',
        reason: 'failed_to_send_message',
        message,
      });
    }
    playerClearQueue();
  }, [diagnostics, sendPauseAssistantMessage, playerClearQueue, updateError]);

  const resumeAssistant = useCallback(() => {
    try {
      sendResumeAssistantMessage();
      setIsPaused(false);
      diagnostics.emit({
        level: 'info',
        category: 'message',
        name: 'control.changed',
        details: { control: 'assistant_pause', value: false },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      updateError({
        type: 'socket_error',
        reason: 'failed_to_send_message',
        message,
      });
    }
  }, [diagnostics, sendResumeAssistantMessage, updateError]);

  const checkShouldContinueConnecting = useCallback(
    (generation: number) => {
      // This check exists because if the user disconnects while the
      // connection is in progress, we need to stop the connection
      // attempt and prevent audio resources from being initialized.
      return (
        isConnectingRef.current !== false &&
        isCurrentLifecycleGeneration(generation)
      );
    },
    [isCurrentLifecycleGeneration],
  );

  const connect = useCallback(
    async (options: ConnectOptions) => {
      const {
        audioConstraints = {},
        sessionSettings,
        devices,
        ...socketConfig
      } = options;
      const connectRequestGeneration = lifecycleGenerationRef.current;
      const connectionIsActive = () =>
        isConnectingRef.current ||
        resourceStatusRef.current.socket === 'connected';

      const pendingCleanups = [
        pendingCloseCleanupRef.current,
        pendingDisconnectCleanupRef.current,
      ].filter((cleanup): cleanup is Promise<void> => cleanup !== null);
      if (pendingCleanups.length > 0) {
        await Promise.allSettled(pendingCleanups);
        if (!isCurrentLifecycleGeneration(connectRequestGeneration)) {
          diagnostics.emit({
            level: 'info',
            category: 'connection',
            name: 'connection.attempt_cancelled',
            details: { phase: 'pending_cleanup' },
          });
          return;
        }
      }
      if (connectionIsActive()) {
        diagnostics.emit({
          level: 'warn',
          category: 'connection',
          name: 'connection.attempt_ignored',
          details: {
            reason: isConnectingRef.current
              ? 'already_connecting'
              : 'already_connected',
          },
        });
        return;
      }

      // Validate credentials before requesting microphone access so a
      // misconfigured app fails with a clear message instead of prompting the
      // user for a microphone it will never use.
      const authError = getAuthStrategyError(socketConfig.auth);
      if (authError !== null) {
        updateError({
          type: 'socket_error',
          reason: 'socket_connection_failure',
          message: `A websocket connection could not be established. Error message: ${authError}`,
          error: new Error(authError),
        });
        return;
      }

      const generation = ++lifecycleGenerationRef.current;
      currentConnectionGenerationRef.current = generation;
      resourceCleanupCompletedRef.current = false;
      const connectionStartedAt = getMonotonicTime();
      clearError('connect');
      diagnostics.beginConnection(socketConfig.auth.value);
      diagnostics.addRedactionValue(devices?.microphoneDeviceId);
      diagnostics.addRedactionValue(devices?.speakerDeviceId);
      diagnostics.emit({
        level: 'info',
        category: 'connection',
        name: 'connection.attempt_started',
        details: {
          hostname: socketConfig.hostname ?? 'api.hume.ai',
          hasSessionSettings: sessionSettings !== undefined,
          requestedInputDevice: devices?.microphoneDeviceId !== undefined,
          requestedOutputDevice: devices?.speakerDeviceId !== undefined,
        },
      });

      activeAudioConstraintsRef.current = null;
      resetAudioDeviceState();

      setStatus({ value: 'connecting' });
      resourceStatusRef.current.socket = 'connecting';
      resourceStatusRef.current.audioPlayer = 'connecting';
      resourceStatusRef.current.mic = 'connecting';
      isConnectingRef.current = true;

      // Microphone permissions check - happens first
      let stream: MediaStream | null = null;

      const micConstraints: MediaTrackConstraints = {
        ...audioConstraints,
        deviceId: devices?.microphoneDeviceId,
      };

      diagnostics.emit({
        level: 'info',
        category: 'microphone',
        name: 'microphone.permission_requested',
      });

      try {
        stream = await getStream(micConstraints);
        diagnostics.emit({
          level: 'info',
          category: 'microphone',
          name: 'microphone.permission_resolved',
          details: { outcome: 'granted' },
        });
      } catch (e) {
        if (!checkShouldContinueConnecting(generation)) {
          return;
        }
        const isPermissionDeniedError =
          e instanceof DOMException && e.name === 'NotAllowedError';
        const voiceError: VoiceError = {
          type: 'mic_error',
          reason: isPermissionDeniedError
            ? 'mic_permission_denied'
            : 'mic_initialization_failure',
          message:
            e instanceof Error
              ? e.message
              : 'The microphone could not be initialized.',
        };
        diagnostics.emit({
          level: 'error',
          category: 'microphone',
          name: 'microphone.permission_resolved',
          details: {
            outcome: isPermissionDeniedError ? 'denied' : 'failed',
            error: e,
          },
        });
        updateError(voiceError);
        return;
      }

      const stopCapturedStream = (failureMessage: string) => {
        try {
          stopStream(stream);
        } catch (cleanupError) {
          diagnostics.emit({
            level: 'warn',
            category: 'microphone',
            name: 'resource.cleanup_failed',
            details: {
              resource: 'microphone',
              message: failureMessage,
              error: cleanupError,
            },
          });
        }
      };

      if (!checkShouldContinueConnecting(generation)) {
        diagnostics.emit({
          level: 'info',
          category: 'connection',
          name: 'connection.attempt_cancelled',
          details: { phase: 'microphone_permission' },
        });
        stopCapturedStream(
          'Failed to stop a canceled connection microphone stream.',
        );
        return;
      }

      let sharedCtx: AudioContext;
      try {
        sharedCtx = new AudioContext();
      } catch (e) {
        stopCapturedStream(
          'Failed to stop the microphone after audio context initialization failed.',
        );
        if (!checkShouldContinueConnecting(generation)) {
          return;
        }
        resourceStatusRef.current.socket = 'disconnected';
        resourceStatusRef.current.audioPlayer = 'disconnected';
        resourceStatusRef.current.mic = 'disconnected';
        isConnectingRef.current = false;
        updateError({
          type: 'audio_error',
          reason: 'audio_player_initialization_failure',
          message:
            e instanceof Error
              ? e.message
              : 'We could not create an audio context. Please try again.',
        });
        return;
      }
      sharedAudioContextRef.current = sharedCtx;

      const cleanupAttemptResources = async (stopPlayer: boolean) => {
        stopCapturedStream(
          'Failed to stop a canceled connection microphone stream.',
        );
        if (stopPlayer) {
          await playerStopAllForContext(sharedCtx);
        }
        await closeSharedAudioContext(sharedCtx);
      };

      // Audio Player - must initialize before connecting to the socket
      // because it needs to exist by the time the socket is ready to send audio data
      if (!checkShouldContinueConnecting(generation)) {
        diagnostics.emit({
          level: 'info',
          category: 'connection',
          name: 'connection.attempt_cancelled',
          details: { phase: 'audio_player' },
        });
        await cleanupAttemptResources(false);
        return;
      }
      let playerInitialized: boolean;
      const playerStartedAt = getMonotonicTime();
      diagnostics.emit({
        level: 'info',
        category: 'audio_player',
        name: 'resource.initialization_started',
        details: {
          resource: 'audio_player',
          audioWorkletEnabled: enableAudioWorklet,
        },
      });
      try {
        playerInitialized = await playerInitPlayer(
          devices?.speakerDeviceId,
          sharedCtx,
        );
      } catch (e) {
        if (!checkShouldContinueConnecting(generation)) {
          diagnostics.emit({
            level: 'info',
            category: 'connection',
            name: 'connection.attempt_cancelled',
            details: { phase: 'audio_player' },
          });
          await cleanupAttemptResources(true);
          return;
        }
        resourceStatusRef.current.audioPlayer = 'disconnected';
        resourceStatusRef.current.mic = 'disconnected';
        isConnectingRef.current = false;
        updateError({
          type: 'audio_error',
          reason: 'audio_player_initialization_failure',
          message:
            e instanceof Error
              ? e.message
              : 'We could not connect to the audio player. Please try again.',
        });
        await cleanupAttemptResources(true);
        return;
      }
      if (!checkShouldContinueConnecting(generation)) {
        diagnostics.emit({
          level: 'info',
          category: 'connection',
          name: 'connection.attempt_cancelled',
          details: { phase: 'audio_player' },
        });
        await cleanupAttemptResources(true);
        return;
      }
      if (!playerInitialized) {
        if (!isCurrentLifecycleGeneration(generation)) {
          return;
        }
        await cleanupAttemptResources(true);
        if (!isCurrentLifecycleGeneration(generation)) {
          return;
        }
        resourceStatusRef.current.socket = 'disconnected';
        resourceStatusRef.current.audioPlayer = 'disconnected';
        resourceStatusRef.current.mic = 'disconnected';
        isConnectingRef.current = false;
        setDisconnectedStatus();
        return;
      }
      resourceStatusRef.current.audioPlayer = 'connected';
      diagnostics.emit({
        level: 'info',
        category: 'audio_player',
        name: 'resource.initialized',
        durationMs: getMonotonicTime() - playerStartedAt,
        details: { resource: 'audio_player' },
      });

      // WEBSOCKET - needs to be connected before the microphone is initialized
      // because a connection needs to be established before the microphone can start sending
      // the audio stream
      try {
        await clientConnect(
          {
            ...socketConfig,
            verboseTranscription: socketConfig.verboseTranscription ?? true,
          },
          sessionSettings,
          generation,
        );
      } catch (e) {
        // catching the thrown error here so we can return early from the connect function.
        // Any errors themselves are handled in the `onClientError` callback on the client,
        // except for the AbortController case, which we don't need to call onClientError for
        // because cancellations are intentional, and not network errors.
        const connectionIsCurrent = checkShouldContinueConnecting(generation);
        if (!connectionIsCurrent) {
          return;
        }
        await cleanupAttemptResources(true);
        resourceStatusRef.current.socket = 'disconnected';
        resourceStatusRef.current.audioPlayer = 'disconnected';
        resourceStatusRef.current.mic = 'disconnected';
        isConnectingRef.current = false;
        return;
      }
      if (!checkShouldContinueConnecting(generation)) {
        diagnostics.emit({
          level: 'info',
          category: 'connection',
          name: 'connection.attempt_cancelled',
          details: { phase: 'socket' },
        });
        // Every lifecycle invalidation after the socket starts has already
        // registered a teardown that owns the captured stream and context.
        return;
      }
      // we can set resourceStatusRef.current.socket here because `client.connect` resolves
      // at the same time as when the onOpen callback is called
      resourceStatusRef.current.socket = 'connected';

      // MICROPHONE - initialized last
      const microphoneStartedAt = getMonotonicTime();
      diagnostics.emit({
        level: 'info',
        category: 'microphone',
        name: 'resource.initialization_started',
        details: { resource: 'microphone' },
      });
      try {
        micStart(stream, sharedCtx);
      } catch (e) {
        resourceStatusRef.current.mic = 'disconnected';
        updateError({
          type: 'mic_error',
          reason: 'mic_initialization_failure',
          message:
            e instanceof Error
              ? e.message
              : 'We could not connect to the microphone. Please try again.',
        });
        return;
      }
      resourceStatusRef.current.mic = 'connected';
      diagnostics.emit({
        level: 'info',
        category: 'microphone',
        name: 'resource.initialized',
        durationMs: getMonotonicTime() - microphoneStartedAt,
        details: { resource: 'microphone' },
      });

      activeAudioConstraintsRef.current = { ...audioConstraints };
      const requestedInputDeviceId = devices?.microphoneDeviceId ?? null;
      const grantedInputDeviceId = getGrantedInputDeviceId(
        stream,
        requestedInputDeviceId,
      );
      diagnostics.addRedactionValue(grantedInputDeviceId ?? undefined);
      publishInputDeviceState(requestedInputDeviceId, grantedInputDeviceId);
      const requestedOutputDeviceId = devices?.speakerDeviceId ?? null;
      publishOutputDeviceState(
        requestedOutputDeviceId,
        requestedOutputDeviceId !== null && 'setSinkId' in sharedCtx
          ? requestedOutputDeviceId
          : null,
      );

      setStatus({ value: 'connected' });
      isConnectingRef.current = false;
      diagnostics.emit({
        level: 'info',
        category: 'connection',
        name: 'connection.connected',
        durationMs: getMonotonicTime() - connectionStartedAt,
      });
    },
    [
      checkShouldContinueConnecting,
      clearError,
      clientConnect,
      closeSharedAudioContext,
      diagnostics,
      enableAudioWorklet,
      getStream,
      isCurrentLifecycleGeneration,
      micStart,
      playerInitPlayer,
      playerStopAllForContext,
      publishInputDeviceState,
      publishOutputDeviceState,
      resetAudioDeviceState,
      setDisconnectedStatus,
      stopStream,
      updateError,
    ],
  );

  // `disconnectAndCleanUpResources`: Internal function that is called to actually disconnect
  // from the socket, audio player, and microphone.
  const disconnectAndCleanUpResources = useCallback(
    (
      diagnosticReason:
        | 'consumer'
        | 'server'
        | 'error'
        | 'unmount' = 'consumer',
    ) => {
      const existingCleanup = pendingDisconnectCleanupRef.current;
      if (existingCleanup) {
        return existingCleanup;
      }

      const closeCleanupToAwait = pendingCloseCleanupRef.current;
      if (
        closeCleanupToAwait === null &&
        resourceCleanupCompletedRef.current &&
        areAllResourcesDisconnected() &&
        !isConnectingRef.current &&
        sharedAudioContextRef.current === null
      ) {
        return Promise.resolve();
      }

      const audioPlayerWasConnected =
        resourceStatusRef.current.audioPlayer === 'connected';

      // Invalidate connection attempts and device switches synchronously. A
      // pending close cleanup may still finish its captured resources, but no
      // later connection may begin asynchronous initialization for this owner.
      lifecycleGenerationRef.current += 1;
      if (resourceStatusRef.current.socket !== 'disconnected') {
        resourceStatusRef.current.socket = 'disconnecting';
      }
      if (resourceStatusRef.current.audioPlayer !== 'disconnected') {
        resourceStatusRef.current.audioPlayer = 'disconnecting';
      }
      if (resourceStatusRef.current.mic !== 'disconnected') {
        resourceStatusRef.current.mic = 'disconnecting';
      }
      isConnectingRef.current = false;

      const cleanup = (async () => {
        if (closeCleanupToAwait) {
          await Promise.allSettled([closeCleanupToAwait]);
        }

        if (
          resourceCleanupCompletedRef.current &&
          areAllResourcesDisconnected() &&
          !isConnectingRef.current &&
          sharedAudioContextRef.current === null
        ) {
          return;
        }

        beginDisconnectDiagnostic(diagnosticReason);
        const sharedContextToClose = sharedAudioContextRef.current;
        const failures: string[] = [];
        const recordFailure = (label: string, failure: unknown) => {
          const detail =
            failure instanceof Error ? failure.message : 'Unknown error';
          failures.push(`${label}: ${detail}`);
        };
        const attempt = async (
          label: string,
          action: () => void | Promise<unknown>,
        ) => {
          try {
            await action();
          } catch (cleanupFailure) {
            recordFailure(label, cleanupFailure);
          }
        };
        const finalize = (label: string, action: () => void) => {
          try {
            action();
          } catch (cleanupFailure) {
            recordFailure(label, cleanupFailure);
          }
        };

        try {
          isFlushingMicrophoneRef.current = true;

          await attempt('Call timer cleanup failed', stopTimer);

          // Keep the socket connected until MediaRecorder has delivered its final
          // dataavailable payload, then release the underlying stream.
          await attempt('Microphone cleanup failed', micStop);
          isFlushingMicrophoneRef.current = false;
          await attempt('Microphone stream cleanup failed', stopStream);

          // Shut down the websocket before the audio player.
          if (clientReadyStateRef.current !== VoiceReadyState.CLOSED) {
            await attempt('Websocket cleanup failed', clientDisconnect);
          }

          // Scope teardown to the context owned when this cleanup began so it can
          // never stop a later player's resources.
          if (sharedContextToClose) {
            await attempt('Audio player cleanup failed', () =>
              playerStopAllForContext(sharedContextToClose),
            );
          } else if (audioPlayerWasConnected) {
            recordFailure(
              'Audio player cleanup failed',
              new Error('The owning audio context was unavailable.'),
            );
          }

          if (sharedContextToClose) {
            await attempt('Shared audio context cleanup failed', async () => {
              const closeResult =
                await closeSharedAudioContext(sharedContextToClose);
              if (closeResult && !closeResult.success) {
                throw closeResult.error;
              }
            });
          }
        } finally {
          isFlushingMicrophoneRef.current = false;
          isConnectingRef.current = false;
          resourceStatusRef.current = {
            mic: 'disconnected',
            audioPlayer: 'disconnected',
            socket: 'disconnected',
          };
          activeAudioConstraintsRef.current = null;
          resetAudioDeviceState();
          if (clearMessagesOnDisconnect) {
            finalize('Message store cleanup failed', clearMessageStore);
          }
          finalize('Tool status cleanup failed', toolStatusClearStore);
          finalize('Pause state cleanup failed', () => setIsPaused(false));
          resourceCleanupCompletedRef.current = failures.length === 0;

          if (failures.length > 0) {
            diagnostics.emit({
              level: 'error',
              category: 'connection',
              name: 'resource.cleanup_failed',
              details: {
                resource: 'connection',
                message: 'Failed to fully disconnect voice resources.',
                failures,
              },
            });
          }
          completeDisconnectDiagnostic(failures);
        }
      })();

      pendingDisconnectCleanupRef.current = cleanup;
      const clearCleanup = () => {
        if (pendingDisconnectCleanupRef.current === cleanup) {
          pendingDisconnectCleanupRef.current = null;
        }
      };
      void cleanup.then(clearCleanup, clearCleanup);
      return cleanup;
    },
    [
      beginDisconnectDiagnostic,
      areAllResourcesDisconnected,
      completeDisconnectDiagnostic,
      diagnostics,
      stopTimer,
      stopStream,
      micStop,
      clientReadyStateRef,
      clientDisconnect,
      closeSharedAudioContext,
      playerStopAllForContext,
      resetAudioDeviceState,
      clearMessagesOnDisconnect,
      clearMessageStore,
      toolStatusClearStore,
    ],
  );

  // `disconnect` is the function that the end user calls to disconnect a call
  const disconnect = useCallback(async () => {
    const errorVersionAtStart = errorSnapshotRef.current.version;
    const cleanup = disconnectAndCleanUpResources();
    // Cleanup invalidates its lifecycle synchronously before returning.
    const disconnectGeneration = lifecycleGenerationRef.current;
    await cleanup;
    if (!isCurrentLifecycleGeneration(disconnectGeneration)) {
      return;
    }
    if (clearError('consumer_disconnect', errorVersionAtStart)) {
      setDisconnectedStatus();
      return;
    }

    const teardownError = errorSnapshotRef.current.error;
    if (teardownError !== null) {
      setErrorStatus(teardownError);
    }
  }, [
    clearError,
    disconnectAndCleanUpResources,
    isCurrentLifecycleGeneration,
    setDisconnectedStatus,
    setErrorStatus,
  ]);

  const disconnectAndCleanUpResourcesRef = useLatestRef(
    disconnectAndCleanUpResources,
  );

  useEffect(() => {
    if (error !== null) {
      setErrorStatus(error);
      void disconnectAndCleanUpResources('error');
    }
  }, [disconnectAndCleanUpResources, error, setErrorStatus]);

  useEffect(() => {
    // disconnect from socket when the voice provider component unmounts
    return () => {
      // Intentionally read the latest cleanup callback when unmount begins.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const cleanup = disconnectAndCleanUpResourcesRef.current('unmount');
      // Cleanup invalidates its lifecycle synchronously before returning.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const unmountGeneration = lifecycleGenerationRef.current;
      void cleanup.then(() => {
        if (!isCurrentLifecycleGeneration(unmountGeneration)) {
          return;
        }
        setDisconnectedStatus();
        isConnectingRef.current = false;
        resourceStatusRef.current = {
          mic: 'disconnected',
          audioPlayer: 'disconnected',
          socket: 'disconnected',
        };
      });
    };
  }, [
    disconnectAndCleanUpResourcesRef,
    isCurrentLifecycleGeneration,
    setDisconnectedStatus,
  ]);

  const sendUserInput = useCallback(
    (text: string) => {
      if (resourceStatusRef.current.socket !== 'connected') {
        diagnostics.emit({
          level: 'warn',
          category: 'message',
          name: 'message.skipped',
          details: {
            direction: 'outbound',
            type: 'user_input',
            reason: 'socket_not_connected',
            contentLength: text.length,
          },
          sensitiveDetails: { content: text },
        });
        return;
      }
      try {
        clientSendUserInput(text);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        updateError({
          type: 'socket_error',
          reason: 'failed_to_send_message',
          message,
        });
      }
    },
    [clientSendUserInput, diagnostics, updateError],
  );

  const sendAssistantInput = useCallback(
    (text: string) => {
      if (resourceStatusRef.current.socket !== 'connected') {
        diagnostics.emit({
          level: 'warn',
          category: 'message',
          name: 'message.skipped',
          details: {
            direction: 'outbound',
            type: 'assistant_input',
            reason: 'socket_not_connected',
            contentLength: text.length,
          },
          sensitiveDetails: { content: text },
        });
        return;
      }
      try {
        clientSendAssistantInput(text);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        updateError({
          type: 'socket_error',
          reason: 'failed_to_send_message',
          message,
        });
      }
    },
    [clientSendAssistantInput, diagnostics, updateError],
  );

  const sendSessionSettings = useCallback(
    (sessionSettings: SessionSettingsUpdate) => {
      if (resourceStatusRef.current.socket !== 'connected') {
        diagnostics.emit({
          level: 'warn',
          category: 'message',
          name: 'message.skipped',
          details: {
            direction: 'outbound',
            type: 'session_settings',
            reason: 'socket_not_connected',
          },
        });
        return;
      }
      try {
        clientSendSessionSettings(sessionSettings);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        updateError({
          type: 'socket_error',
          reason: 'failed_to_send_message',
          message,
        });
      }
    },
    [clientSendSessionSettings, diagnostics, updateError],
  );

  const sendToolMessage = useCallback(
    (
      message:
        | Hume.empathicVoice.ToolResponseMessage
        | Hume.empathicVoice.ToolErrorMessage,
    ) => {
      if (resourceStatusRef.current.socket !== 'connected') {
        diagnostics.emit({
          level: 'warn',
          category: 'message',
          name: 'message.skipped',
          details: {
            direction: 'outbound',
            type: message.type,
            reason: 'socket_not_connected',
            toolCallId: message.toolCallId,
          },
          sensitiveDetails: { content: message.content },
        });
        return;
      }
      try {
        clientSendToolMessage(message);
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        updateError({
          type: 'socket_error',
          reason: 'failed_to_send_message',
          message: errorMessage,
        });
      }
    },
    [clientSendToolMessage, diagnostics, updateError],
  );

  const storesCtx = useMemo(
    () => ({
      playerFftStore: player.fftStore,
      micFftStore: mic.fftStore,
      callDurationStore,
    }),
    [player.fftStore, mic.fftStore, callDurationStore],
  );

  const ctx = useMemo(
    () =>
      ({
        connect,
        disconnect,
        setInputDevice,
        setOutputDevice,
        ...audioDeviceState,
        isMuted: mic.isMuted,
        isAudioMuted: player.isAudioMuted,
        isPlaying: player.isPlaying,
        messages: messageStore.messages,
        lastVoiceMessage: messageStore.lastVoiceMessage,
        lastUserMessage: messageStore.lastUserMessage,
        lastAssistantProsodyMessage: messageStore.lastAssistantProsodyMessage,
        clearMessages: messageStore.clearMessages,
        mute: mic.mute,
        muteAudio: player.muteAudio,
        readyState: client.readyState,
        sendUserInput,
        sendAssistantInput,
        sendSessionSettings,
        pauseAssistant,
        resumeAssistant,
        sendToolMessage,
        status,
        unmute: mic.unmute,
        unmuteAudio: player.unmuteAudio,
        error,
        isAudioError,
        isError,
        isMicrophoneError,
        isSocketError,
        toolStatusStore: toolStatus.store,
        chatMetadata: messageStore.chatMetadata,
        playerQueueLength: player.queueLength,
        isPaused,
        volume: player.volume,
        setVolume: player.setVolume,
      }) satisfies VoiceContextType,
    [
      connect,
      disconnect,
      setInputDevice,
      setOutputDevice,
      audioDeviceState,
      player.isAudioMuted,
      player.isPlaying,
      player.muteAudio,
      player.unmuteAudio,
      player.queueLength,
      player.volume,
      player.setVolume,
      mic.isMuted,
      mic.mute,
      mic.unmute,
      messageStore.messages,
      messageStore.lastVoiceMessage,
      messageStore.lastUserMessage,
      messageStore.lastAssistantProsodyMessage,
      messageStore.clearMessages,
      messageStore.chatMetadata,
      client.readyState,
      sendUserInput,
      sendAssistantInput,
      sendSessionSettings,
      pauseAssistant,
      resumeAssistant,
      sendToolMessage,
      status,
      error,
      isAudioError,
      isError,
      isMicrophoneError,
      isSocketError,
      toolStatus.store,
      isPaused,
    ],
  );

  return (
    <StoresContext.Provider value={storesCtx}>
      <VoiceContext.Provider value={ctx}>{children}</VoiceContext.Provider>
    </StoresContext.Provider>
  );
};
