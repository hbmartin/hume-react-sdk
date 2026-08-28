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
   * becomes `true`. Defaults to `false`; prefer the returned
   * `requestPermission` function from a user gesture.
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
  /** Request microphone permission, release the stream, and refresh device labels. */
  requestPermission: () => Promise<void>;
  isLoading: boolean;
  error: Error | null;
  /** Non-denial failure while acquiring microphone permission. */
  permissionError: Error | null;
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
  const first = devices.find((device) => device.deviceId !== '');
  if (first === undefined) {
    return null;
  }
  if (current !== null && devices.some((d) => d.deviceId === current)) {
    return current;
  }
  return first.deviceId;
};

/**
 * Enumerate the available microphones and speakers, and track which one is
 * selected. Pass the selected ids to `connect` via its `devices` option.
 *
 * The device list refreshes automatically when hardware is plugged in or
 * removed. If the selected device disappears, the selection falls back to the
 * first remaining device of that kind.
 * @example
 * ```tsx
 * const {
 *   inputDevices,
 *   selectedInputDeviceId,
 *   selectedOutputDeviceId,
 *   setSelectedInputDeviceId,
 *   requestPermission,
 * } = useAudioDevices();
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
  requestPermission: requestPermissionOnMount = false,
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
  const [permissionError, setPermissionError] = useState<Error | null>(null);
  const [isSupported, setIsSupported] = useState(false);
  const refetchSequence = useRef(0);
  const isMounted = useRef(false);
  const permissionRequest = useRef<Promise<void> | null>(null);
  const requestedPermissionOnMount = useRef(false);

  // Intentionally has no dependencies: the selection updates are written as
  // functional updates so that `refetch` keeps a stable identity. A version
  // that closed over the current selection would re-subscribe (and re-prompt
  // for microphone permission) every time the user picked a different device.
  const refetch = useCallback(async () => {
    if (!isAudioDeviceEnumerationSupported()) {
      return;
    }

    const sequence = ++refetchSequence.current;
    if (isMounted.current) {
      setIsLoading(true);
    }
    try {
      const { inputDevices: inputs, outputDevices: outputs } =
        await getAllAudioDevices();

      if (sequence !== refetchSequence.current || !isMounted.current) return;
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
      if (sequence !== refetchSequence.current || !isMounted.current) return;
      setError(
        e instanceof Error
          ? e
          : new Error('Failed to enumerate audio devices.'),
      );
    } finally {
      if (sequence === refetchSequence.current && isMounted.current) {
        setIsLoading(false);
      }
    }
  }, []);

  const requestPermission = useCallback((): Promise<void> => {
    if (permissionRequest.current) {
      return permissionRequest.current;
    }

    const operation = (async () => {
      try {
        await requestAudioDevicePermission();
        if (isMounted.current) {
          setPermissionDenied(false);
          setPermissionError(null);
        }
      } catch (e) {
        const browserError =
          typeof e === 'object' && e !== null
            ? (e as { message?: unknown; name?: unknown })
            : null;
        const permissionFailure = browserError?.name === 'NotAllowedError';
        if (isMounted.current) {
          let nextPermissionError: Error | null = null;
          if (!permissionFailure) {
            if (e instanceof Error) {
              nextPermissionError = e;
            } else {
              nextPermissionError = new Error(
                typeof browserError?.message === 'string'
                  ? browserError.message
                  : 'Failed to request microphone permission.',
              );
              if (typeof browserError?.name === 'string') {
                nextPermissionError.name = browserError.name;
              }
            }
          }
          setPermissionDenied(permissionFailure);
          setPermissionError(nextPermissionError);
        }
      } finally {
        await refetch();
        permissionRequest.current = null;
      }
    })();

    permissionRequest.current = operation;
    return operation;
  }, [refetch]);

  useEffect(() => {
    isMounted.current = true;
    const supported = isAudioDeviceEnumerationSupported();
    // oxlint-disable-next-line react/set-state-in-effect -- capability detection must run after SSR hydration
    setIsSupported(supported);
    if (!supported) {
      isMounted.current = false;
      return;
    }

    const { mediaDevices } = navigator;
    void refetch();
    if (requestPermissionOnMount && !requestedPermissionOnMount.current) {
      requestedPermissionOnMount.current = true;
      void requestPermission();
    }

    const handleDeviceChange = () => {
      void refetch();
    };

    mediaDevices.addEventListener('devicechange', handleDeviceChange);

    return () => {
      isMounted.current = false;
      refetchSequence.current += 1;
      mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [refetch, requestPermission, requestPermissionOnMount]);

  return {
    inputDevices,
    outputDevices,
    selectedInputDeviceId,
    selectedOutputDeviceId,
    setSelectedInputDeviceId,
    setSelectedOutputDeviceId,
    refetch,
    requestPermission,
    isLoading,
    error,
    isSupported,
    permissionDenied,
    permissionError,
  };
};
