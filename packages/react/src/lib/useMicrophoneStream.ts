// cspell:ignore dataavailable
import { checkForAudioTracks } from 'hume';
import { useCallback, useRef, useState } from 'react';

import { isMicrophonePermissionDeniedError } from '../utils/browserErrors';
import { stopMediaStreamTracks } from '../utils/stopMediaStreamTracks';

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
  try {
    stopMediaStreamTracks(stream);
  } catch {
    // The validation error is the actionable failure; cleanup is best effort.
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
  const ownedStreams = useRef(new Set<MediaStream>());

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

      ownedStreams.current.add(stream);

      return stream;
    },
    [],
  );

  const stopStream = useCallback((stream?: MediaStream | null) => {
    let streams: MediaStream[];
    if (stream === undefined) {
      streams = [...ownedStreams.current];
    } else if (stream === null) {
      streams = [];
    } else {
      streams = [stream];
    }
    let firstFailure: { error: unknown } | null = null;

    for (const ownedStream of streams) {
      try {
        stopMediaStreamTracks(ownedStream);
        ownedStreams.current.delete(ownedStream);
      } catch (error) {
        firstFailure ??= { error };
      }
    }

    if (firstFailure !== null) throw firstFailure.error;
  }, []);

  return {
    getStream,
    stopStream,
    permission,
  };
};
