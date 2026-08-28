export type * from './lib/connection-message';
export type {
  VoiceDiagnosticCategory,
  VoiceDiagnosticDetails,
  VoiceDiagnosticEvent,
  VoiceDiagnosticEventName,
  VoiceDiagnosticLevel,
  VoiceDiagnosticsOptions,
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
