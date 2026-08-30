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
  VoiceDiagnosticLevel,
  VoiceDiagnosticInput,
  VoiceDiagnosticsOptions,
  VoiceDiagnosticsReporter,
  VoiceDiagnosticValue,
  VoiceLogger,
} from './lib/diagnostics';
export * from './lib/fftStore';
export * from './lib/useAudioDevices';
export * from './lib/useCallDuration';
export * from './lib/useMicrophoneStream';
export * from './lib/useMicrophone';
export { useSoundPlayer } from './lib/useSoundPlayer';
export * from './lib/useVoiceClient';
export * from './lib/VoiceProvider';
export * from './lib/errors';
export * from './lib/messages';
export * from './models/audio';
export * from './models/llm';
export * from './models/messages';
export * from './models/ttsService';
export type * from './models/connect-options';

export {
  getAllAudioDevices,
  getInputDevices,
  getOutputDevices,
  isAudioDeviceEnumerationSupported,
  requestAudioDevicePermission,
} from './utils';

export type { SocketConfig } from './lib/useVoiceClient';
export type { AuthStrategy } from './lib/auth';
export type { ToolStatusEntry, ToolStatusStore } from './lib/useToolStatus';
