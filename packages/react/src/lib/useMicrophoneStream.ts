// cspell:ignore dataavailable
import { checkForAudioTracks } from 'hume';
import { useCallback, useRef, useState } from 'react';

import { isMicrophonePermissionDeniedError } from './browserErrors';

/**
 * Browser microphone permission state reported by {@link useMicrophoneStream}.
 *
 * @internal
 */
export type MicrophonePermissionStatus = 'prompt' | 'granted' | 'denied';

const getAudioStream = async (
  audioConstraints: MediaTrackConstraints,
): Promise<MediaStream> => {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.mediaDevices === 'undefined' ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    const error = new Error('Microphone capture is not supported.');
    error.name = 'NotSupportedError';
    throw error;
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...audioConstraints,
      echoCancellation: audioConstraints.echoCancellation ?? true,
      noiseSuppression: audioConstraints.noiseSuppression ?? true,
      autoGainControl: audioConstraints.autoGainControl ?? true,
      ...(audioConstraints.deviceId === undefined
        ? {}
        : { deviceId: audioConstraints.deviceId }),
    },
    video: false,
  });
};

/** Stop as many tracks as possible without replacing the acquisition failure. */
const stopTracksAfterValidationFailure = (stream: MediaStream): void => {
  let tracks: MediaStreamTrack[];
  try {
    tracks = stream.getTracks();
  } catch {
    return;
  }

  for (const track of tracks) {
    try {
      track.stop();
    } catch {
      // The validation error is the actionable failure; cleanup is best effort.
    }
  }
};

/**
 * Acquire and release a browser microphone stream.
 *
 * @internal
 */
export const useMicrophoneStream = () => {
  const [permission, setPermission] =
    useState<MicrophonePermissionStatus>('prompt');
  const currentStream = useRef<MediaStream | null>(null);

  const getStream = useCallback(
    async (audioConstraints: MediaTrackConstraints) => {
      let stream: MediaStream | null = null;

      try {
        stream = await getAudioStream(audioConstraints);
      } catch (e) {
        if (isMicrophonePermissionDeniedError(e)) {
          setPermission('denied');
        }
        throw e;
      }

      setPermission('granted');

      try {
        checkForAudioTracks(stream);
      } catch (e) {
        stopTracksAfterValidationFailure(stream);
        throw e;
      }

      currentStream.current = stream;

      return stream;
    },
    [],
  );

  const stopStream = useCallback((stream = currentStream.current) => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      if (currentStream.current !== stream) {
        return;
      }
      currentStream.current = null;
    }
  }, []);

  return {
    getStream,
    stopStream,
    permission,
  };
};
