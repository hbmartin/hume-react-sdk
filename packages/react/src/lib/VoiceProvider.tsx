import { type Hume } from 'hume';
import {
  createContext,
  type FC,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

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
  getBrowserErrorMessage,
  getBrowserErrorName,
  isMicrophonePermissionDeniedError,
} from '../utils/browserErrors';
import {
  type AudioContextCloseResult,
  closeAudioContextWithTimeout,
} from '../utils/closeAudioContextWithTimeout';
import { getAuthStrategyError } from './auth';
import type { ConnectionMessage } from './connection-message';
import {
  createVoiceDiagnosticsReporter,
  invokeIsolatedConsumerCallback,
  type VoiceDiagnosticsOptions,
  type VoiceDiagnosticsReporter,
} from './diagnostics';
import {
  AudioDeviceSwitchError,
  type AudioDeviceSwitchErrorReason,
  ConcurrentConnectAuthError,
  isAudioDeviceSwitchError,
} from './errors';
import {
  type FftSnapshot,
  type FftStore,
  useFftSubscription,
} from './fftStore';
import { noop } from './noop';
import { type CallDurationStore, useCallDuration } from './useCallDuration';
import { useLatestRef } from './useLatestRef';
import { useMessages } from './useMessages';
import { useMicrophone } from './useMicrophone';
import { useMicrophoneStream } from './useMicrophoneStream';
import { useSoundPlayerForVoiceProvider } from './useSoundPlayer';
import { type ToolStatusStore, useToolStatus } from './useToolStatus';
import {
  type SessionSettingsUpdate,
  type SocketCloseEvent,
  type ToolCallErrorSource,
  type ToolCallHandler,
  useVoiceClient,
  VoiceReadyState,
} from './useVoiceClient';

/** Why a socket-level failure occurred. */
export type SocketErrorReason =
  | 'socket_connection_failure'
  | 'failed_to_send_audio'
  | 'failed_to_send_message'
  | 'received_assistant_error_message'
  | 'received_tool_call_error';

/** Why assistant audio playback failed. */
export type AudioPlayerErrorReason =
  | 'audio_player_initialization_failure'
  | 'audio_worklet_load_failure'
  | 'audio_player_not_initialized'
  | 'malformed_audio'
  | 'audio_player_closure_failure';

/** Why microphone capture failed. */
export type MicErrorReason =
  | 'mic_permission_denied'
  | 'mic_initialization_failure'
  | 'mic_closure_failure'
  | 'mime_types_not_supported';

/**
 * An error that put the provider into its error state.
 *
 * `type` names the subsystem that failed and `reason` gives the specific cause
 * within it, so handlers can branch on either level of detail.
 */
export type VoiceError =
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

/**
 * Lifecycle state of the voice connection.
 *
 * Entering `error` disconnects the socket and releases the microphone, and
 * carries a human-readable `reason`.
 */
export type VoiceStatus =
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

type DisconnectDiagnosticReason = 'consumer' | 'server' | 'error' | 'unmount';

const getDeviceSwitchReason = (
  error: unknown,
): AudioDeviceSwitchErrorReason => {
  const name = getBrowserErrorName(error);
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
  const causeMessage = getBrowserErrorMessage(cause);
  const detail = causeMessage === null ? '' : ` ${causeMessage}`;
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

type ResourceCleanupTimeoutControl = Readonly<{
  expedite: () => void;
}>;

type DisconnectDiagnosticOwner = symbol;

type ForcedCleanupStep = Readonly<{
  label: string;
  run: () => void | Promise<unknown>;
}>;

type ForcedCleanupResult = Readonly<{
  failures: string[];
  stillOwnsResources: boolean;
}>;

type ForcedPlayerCleanupResult =
  | Readonly<{ status: 'fulfilled' }>
  | Readonly<{ status: 'pending' }>
  | Readonly<{ failure: unknown; status: 'rejected' }>;

const getMonotonicTime = () => globalThis.performance?.now() ?? Date.now();

const RESOURCE_CLEANUP_TIMEOUT_MS = 15_000;

const areAuthStrategiesEqual = (
  left: ConnectOptions['auth'] | null,
  right: ConnectOptions['auth'] | null | undefined,
) => left?.type === right?.type && left?.value === right?.value;

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
    const grantedDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId;
    return grantedDeviceId === undefined || grantedDeviceId === ''
      ? requestedDeviceId
      : grantedDeviceId;
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

/** Requested and active audio devices for the current voice connection. */
export interface VoiceAudioDeviceState {
  /** Requested microphone device ID, or `null` for the browser default. */
  requestedInputDeviceId: string | null;
  /** Microphone device ID actually granted by the browser. */
  activeInputDeviceId: string | null;
  /** Requested speaker device ID, or `null` for the system default. */
  requestedOutputDeviceId: string | null;
  /** Speaker device ID currently used for assistant audio. */
  activeOutputDeviceId: string | null;
}

const DISCONNECTED_AUDIO_DEVICE_STATE: VoiceAudioDeviceState = {
  requestedInputDeviceId: null,
  activeInputDeviceId: null,
  requestedOutputDeviceId: null,
  activeOutputDeviceId: null,
};

/**
 * State and controls exposed by {@link useVoice}.
 *
 * High-frequency FFT and call-duration values are available through the
 * granular subscription hooks instead of this context.
 */
export interface VoiceContextType extends VoiceAudioDeviceState {
  /**
   * Opens a voice connection and initializes its microphone and audio player.
   *
   * A call made while another attempt with the same credentials is still
   * running joins that attempt instead of starting a second set of resources,
   * and later non-auth options are ignored. A concurrent call with different
   * credentials rejects with {@link ConcurrentConnectAuthError} so refreshed
   * credentials are never silently discarded. Calling it while already
   * connected is a no-op that resolves.
   *
   * The promise resolves once the attempt settles; inspect {@link
   * VoiceContextType.status} and {@link VoiceContextType.error} to determine
   * whether the connection succeeded.
   *
   * @param options - Required authentication, connection, and session options.
   */
  connect: (options: ConnectOptions) => Promise<void>;
  /**
   * Closes the connection and releases its socket, microphone, and player.
   *
   * After cleanup completes, an explicit call clears the provider error that
   * was current when the call began and returns `status` to `disconnected`. If
   * teardown raises a newer error, that error is preserved and `status` remains
   * `error`. Calling it inside `onError` acknowledges the reported error once
   * cleanup finishes.
   */
  disconnect: () => Promise<void>;
  /**
   * Switches the microphone for an active connection.
   *
   * Requires a connected session, and may prompt for permission. Selecting an
   * explicit device that is already capturing updates the requested-device
   * state without rebuilding the recorder. Failures reject with an
   * {@link AudioDeviceSwitchError} and leave the call and current working
   * device intact.
   * Passing `null` always reacquires whichever microphone is currently the
   * browser or operating-system default, even when the requested state is
   * already `null`.
   *
   * @param deviceId - A microphone device ID, or `null` for the browser default.
   */
  setInputDevice: (deviceId: string | null) => Promise<void>;
  /**
   * Switches the speaker for an active connection.
   *
   * Does not rebuild the playback graph or clear queued audio, and selecting
   * the already-active device is a no-op. Output selection depends on the
   * browser's `AudioContext.setSinkId` support; browsers without it reject
   * non-default switches with the `unsupported` reason.
   *
   * @param deviceId - A speaker device ID, or `null` for the system default.
   */
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  /** Whether microphone input is muted. */
  isMuted: boolean;
  /** Whether assistant audio output is muted. */
  isAudioMuted: boolean;
  /** Whether assistant audio is currently playing. */
  isPlaying: boolean;
  /**
   * Stored connection and JSON messages for the current conversation.
   *
   * Interim user transcripts are excluded even when `verboseTranscription` is
   * enabled on the connection, which is the default. To observe interim
   * messages, supply an `onMessage` callback to {@link VoiceProvider}.
   */
  messages: (JSONMessage | ConnectionMessage)[];
  /** Most recent assistant transcript message, or `null` if none exists. */
  lastVoiceMessage: AssistantTranscriptMessage | null;
  /** Most recent user transcript message, or `null` if none exists. */
  lastUserMessage: UserTranscriptMessage | null;
  /** Most recent assistant prosody message, or `null` if none exists. */
  lastAssistantProsodyMessage: AssistantProsodyMessage | null;
  /** Clears the stored conversation message history. */
  clearMessages: () => void;
  /** Mutes microphone input. */
  mute: () => void;
  /** Turns microphone input back on. */
  unmute: () => void;
  /** Mutes assistant audio without changing the configured volume. */
  muteAudio: () => void;
  /** Restores assistant audio at the configured volume. */
  unmuteAudio: () => void;
  /** Current state of the underlying voice WebSocket. */
  readyState: VoiceReadyState;
  /**
   * Sends text as user input.
   *
   * @param text - User text to send to the assistant.
   */
  sendUserInput: (text: string) => void;
  /**
   * Sends text for the assistant to speak.
   *
   * @param text - Assistant text to synthesize.
   */
  sendAssistantInput: (text: string) => void;
  /**
   * Updates settings for the active session.
   *
   * @param sessionSettings - Settings without the wire-level `type` field.
   */
  sendSessionSettings: (sessionSettings: SessionSettingsUpdate) => void;
  /**
   * Sends a tool result and records a successful send in message history.
   *
   * @param type - Tool response or tool error to send.
   */
  sendToolMessage: (
    type:
      | Hume.empathicVoice.ToolResponseMessage
      | Hume.empathicVoice.ToolErrorMessage,
  ) => void;
  /** Pauses assistant responses while preserving conversation history. */
  pauseAssistant: () => void;
  /** Resumes assistant responses after a pause. */
  resumeAssistant: () => void;
  /** Combined lifecycle status for the voice connection and audio resources. */
  status: VoiceStatus;
  /** Current voice error, or `null` when no error is active. */
  error: VoiceError | null;
  /** Whether the current error originated from assistant audio playback. */
  isAudioError: boolean;
  /** Whether any voice error is currently active. */
  isError: boolean;
  /** Whether the current error originated from microphone capture. */
  isMicrophoneError: boolean;
  /** Whether the current error originated from the voice socket. */
  isSocketError: boolean;
  /** Tool calls and their resolved responses, keyed by tool-call ID. */
  toolStatusStore: ToolStatusStore;
  /** Metadata for the current chat, or `null` before metadata is received. */
  chatMetadata: ChatMetadataMessage | null;
  /** Number of queued assistant clips, including the currently playing clip. */
  playerQueueLength: number;
  /** Whether assistant responses are currently paused. */
  isPaused: boolean;
  /** Configured assistant playback volume from `0` to `1`. */
  volume: number;
  /**
   * Sets assistant playback volume without changing mute state.
   *
   * @param level - Desired level; values are clamped to the range `0` to `1`.
   */
  setVolume: (level: number) => void;
}

const VoiceContext = createContext<VoiceContextType | null>(null);

/** Configuration and lifecycle callbacks accepted by {@link VoiceProvider}. */
export interface VoiceProviderProps extends PropsWithChildren {
  /**
   * Called for every message received over the socket.
   *
   * Locally sent tool responses and tool errors are also emitted here once
   * they reach the socket, so they stay in sync with `messages` and
   * `toolStatusStore`.
   */
  onMessage?: (message: JSONMessage) => void;
  /**
   * Called whenever the provider enters an error state.
   *
   * Inspect `err.type` to distinguish socket, microphone, and audio playback
   * failures, and `err.reason` for the specific cause within that category.
   */
  onError?: (err: VoiceError) => void;
  /** Called when the voice socket opens. */
  onOpen?: () => void;
  /**
   * Called when the voice socket closes.
   *
   * Delayed close events from superseded connection attempts are ignored so
   * they cannot be mistaken for the current connection closing.
   */
  onClose?: Hume.empathicVoice.chat.ChatSocket.EventHandlers['close'];
  /**
   * Called when the assistant requests a tool call.
   *
   * The string it returns becomes the content of the tool response sent back
   * to the assistant. Handle custom tools here.
   */
  onToolCall?: ToolCallHandler;
  /** Called when an audio output message arrives from the socket. */
  onAudioReceived?: (audioOutputMessage: AudioOutputMessage) => void;
  /**
   * Called when an assistant audio clip begins playing.
   *
   * @param clipId - Identifier of the clip that started.
   */
  onAudioStart?: (clipId: string) => void;
  /**
   * Called when an assistant audio clip finishes playing.
   *
   * @param clipId - Identifier of the clip that ended.
   */
  onAudioEnd?: (clipId: string) => void;
  /** Called when microphone recording starts. */
  onStartRecording?: () => void;
  /** Called when microphone recording stops. */
  onStopRecording?: () => void;
  /** Called when the user interrupts the assistant. */
  onInterruption?: (message: UserInterruptionMessage) => void;
  /**
   * Clear messages when the voice is disconnected. Defaults to `true`.
   */
  clearMessagesOnDisconnect?: boolean;
  /**
   * The maximum number of messages to keep in memory. Defaults to `100`.
   */
  messageHistoryLimit?: number;
  /**
   * Selects the audio player implementation. `AudioWorklet` gives the best
   * playback quality on most browsers, but performs poorly on Safari 17; set
   * this to `false` there to fall back to the `AudioBuffer` player.
   * Defaults to `true`.
   */
  enableAudioWorklet?: boolean;
  /**
   * Configure structured SDK diagnostics. By default, sanitized warnings and
   * errors are written to the browser console. Pass `false` to disable them.
   */
  diagnostics?: false | VoiceDiagnosticsOptions;
}

/**
 * Returns voice state and controls from the nearest {@link VoiceProvider}.
 *
 * Use the granular FFT and call-duration hooks for high-frequency values.
 */
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

/**
 * Subscribes to live frequency data for assistant audio playback.
 *
 * @returns The current assistant-audio FFT snapshot.
 */
export const usePlayerFft = (): FftSnapshot => {
  const ctx = useContext(StoresContext);
  if (!ctx) {
    throw new Error('usePlayerFft must be used within a VoiceProvider');
  }
  return useFftSubscription(ctx.playerFftStore);
};

/**
 * Subscribes to live frequency data for microphone input.
 *
 * @returns The current microphone FFT snapshot.
 */
export const useMicFft = (): FftSnapshot => {
  const ctx = useContext(StoresContext);
  if (!ctx) {
    throw new Error('useMicFft must be used within a VoiceProvider');
  }
  return useFftSubscription(ctx.micFftStore);
};

/**
 * Subscribes to the formatted duration of the current or most recent call.
 *
 * @returns A formatted duration, or `null` before a call has started.
 */
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

/**
 * Provides the EVI socket, microphone, audio playback queue, and message
 * history to descendant components, which read them through {@link useVoice}.
 *
 * The provider does not connect on mount. Browsers require a user gesture to
 * start an `AudioContext`, so call `connect` from an event handler such as a
 * button click rather than from an effect.
 *
 * @example
 * ```tsx
 * <VoiceProvider onError={(error) => console.error(error.reason)}>
 *   <YourVoiceUI />
 * </VoiceProvider>
 * ```
 */
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
  const microphoneFlushOwnerRef = useRef<symbol | null>(null);
  const resourceCleanupCompletedRef = useRef(true);
  const lifecycleGenerationRef = useRef(0);
  const currentConnectionGenerationRef = useRef<number | null>(null);
  const pendingResourceCleanupsRef = useRef(new Set<Promise<unknown>>());
  const pendingResourceCleanupTimeoutsRef = useRef(
    new Set<ResourceCleanupTimeoutControl>(),
  );
  const pendingDisconnectCleanupRef = useRef<Promise<void> | null>(null);
  const pendingDisconnectCleanupOwnerRef = useRef<symbol | null>(null);
  const resourceCleanupAdoptionOwnersRef = useRef(
    new WeakMap<Promise<unknown>, symbol>(),
  );
  const activeConnectPromiseRef = useRef<Promise<void> | null>(null);
  const activeConnectAuthRef = useRef<ConnectOptions['auth'] | null>(null);
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
    async (
      context = sharedAudioContextRef.current,
    ): Promise<AudioContextCloseResult | null> => {
      if (!context) {
        return null;
      }
      let closePromise =
        sharedAudioContextClosePromisesRef.current.get(context);
      if (!closePromise) {
        closePromise = closeAudioContextWithTimeout(context);
        sharedAudioContextClosePromisesRef.current.set(context, closePromise);
      }
      const closeResult = await closePromise;
      const contextIsClosed = context.state === 'closed';
      if (
        (closeResult.success || contextIsClosed) &&
        sharedAudioContextRef.current === context
      ) {
        sharedAudioContextRef.current = null;
      } else if (!closeResult.success && closeResult.reason === 'rejected') {
        // A genuine rejection can be transient. Let a later teardown retry it;
        // unlike a timeout, no still-pending close operation can recover it.
        sharedAudioContextClosePromisesRef.current.delete(context);
      }
      // AudioContext.close() changes the control state to closed before its
      // promise settles, so a second close cannot recover from a timeout. Keep
      // timed-out work cached and observe a later public `closed` state.
      return contextIsClosed ? { success: true } : closeResult;
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
  const markAllResourcesDisconnected = useCallback(() => {
    resourceStatusRef.current = {
      mic: 'disconnected',
      audioPlayer: 'disconnected',
      socket: 'disconnected',
    };
  }, []);

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
  const trackResourceCleanup = useCallback(
    <Result,>(
      cleanup: Promise<Result>,
      resource: string,
      timeoutResult: () => Result | Promise<Result>,
      onSettled?: (cleanup: Promise<Result>) => void,
    ): Promise<Result> => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const trackedCleanup = new Promise<Result>((resolve, reject) => {
        const timeoutControl: ResourceCleanupTimeoutControl = {
          expedite: () => {
            if (settled) return;
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            timeoutId = setTimeout(runTimeout, 0);
          },
        };
        function runTimeout() {
          if (settled) return;
          settled = true;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          pendingResourceCleanupTimeoutsRef.current.delete(timeoutControl);
          try {
            diagnostics.emit({
              level: 'error',
              category: 'connection',
              name: 'resource.cleanup_failed',
              details: {
                resource,
                message: `Resource cleanup exceeded ${RESOURCE_CLEANUP_TIMEOUT_MS} ms.`,
              },
            });
            void Promise.resolve(timeoutResult()).then(resolve, reject);
          } catch (cleanupError) {
            reject(cleanupError);
          }
        }
        void cleanup.then(
          (result) => {
            if (settled) return;
            settled = true;
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            pendingResourceCleanupTimeoutsRef.current.delete(timeoutControl);
            resolve(result);
          },
          (cleanupError: unknown) => {
            if (settled) return;
            settled = true;
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            pendingResourceCleanupTimeoutsRef.current.delete(timeoutControl);
            reject(cleanupError);
          },
        );
        pendingResourceCleanupTimeoutsRef.current.add(timeoutControl);
        timeoutId = setTimeout(runTimeout, RESOURCE_CLEANUP_TIMEOUT_MS);
      });
      pendingResourceCleanupsRef.current.add(trackedCleanup);
      const clearCleanup = () => {
        pendingResourceCleanupsRef.current.delete(trackedCleanup);
        onSettled?.(trackedCleanup);
      };
      void trackedCleanup.then(clearCleanup, clearCleanup);
      return trackedCleanup;
    },
    [diagnostics],
  );
  const disconnectDiagnosticRef = useRef<{
    token: symbol;
    owner: DisconnectDiagnosticOwner;
    reason: 'consumer' | 'server' | 'error' | 'unmount';
    startedAt: number;
    cleanupFailures: string[];
  } | null>(null);

  const beginDisconnectDiagnostic = useCallback(
    (
      reason: 'consumer' | 'server' | 'error' | 'unmount',
      owner: DisconnectDiagnosticOwner,
    ) => {
      const pending = disconnectDiagnosticRef.current;
      if (pending !== null) {
        // A teardown adopting pending resource cleanup becomes the only flow
        // allowed to publish the terminal diagnostic for this disconnect.
        pending.owner = owner;
        return pending.token;
      }
      const token = Symbol('disconnect-diagnostic');
      disconnectDiagnosticRef.current = {
        token,
        owner,
        reason,
        startedAt: getMonotonicTime(),
        cleanupFailures: [],
      };
      diagnostics.emit({
        level: 'info',
        category: 'connection',
        name: 'connection.disconnect_started',
        details: { reason },
      });
      return token;
    },
    [diagnostics],
  );

  const completeDisconnectDiagnostic = useCallback(
    (
      token: symbol,
      owner: DisconnectDiagnosticOwner,
      cleanupFailures: readonly string[] = [],
    ) => {
      const pending = disconnectDiagnosticRef.current;
      if (pending === null || pending.token !== token) {
        return;
      }
      for (const cleanupFailure of cleanupFailures) {
        if (!pending.cleanupFailures.includes(cleanupFailure)) {
          pending.cleanupFailures.push(cleanupFailure);
        }
      }
      if (pending.owner !== owner) return;
      const accumulatedCleanupFailures = pending.cleanupFailures;
      diagnostics.emit({
        level: accumulatedCleanupFailures.length > 0 ? 'warn' : 'info',
        category: 'connection',
        name: 'connection.disconnected',
        durationMs: getMonotonicTime() - pending.startedAt,
        details: {
          reason: pending.reason,
          cleanupFailureCount: accumulatedCleanupFailures.length,
          ...(accumulatedCleanupFailures.length > 0
            ? { cleanupFailures: [...accumulatedCleanupFailures] }
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
        ...(err === undefined ? {} : { error: err }),
      });
    },
    [stopTimer, updateError],
  );

  const micStopFnRef = useRef<null | (() => Promise<void>)>(null);

  const player = useSoundPlayerForVoiceProvider({
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
  const stopOwnedMicrophoneStreams = useCallback(() => {
    try {
      stopStream();
    } catch (firstFailure) {
      try {
        stopStream();
      } catch (retryFailure) {
        const firstDetail =
          getBrowserErrorMessage(firstFailure) ?? 'Unknown error';
        const retryDetail =
          getBrowserErrorMessage(retryFailure) ?? 'Unknown error';
        throw new Error(`${firstDetail}; cleanup retry failed: ${retryDetail}`);
      }
    }
  }, [stopStream]);

  const runForcedCleanup = useCallback(
    async (
      timeoutMessage: string,
      context: AudioContext | null,
      steps: readonly ForcedCleanupStep[],
      stillOwnsResources: () => boolean,
    ): Promise<ForcedCleanupResult> => {
      const failures = [timeoutMessage];
      const runStep = async (step: ForcedCleanupStep) => {
        if (!stillOwnsResources()) return;
        try {
          await step.run();
        } catch (failure) {
          failures.push(
            `${step.label}: ${getBrowserErrorMessage(failure) ?? 'Unknown error'}`,
          );
        }
      };

      for (const step of steps) {
        await runStep(step);
      }
      if (context) {
        if (stillOwnsResources()) {
          // The normal cleanup may already be stalled inside this exact stop
          // promise. Give it a microtask checkpoint to settle, then force
          // context closure without losing incomplete teardown from the report.
          let playerCleanup: Promise<ForcedPlayerCleanupResult>;
          try {
            playerCleanup = Promise.resolve(
              playerStopAllForContext(context),
            ).then(
              (): ForcedPlayerCleanupResult => ({ status: 'fulfilled' }),
              (failure: unknown): ForcedPlayerCleanupResult => ({
                failure,
                status: 'rejected',
              }),
            );
          } catch (failure) {
            playerCleanup = Promise.resolve({
              failure,
              status: 'rejected',
            });
          }
          await Promise.resolve();
          const playerResult = await Promise.race<ForcedPlayerCleanupResult>([
            playerCleanup,
            Promise.resolve({ status: 'pending' }),
          ]);
          if (playerResult.status === 'rejected') {
            failures.push(
              `Audio player cleanup failed: ${getBrowserErrorMessage(playerResult.failure) ?? 'Unknown error'}`,
            );
          } else if (playerResult.status === 'pending') {
            failures.push(
              'Audio player cleanup failed: cleanup did not settle before forced context closure.',
            );
          }
        }
        await runStep({
          label: 'Shared audio context cleanup failed',
          run: async () => {
            const closeResult = await closeSharedAudioContext(context);
            if (closeResult && !closeResult.success) {
              throw closeResult.error;
            }
          },
        });
      }

      return {
        failures,
        stillOwnsResources: stillOwnsResources(),
      };
    },
    [closeSharedAudioContext, playerStopAllForContext],
  );

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
            ...(err === undefined ? {} : { error: err }),
          });
          return;
        }
        const voiceError: VoiceError = {
          type: 'socket_error',
          reason: 'received_tool_call_error',
          message,
          ...(err === undefined ? {} : { error: err }),
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
        _consumerInitiated: boolean,
        connectionGeneration: number,
      ) => {
        const currentConnectionGeneration =
          currentConnectionGenerationRef.current;
        const publishDisconnectMessage = () => {
          if (!clearMessagesOnDisconnect) {
            createDisconnectMessage(event);
          }
        };
        const publishCloseCallback = () => {
          invokeIsolatedConsumerCallback(diagnostics, 'onClose', () =>
            onClose.current?.(event),
          );
        };
        if (
          currentConnectionGeneration === null ||
          connectionGeneration !== currentConnectionGeneration
        ) {
          // A superseded socket cannot publish lifecycle callbacks for the
          // provider's current connection.
          return;
        }
        currentConnectionGenerationRef.current = null;

        if (!isCurrentLifecycleGeneration(connectionGeneration)) {
          if (isConnectingRef.current) {
            return;
          }
          publishDisconnectMessage();
          publishCloseCallback();
          return;
        }

        const closeGeneration = ++lifecycleGenerationRef.current;
        // A reconnect requested by onClose must start a new attempt instead of
        // joining the connect promise invalidated by this server close.
        activeConnectPromiseRef.current = null;
        activeConnectAuthRef.current = null;
        // Diagnostics are delivered synchronously. Publish a state that permits
        // reconnecting before beginning the disconnect diagnostic so a listener
        // can safely call connect(). The deferred attempt joins cleanup below.
        isConnectingRef.current = false;
        resourceStatusRef.current.socket = 'disconnected';
        const closeDiagnosticOwner = Symbol('server-close-diagnostic');
        const disconnectDiagnosticToken = beginDisconnectDiagnostic(
          'server',
          closeDiagnosticOwner,
        );
        let trackedCloseCleanup: Promise<void> | null = null;
        const closeCleanupStillOwnsResources = () => {
          if (isCurrentLifecycleGeneration(closeGeneration)) return true;
          const disconnectOwner = pendingDisconnectCleanupOwnerRef.current;
          return (
            trackedCloseCleanup !== null &&
            disconnectOwner !== null &&
            resourceCleanupAdoptionOwnersRef.current.get(
              trackedCloseCleanup,
            ) === disconnectOwner
          );
        };
        const sharedContextToClose = sharedAudioContextRef.current;
        // onClose handler needs to handle resource cleanup in the event that the
        // websocket connection is closed by the server and not the user/client
        stopTimer();
        activeAudioConstraintsRef.current = null;
        resetAudioDeviceState();

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
        let microphoneStreamStopped = false;
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
              failures.push(getBrowserErrorMessage(failure) ?? 'Unknown error');
            }
          }
          if (closeCleanupStillOwnsResources()) {
            try {
              stopOwnedMicrophoneStreams();
              microphoneStreamStopped = true;
            } catch (failure) {
              failures.push(getBrowserErrorMessage(failure) ?? 'Unknown error');
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
                  getBrowserErrorMessage(result.reason) ??
                    'Unknown cleanup error',
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
          completeDisconnectDiagnostic(
            disconnectDiagnosticToken,
            closeDiagnosticOwner,
            cleanupFailures,
          );
        });
        trackedCloseCleanup = trackResourceCleanup(
          closeCleanup,
          'server_close',
          async () => {
            const timeoutMessage = `Server-close cleanup exceeded ${RESOURCE_CLEANUP_TIMEOUT_MS} ms.`;
            const forcedCleanup = await runForcedCleanup(
              timeoutMessage,
              sharedContextToClose,
              microphoneStreamStopped
                ? []
                : [
                    {
                      label: 'Microphone stream cleanup failed',
                      run: () => {
                        stopOwnedMicrophoneStreams();
                        microphoneStreamStopped = true;
                      },
                    },
                  ],
              closeCleanupStillOwnsResources,
            );
            if (forcedCleanup.stillOwnsResources) {
              markAllResourcesDisconnected();
              resourceCleanupCompletedRef.current = false;
            }
            completeDisconnectDiagnostic(
              disconnectDiagnosticToken,
              closeDiagnosticOwner,
              forcedCleanup.failures,
            );
          },
        );
        publishDisconnectMessage();
        publishCloseCallback();
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
        runForcedCleanup,
        setDisconnectedStatus,
        setErrorStatus,
        isCurrentLifecycleGeneration,
        markAllResourcesDisconnected,
        stopOwnedMicrophoneStreams,
        stopTimer,
        toolStatusClearStore,
        trackResourceCleanup,
      ],
    ),
    ...(props.onToolCall === undefined ? {} : { onToolCall: props.onToolCall }),
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
    ...(props.onStartRecording === undefined
      ? {}
      : { onStartRecording: props.onStartRecording }),
    ...(props.onStopRecording === undefined
      ? {}
      : { onStopRecording: props.onStopRecording }),
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
          const message = getBrowserErrorMessage(e) ?? 'Unknown error';
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
          const stopCandidateStream = () => {
            try {
              stopStream(candidateStream);
            } catch (cleanupError) {
              diagnostics.emit({
                level: 'warn',
                category: 'microphone',
                name: 'resource.cleanup_failed',
                details: {
                  resource: 'microphone',
                  message:
                    'Failed to release an uncommitted input-device stream.',
                  error: cleanupError,
                },
              });
            }
          };
          if (!isCurrent()) {
            stopCandidateStream();
            throw createDeviceSwitchError('audioinput', 'interrupted');
          }

          try {
            await micReplace(candidateStream, sharedContext);
          } catch (cause) {
            stopCandidateStream();
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
      const message = getBrowserErrorMessage(e) ?? 'Unknown error';
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
      const message = getBrowserErrorMessage(e) ?? 'Unknown error';
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

  const connectAttempt = useCallback(
    async (options: ConnectOptions, connectRequestGeneration: number) => {
      const {
        audioConstraints = {},
        sessionSettings,
        devices,
        ...socketConfig
      } = options;
      if (!isCurrentLifecycleGeneration(connectRequestGeneration)) {
        diagnostics.emit({
          level: 'info',
          category: 'connection',
          name: 'connection.attempt_cancelled',
          details: { phase: 'scheduled' },
        });
        return;
      }
      const pendingCleanups = [...pendingResourceCleanupsRef.current];
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
        ...(devices?.microphoneDeviceId === undefined
          ? {}
          : { deviceId: devices.microphoneDeviceId }),
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
        const isPermissionDeniedError = isMicrophonePermissionDeniedError(e);
        const voiceError: VoiceError = {
          type: 'mic_error',
          reason: isPermissionDeniedError
            ? 'mic_permission_denied'
            : 'mic_initialization_failure',
          message:
            getBrowserErrorMessage(e) ??
            'The microphone could not be initialized.',
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
          return null;
        } catch (cleanupError) {
          const detail =
            getBrowserErrorMessage(cleanupError) ?? 'Unknown error';
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
          return `${failureMessage} ${detail}`;
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
        markAllResourcesDisconnected();
        isConnectingRef.current = false;
        updateError({
          type: 'audio_error',
          reason: 'audio_player_initialization_failure',
          message:
            getBrowserErrorMessage(e) ??
            'We could not create an audio context. Please try again.',
        });
        return;
      }
      sharedAudioContextRef.current = sharedCtx;

      const cleanupAttemptResources = (stopPlayer: boolean) => {
        const cleanup = (async () => {
          const failures: string[] = [];
          const streamFailure = stopCapturedStream(
            'Failed to stop a canceled connection microphone stream.',
          );
          if (streamFailure !== null) {
            failures.push(streamFailure);
          }
          if (stopPlayer) {
            try {
              await playerStopAllForContext(sharedCtx);
            } catch (cleanupError) {
              failures.push(
                `Audio player cleanup failed: ${getBrowserErrorMessage(cleanupError) ?? 'Unknown error'}`,
              );
            }
          }
          const closeResult = await closeSharedAudioContext(sharedCtx);
          if (closeResult && !closeResult.success) {
            failures.push(
              `Shared audio context cleanup failed: ${closeResult.error.message}`,
            );
          }
          if (failures.length > 0) {
            diagnostics.emit({
              level: 'warn',
              category: 'connection',
              name: 'resource.cleanup_failed',
              details: {
                resource: 'connection_attempt',
                message: 'Failed to fully clean up a voice connection attempt.',
                failures,
              },
            });
          }
          return failures;
        })();
        return trackResourceCleanup(cleanup, 'connection_attempt', () => [
          `Connection attempt cleanup exceeded ${RESOURCE_CLEANUP_TIMEOUT_MS} ms.`,
        ]);
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
        const initializationError: VoiceError = {
          type: 'audio_error',
          reason: 'audio_player_initialization_failure',
          message:
            getBrowserErrorMessage(e) ??
            'We could not connect to the audio player. Please try again.',
        };
        // Keep this attempt exclusive until its scoped cleanup settles. The
        // disconnected socket also suppresses cleanup errors from replacing the
        // initialization failure.
        resourceStatusRef.current.socket = 'disconnected';
        resourceStatusRef.current.audioPlayer = 'disconnecting';
        resourceStatusRef.current.mic = 'disconnecting';
        const cleanupFailures = await cleanupAttemptResources(true);
        if (!checkShouldContinueConnecting(generation)) {
          return;
        }
        markAllResourcesDisconnected();
        isConnectingRef.current = false;
        resourceCleanupCompletedRef.current = cleanupFailures.length === 0;
        updateError(initializationError);
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
        resourceStatusRef.current.socket = 'disconnected';
        resourceStatusRef.current.audioPlayer = 'disconnecting';
        resourceStatusRef.current.mic = 'disconnecting';
        const cleanupFailures = await cleanupAttemptResources(true);
        if (!checkShouldContinueConnecting(generation)) {
          return;
        }
        markAllResourcesDisconnected();
        isConnectingRef.current = false;
        resourceCleanupCompletedRef.current = cleanupFailures.length === 0;
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
        currentConnectionGenerationRef.current = generation;
        await clientConnect(
          {
            ...socketConfig,
            verboseTranscription: socketConfig.verboseTranscription ?? true,
          },
          sessionSettings,
          generation,
        );
      } catch {
        // catching the thrown error here so we can return early from the connect function.
        // Any errors themselves are handled in the `onClientError` callback on the client,
        // except for the AbortController case, which we don't need to call onClientError for
        // because cancellations are intentional, and not network errors.
        const connectionIsCurrent = checkShouldContinueConnecting(generation);
        if (!connectionIsCurrent) {
          return;
        }
        if (currentConnectionGenerationRef.current === generation) {
          currentConnectionGenerationRef.current = null;
        }
        // Publish teardown state before stopping the player so cleanup failures
        // cannot replace the connection failure with a new user-facing error.
        resourceStatusRef.current.socket = 'disconnected';
        resourceStatusRef.current.audioPlayer = 'disconnecting';
        resourceStatusRef.current.mic = 'disconnecting';
        const cleanupFailures = await cleanupAttemptResources(true);
        if (!checkShouldContinueConnecting(generation)) {
          return;
        }
        markAllResourcesDisconnected();
        isConnectingRef.current = false;
        resourceCleanupCompletedRef.current = cleanupFailures.length === 0;
        const connectionError = errorSnapshotRef.current.error;
        if (connectionError === null) {
          setDisconnectedStatus();
        } else {
          setErrorStatus(connectionError);
        }
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
            getBrowserErrorMessage(e) ??
            'We could not connect to the microphone. Please try again.',
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
      markAllResourcesDisconnected,
      micStart,
      playerInitPlayer,
      playerStopAllForContext,
      publishInputDeviceState,
      publishOutputDeviceState,
      resetAudioDeviceState,
      setDisconnectedStatus,
      setErrorStatus,
      stopStream,
      trackResourceCleanup,
      updateError,
    ],
  );

  // `disconnectAndCleanUpResources`: Internal function that is called to actually disconnect
  // from the socket, audio player, and microphone.
  const disconnectAndCleanUpResources = useCallback(
    (diagnosticReason: DisconnectDiagnosticReason = 'consumer') => {
      const invalidateLifecycle = () => {
        lifecycleGenerationRef.current += 1;
        isConnectingRef.current = false;
        // A later lifecycle may start once it joins the registered teardown;
        // the superseded connect promise still settles for its original caller.
        activeConnectPromiseRef.current = null;
        activeConnectAuthRef.current = null;
      };
      const existingCleanup = pendingDisconnectCleanupRef.current;
      if (existingCleanup) {
        // A later consumer disconnect or unmount cancels work queued behind the
        // existing teardown. The error effect merely joins teardown started by
        // the same error and must not supersede an explicit acknowledgement.
        if (diagnosticReason !== 'error') {
          invalidateLifecycle();
        }
        return existingCleanup;
      }

      const connectionWasInProgress = isConnectingRef.current;
      // Every new teardown invalidates work issued before it, including a
      // connect waiting for an earlier cleanup promise to settle.
      invalidateLifecycle();

      const cleanupsToAwait = [...pendingResourceCleanupsRef.current];
      if (
        cleanupsToAwait.length === 0 &&
        resourceCleanupCompletedRef.current &&
        areAllResourcesDisconnected() &&
        !connectionWasInProgress &&
        sharedAudioContextRef.current === null
      ) {
        return Promise.resolve();
      }

      const audioPlayerWasConnected =
        resourceStatusRef.current.audioPlayer === 'connected';
      const cleanupGeneration = lifecycleGenerationRef.current;
      const cleanupOwner = Symbol('disconnect-cleanup');
      for (const pendingCleanup of cleanupsToAwait) {
        resourceCleanupAdoptionOwnersRef.current.set(
          pendingCleanup,
          cleanupOwner,
        );
      }
      const disconnectDiagnosticToken = beginDisconnectDiagnostic(
        diagnosticReason,
        cleanupOwner,
      );
      const sharedContextToClose = sharedAudioContextRef.current;
      const microphoneFlushOwner = Symbol('microphone-flush');
      const failures: string[] = [];
      let cleanupTimedOut = false;
      let lifecycleFinalized = false;

      // Invalidate connection attempts and device switches synchronously. A
      // pending close cleanup may still finish its captured resources, but no
      // later connection may begin asynchronous initialization for this owner.
      if (resourceStatusRef.current.socket !== 'disconnected') {
        resourceStatusRef.current.socket = 'disconnecting';
      }
      if (resourceStatusRef.current.audioPlayer !== 'disconnected') {
        resourceStatusRef.current.audioPlayer = 'disconnecting';
      }
      if (resourceStatusRef.current.mic !== 'disconnected') {
        resourceStatusRef.current.mic = 'disconnecting';
      }
      let cleanup: Promise<void> | null = null;
      const cleanupStillOwnsLifecycle = () =>
        isCurrentLifecycleGeneration(cleanupGeneration) ||
        pendingDisconnectCleanupOwnerRef.current === cleanupOwner;
      const rawCleanupStillOwnsLifecycle = () =>
        !cleanupTimedOut && cleanupStillOwnsLifecycle();
      const recordFailure = (label: string, failure: unknown) => {
        const detail = getBrowserErrorMessage(failure) ?? 'Unknown error';
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
      const releaseMicrophoneFlush = () => {
        if (microphoneFlushOwnerRef.current === microphoneFlushOwner) {
          microphoneFlushOwnerRef.current = null;
          isFlushingMicrophoneRef.current = false;
        }
      };
      const finalizeLifecycle = () => {
        if (lifecycleFinalized || !cleanupStillOwnsLifecycle()) return;
        lifecycleFinalized = true;
        releaseMicrophoneFlush();
        isConnectingRef.current = false;
        markAllResourcesDisconnected();
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
        completeDisconnectDiagnostic(
          disconnectDiagnosticToken,
          cleanupOwner,
          failures,
        );
      };
      const rawCleanup = (async () => {
        if (cleanupsToAwait.length > 0) {
          await Promise.allSettled(cleanupsToAwait);
          if (!rawCleanupStillOwnsLifecycle()) return;
        }

        if (
          resourceCleanupCompletedRef.current &&
          areAllResourcesDisconnected() &&
          sharedAudioContextRef.current === null
        ) {
          completeDisconnectDiagnostic(disconnectDiagnosticToken, cleanupOwner);
          return;
        }

        try {
          microphoneFlushOwnerRef.current = microphoneFlushOwner;
          isFlushingMicrophoneRef.current = true;

          await attempt('Call timer cleanup failed', stopTimer);
          if (!rawCleanupStillOwnsLifecycle()) return;

          // Keep the socket connected until MediaRecorder has delivered its final
          // dataavailable payload, then release the underlying stream.
          await attempt('Microphone cleanup failed', micStop);
          if (!rawCleanupStillOwnsLifecycle()) return;
          releaseMicrophoneFlush();
          await attempt(
            'Microphone stream cleanup failed',
            stopOwnedMicrophoneStreams,
          );
          if (!rawCleanupStillOwnsLifecycle()) return;

          // Shut down the websocket before the audio player.
          if (clientReadyStateRef.current !== VoiceReadyState.CLOSED) {
            await attempt('Websocket cleanup failed', clientDisconnect);
            if (!rawCleanupStillOwnsLifecycle()) return;
          }

          // Scope teardown to the context owned when this cleanup began so it can
          // never stop a later player's resources.
          if (sharedContextToClose) {
            await attempt('Audio player cleanup failed', () =>
              playerStopAllForContext(sharedContextToClose),
            );
            if (!rawCleanupStillOwnsLifecycle()) return;
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
            if (!rawCleanupStillOwnsLifecycle()) return;
          }
        } finally {
          releaseMicrophoneFlush();
          if (rawCleanupStillOwnsLifecycle()) {
            finalizeLifecycle();
          }
        }
      })();

      cleanup = trackResourceCleanup(
        rawCleanup,
        'connection',
        async () => {
          cleanupTimedOut = true;
          releaseMicrophoneFlush();
          const forcedCleanup = await runForcedCleanup(
            `Connection cleanup exceeded ${RESOURCE_CLEANUP_TIMEOUT_MS} ms.`,
            sharedContextToClose,
            [
              { label: 'Call timer cleanup failed', run: stopTimer },
              {
                label: 'Microphone stream cleanup failed',
                run: stopOwnedMicrophoneStreams,
              },
              ...(clientReadyStateRef.current !== VoiceReadyState.CLOSED
                ? [
                    {
                      label: 'Websocket cleanup failed',
                      run: clientDisconnect,
                    },
                  ]
                : []),
            ],
            cleanupStillOwnsLifecycle,
          );
          failures.push(...forcedCleanup.failures);
          if (forcedCleanup.stillOwnsResources) {
            finalizeLifecycle();
          }
        },
        (settledCleanup) => {
          if (pendingDisconnectCleanupRef.current === settledCleanup) {
            pendingDisconnectCleanupRef.current = null;
          }
          if (pendingDisconnectCleanupOwnerRef.current === cleanupOwner) {
            pendingDisconnectCleanupOwnerRef.current = null;
          }
          for (const pendingCleanup of cleanupsToAwait) {
            if (
              resourceCleanupAdoptionOwnersRef.current.get(pendingCleanup) ===
              cleanupOwner
            ) {
              resourceCleanupAdoptionOwnersRef.current.delete(pendingCleanup);
            }
          }
        },
      );
      pendingDisconnectCleanupRef.current = cleanup;
      pendingDisconnectCleanupOwnerRef.current = cleanupOwner;
      return cleanup;
    },
    [
      beginDisconnectDiagnostic,
      areAllResourcesDisconnected,
      completeDisconnectDiagnostic,
      diagnostics,
      isCurrentLifecycleGeneration,
      markAllResourcesDisconnected,
      stopTimer,
      stopOwnedMicrophoneStreams,
      micStop,
      clientReadyStateRef,
      clientDisconnect,
      closeSharedAudioContext,
      playerStopAllForContext,
      resetAudioDeviceState,
      runForcedCleanup,
      trackResourceCleanup,
      clearMessagesOnDisconnect,
      clearMessageStore,
      toolStatusClearStore,
    ],
  );
  const disconnectAndCleanUpResourcesRef = useLatestRef(
    disconnectAndCleanUpResources,
  );

  const connect = useCallback(
    (options: ConnectOptions) => {
      const activeConnect = activeConnectPromiseRef.current;
      const alreadyConnecting =
        activeConnect !== null || isConnectingRef.current;
      const alreadyConnected = resourceStatusRef.current.socket === 'connected';
      if (alreadyConnecting) {
        if (
          activeConnect !== null &&
          !areAuthStrategiesEqual(activeConnectAuthRef.current, options.auth)
        ) {
          diagnostics.emit({
            level: 'warn',
            category: 'connection',
            name: 'connection.attempt_ignored',
            details: { reason: 'auth_conflict' },
          });
          return Promise.reject(new ConcurrentConnectAuthError());
        }
        diagnostics.emit({
          level: 'warn',
          category: 'connection',
          name: 'connection.attempt_ignored',
          details: { reason: 'already_connecting' },
        });
        if (activeConnect === null) {
          return Promise.reject(
            new Error(
              'Voice connection state is inconsistent: an active attempt has no joinable promise.',
            ),
          );
        }
        return activeConnect;
      }
      if (alreadyConnected) {
        diagnostics.emit({
          level: 'warn',
          category: 'connection',
          name: 'connection.attempt_ignored',
          details: { reason: 'already_connected' },
        });
        return Promise.resolve();
      }

      // Defer the attempt by one microtask so this ownership marker is installed
      // before diagnostics or browser APIs can synchronously reenter connect().
      const connectRequestGeneration = lifecycleGenerationRef.current;
      const connecting = Promise.resolve().then(() =>
        connectAttempt(options, connectRequestGeneration),
      );
      activeConnectPromiseRef.current = connecting;
      activeConnectAuthRef.current = { ...options.auth };
      const clearConnect = () => {
        if (activeConnectPromiseRef.current !== connecting) return;
        if (isConnectingRef.current) {
          void disconnectAndCleanUpResourcesRef.current('error');
          return;
        }
        activeConnectPromiseRef.current = null;
        activeConnectAuthRef.current = null;
      };
      void connecting.then(clearConnect, clearConnect);
      return connecting;
    },
    [connectAttempt, diagnostics, disconnectAndCleanUpResourcesRef],
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

  useEffect(() => {
    if (error !== null) {
      setErrorStatus(error);
      void disconnectAndCleanUpResources('error');
    }
  }, [disconnectAndCleanUpResources, error, setErrorStatus]);

  useEffect(() => {
    const cleanupTimeouts = pendingResourceCleanupTimeoutsRef.current;
    // disconnect from socket when the voice provider component unmounts
    return () => {
      // Only accelerate cleanup that was already pending before unmount. The
      // teardown created below retains its normal bounded grace period.
      const preexistingCleanupTimeouts = [...cleanupTimeouts];
      // Intentionally read the latest cleanup callback when unmount begins.
      // oxlint-disable-next-line react/exhaustive-deps -- lifecycle callbacks are tracked through refs
      const cleanup = disconnectAndCleanUpResourcesRef.current('unmount');
      // Preexisting stalled work must not retain its old timer after the
      // provider is gone; its backstop runs on the next task.
      for (const timeoutControl of preexistingCleanupTimeouts) {
        timeoutControl.expedite();
      }
      // Cleanup invalidates its lifecycle synchronously before returning.
      const unmountGeneration = lifecycleGenerationRef.current;
      void cleanup.then(() => {
        if (!isCurrentLifecycleGeneration(unmountGeneration)) {
          return;
        }
        setDisconnectedStatus();
        isConnectingRef.current = false;
        markAllResourcesDisconnected();
      });
    };
  }, [
    disconnectAndCleanUpResourcesRef,
    isCurrentLifecycleGeneration,
    markAllResourcesDisconnected,
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
        const message = getBrowserErrorMessage(e) ?? 'Unknown error';
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
        const message = getBrowserErrorMessage(e) ?? 'Unknown error';
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
        const message = getBrowserErrorMessage(e) ?? 'Unknown error';
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
        const errorMessage = getBrowserErrorMessage(e) ?? 'Unknown error';
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
