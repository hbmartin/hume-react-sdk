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
 * `label` is guaranteed to be non-empty: browsers withhold real device labels
 * until microphone permission has been granted at least once, so a readable
 * fallback derived from the device id is substituted when one is missing.
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
