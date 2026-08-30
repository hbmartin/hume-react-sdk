/**
 * Headless React bindings for Hume's Empathic Voice Interface.
 *
 * Wrap your tree in `VoiceProvider`, then read connection state and
 * controls with `useVoice`. The package ships no UI: it manages the EVI
 * WebSocket, microphone capture, the audio playback queue, and message
 * history, and leaves the interface to you.
 *
 * @packageDocumentation
 */

export type * from './lib/connection-message';
export type { ParsedAudioMessage } from './lib/audio-message';
export type {
  VoiceDiagnosticCategory,
  VoiceDiagnosticDetails,
  VoiceDiagnosticEvent,
  VoiceDiagnosticEventName,
  VoiceDiagnosticInput,
  VoiceDiagnosticLevel,
  VoiceDiagnosticsOptions,
  VoiceDiagnosticsReporter,
  VoiceDiagnosticValue,
  VoiceLogger,
} from './lib/diagnostics';
// These remain only because the deprecated player returns its FFT store.
export { FftStore, type FftSnapshot, useFftSubscription } from './lib/fftStore';
export * from './lib/useAudioDevices';
export { type UseSoundPlayerProps, useSoundPlayer } from './lib/useSoundPlayer';
export * from './lib/VoiceProvider';
export {
  AudioDeviceSwitchError,
  ConcurrentConnectAuthError,
  isAudioDeviceSwitchError,
  isConcurrentConnectAuthError,
  isSocketFailedToParseMessageError,
  isSocketUnknownMessageError,
  SocketFailedToParseMessageError,
  SocketUnknownMessageError,
  type AudioDeviceSwitchErrorReason,
} from './lib/errors';
export * from './lib/messages';
export type * from './models/messages';
export type * from './models/connect-options';

export {
  getAllAudioDevices,
  getInputDevices,
  getOutputDevices,
  isAudioDeviceEnumerationSupported,
  requestAudioDevicePermission,
} from './utils';

// The rest of this module is the low-level client the provider is built on.
export {
  VoiceReadyState,
  type SessionSettingsUpdate,
  type SocketCloseEvent,
  type SocketConfig,
  type ToolCallErrorSource,
  type ToolCallHandler,
} from './lib/useVoiceClient';
export type { AuthStrategy } from './lib/auth';
export type { ToolStatusEntry, ToolStatusStore } from './lib/useToolStatus';
