import type { Hume } from 'hume';

import type { SocketConfig } from '../lib/useVoiceClient';

export type AudioConstraints = {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};

export type DeviceOptions = {
  microphoneDeviceId?: string;
  speakerDeviceId?: string;
};

export type AudioDeviceKind = 'audioinput' | 'audiooutput';

/**
 * A single audio input or output device, as reported by
 * `navigator.mediaDevices.enumerateDevices()`.
 *
 * `label` is guaranteed to be non-empty: browsers withhold device details
 * until microphone permission has been granted, so a readable generic or
 * device-id-derived fallback is substituted when the real label is missing.
 * `deviceId` may still be empty for a privacy-redacted default device and must
 * not be passed to controls that reserve the empty string as a sentinel.
 */
export type AudioDevice = {
  deviceId: string;
  label: string;
  kind: AudioDeviceKind;
};

export type AudioDevices = {
  inputDevices: AudioDevice[];
  outputDevices: AudioDevice[];
};

export type ConnectOptions = Omit<SocketConfig, 'reconnectAttempts'> & {
  audioConstraints?: AudioConstraints;
  sessionSettings?: Hume.empathicVoice.SessionSettings;
  devices?: DeviceOptions;
};
