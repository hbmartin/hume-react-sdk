import type {
  AudioDevice,
  AudioDeviceKind,
  AudioDevices,
} from '../models/connect-options';

export const keepLastN = <T>(n: number, arr: T[]): T[] => {
  if (arr.length <= n) {
    return arr;
  }
  return arr.slice(arr.length - n);
};

/**
 * @name isAudioDeviceEnumerationSupported
 * @description
 * Whether the current environment can enumerate audio devices. Returns `false`
 * during server-side rendering and in insecure (non-HTTPS) contexts, where
 * `navigator.mediaDevices` is not exposed.
 */
export const isAudioDeviceEnumerationSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices !== 'undefined' &&
  typeof navigator.mediaDevices.enumerateDevices === 'function';

const FALLBACK_LABELS: Record<AudioDeviceKind, string> = {
  audioinput: 'Microphone',
  audiooutput: 'Speaker',
};

const toAudioDevice = (
  device: MediaDeviceInfo,
  kind: AudioDeviceKind,
): AudioDevice => ({
  deviceId: device.deviceId,
  label:
    device.label || `${FALLBACK_LABELS[kind]} ${device.deviceId.slice(0, 8)}`,
  kind,
});

/**
 * @name requestAudioDevicePermission
 * @description
 * Request microphone permission and immediately release the stream. Browsers
 * report empty `label` values for every device until permission has been
 * granted at least once, so call this before enumerating if you intend to show
 * device names to the user.
 * @example
 * ```ts
 * await requestAudioDevicePermission();
 * const { inputDevices } = await getAllAudioDevices();
 * ```
 */
export const requestAudioDevicePermission = async (): Promise<void> => {
  if (!isAudioDeviceEnumerationSupported()) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
};

/**
 * @name getAllAudioDevices
 * @description
 * Enumerate the available audio input and output devices. Returns empty lists
 * when device enumeration is unsupported.
 * @example
 * ```ts
 * const { inputDevices, outputDevices } = await getAllAudioDevices();
 * ```
 */
export const getAllAudioDevices = async (): Promise<AudioDevices> => {
  if (!isAudioDeviceEnumerationSupported()) {
    return { inputDevices: [], outputDevices: [] };
  }

  const devices = await navigator.mediaDevices.enumerateDevices();

  return {
    inputDevices: devices
      .filter((device) => device.kind === 'audioinput')
      .map((device) => toAudioDevice(device, 'audioinput')),
    outputDevices: devices
      .filter((device) => device.kind === 'audiooutput')
      .map((device) => toAudioDevice(device, 'audiooutput')),
  };
};

/**
 * @name getInputDevices
 * @description
 * Enumerate the available audio input devices (microphones).
 * @example
 * ```ts
 * const microphones = await getInputDevices();
 * ```
 */
export const getInputDevices = async (): Promise<AudioDevice[]> =>
  (await getAllAudioDevices()).inputDevices;

/**
 * @name getOutputDevices
 * @description
 * Enumerate the available audio output devices (speakers).
 * @example
 * ```ts
 * const speakers = await getOutputDevices();
 * ```
 */
export const getOutputDevices = async (): Promise<AudioDevice[]> =>
  (await getAllAudioDevices()).outputDevices;
