import type { Hume } from 'hume';

import type { SocketConfig } from '../lib/useVoiceClient';

/**
 * Constraints applied to the microphone stream requested from
 * `navigator.mediaDevices.getUserMedia`.
 *
 * Each constraint is a hint: browsers that do not implement one ignore it.
 */
export type AudioConstraints = {
  /**
   * Reduce echo from the input, if supported. Defaults to `true`.
   */
  echoCancellation?: boolean;
  /**
   * Suppress background noise, if supported. Defaults to `true`.
   */
  noiseSuppression?: boolean;
  /**
   * Automatically adjust microphone gain, if supported. Defaults to `true`.
   */
  autoGainControl?: boolean;
};

/**
 * Microphone and speaker selection for a connection.
 *
 * Device IDs come from {@link useAudioDevices} or {@link getAllAudioDevices}.
 * Omit either field to use the browser default. Devices can also be switched
 * during a call with `setInputDevice` and `setOutputDevice`.
 */
export type DeviceOptions = {
  /** Microphone to capture from. Uses the browser default if omitted. */
  microphoneDeviceId?: string;
  /** Speaker to play assistant audio through. Uses the default if omitted. */
  speakerDeviceId?: string;
};

/** Whether a device captures audio or plays it back. */
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

/** Available audio devices, split by direction. */
export type AudioDevices = {
  /** Microphones and other capture devices. */
  inputDevices: AudioDevice[];
  /** Speakers and other playback devices. */
  outputDevices: AudioDevice[];
};

/**
 * Options for a single EVI connection, passed to `connect`.
 *
 * These are per-session rather than per-component, which is why they belong on
 * `connect` and not on {@link VoiceProvider}.
 */
export type ConnectOptions = Omit<SocketConfig, 'reconnectAttempts'> & {
  /** Microphone constraints for this connection. */
  audioConstraints?: AudioConstraints;
  /**
   * Session settings sent as soon as the connection is established.
   *
   * @see {@link https://dev.hume.ai/docs/empathic-voice-interface-evi/configuration/session-settings}
   */
  sessionSettings?: Hume.empathicVoice.SessionSettings;
  /** Microphone and speaker to use for this connection. */
  devices?: DeviceOptions;
};
