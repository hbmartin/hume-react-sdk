import { useCallback, useEffect, useRef, useState } from 'react';

import type { AudioDevice } from '../models/connect-options';
import {
  getAllAudioDevices,
  isAudioDeviceEnumerationSupported,
  requestAudioDevicePermission,
} from '../utils';

export type UseAudioDevicesOptions = {
  /**
   * Request microphone permission on mount so that real device labels are
   * available. When permission is refused the hook still enumerates devices,
   * but their labels fall back to generated names and `permissionDenied`
   * becomes `true`. Defaults to `true`.
   */
  requestPermission?: boolean;
};

export type UseAudioDevicesReturn = {
  inputDevices: AudioDevice[];
  outputDevices: AudioDevice[];
  selectedInputDeviceId: string | null;
  selectedOutputDeviceId: string | null;
  setSelectedInputDeviceId: (deviceId: string | null) => void;
  setSelectedOutputDeviceId: (deviceId: string | null) => void;
  /** Re-enumerate devices. Called automatically on mount and on `devicechange`. */
  refetch: () => Promise<void>;
  isLoading: boolean;
  error: Error | null;
  /** `false` during server-side rendering and in insecure contexts. */
  isSupported: boolean;
  /** `true` when microphone permission was refused, so labels are generated. */
  permissionDenied: boolean;
};

/**
 * Keep a selection pointing at a device that still exists, defaulting to the
 * first available one. Returns `null` when there is nothing to select.
 */
const reconcileSelection = (
  current: string | null,
  devices: AudioDevice[],
): string | null => {
  const first = devices[0];
  if (first === undefined) {
    return null;
  }
  if (current !== null && devices.some((d) => d.deviceId === current)) {
    return current;
  }
  return first.deviceId;
};

/**
 * @name useAudioDevices
 * @description
 * Enumerate the available microphones and speakers, and track which one is
 * selected. Pass the selected ids to `connect` via its `devices` option.
 *
 * The device list refreshes automatically when hardware is plugged in or
 * removed. If the selected device disappears, the selection falls back to the
 * first remaining device of that kind.
 * @example
 * ```tsx
 * const { inputDevices, selectedInputDeviceId, setSelectedInputDeviceId } =
 *   useAudioDevices();
 *
 * await connect({
 *   auth,
 *   devices: {
 *     microphoneDeviceId: selectedInputDeviceId ?? undefined,
 *     speakerDeviceId: selectedOutputDeviceId ?? undefined,
 *   },
 * });
 * ```
 */
export const useAudioDevices = ({
  requestPermission = true,
}: UseAudioDevicesOptions = {}): UseAudioDevicesReturn => {
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState<
    string | null
  >(null);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<
    string | null
  >(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [isSupported] = useState(isAudioDeviceEnumerationSupported);
  const refetchSequence = useRef(0);

  // Intentionally has no dependencies: the selection updates are written as
  // functional updates so that `refetch` keeps a stable identity. A version
  // that closed over the current selection would re-subscribe (and re-prompt
  // for microphone permission) every time the user picked a different device.
  const refetch = useCallback(async () => {
    if (!isAudioDeviceEnumerationSupported()) {
      return;
    }

    const sequence = ++refetchSequence.current;
    setIsLoading(true);
    try {
      const { inputDevices: inputs, outputDevices: outputs } =
        await getAllAudioDevices();

      if (sequence !== refetchSequence.current) return;
      setInputDevices(inputs);
      setOutputDevices(outputs);
      setSelectedInputDeviceId((current) =>
        reconcileSelection(current, inputs),
      );
      setSelectedOutputDeviceId((current) =>
        reconcileSelection(current, outputs),
      );
      setError(null);
    } catch (e) {
      if (sequence !== refetchSequence.current) return;
      setError(
        e instanceof Error
          ? e
          : new Error('Failed to enumerate audio devices.'),
      );
    } finally {
      if (sequence === refetchSequence.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isAudioDeviceEnumerationSupported()) {
      return;
    }

    let cancelled = false;
    const { mediaDevices } = navigator;

    const init = async () => {
      if (requestPermission) {
        try {
          await requestAudioDevicePermission();
          if (!cancelled) {
            setPermissionDenied(false);
          }
        } catch {
          // Permission refusal is not an enumeration failure. Devices are
          // still listed, only their labels are generated rather than real.
          if (!cancelled) {
            setPermissionDenied(true);
          }
        }
      }

      if (!cancelled) {
        await refetch();
      }
    };

    void init();

    const handleDeviceChange = () => {
      void refetch();
    };

    mediaDevices.addEventListener('devicechange', handleDeviceChange);

    return () => {
      cancelled = true;
      mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [requestPermission, refetch]);

  return {
    inputDevices,
    outputDevices,
    selectedInputDeviceId,
    selectedOutputDeviceId,
    setSelectedInputDeviceId,
    setSelectedOutputDeviceId,
    refetch,
    isLoading,
    error,
    isSupported,
    permissionDenied,
  };
};
