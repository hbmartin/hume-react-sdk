import { useCallback } from 'react';

import type { EncodingValues } from './getMicrophoneDefaults';
import { getStreamSettings } from './getMicrophoneDefaults';

type AcquiredMicrophoneStream = {
  encoding: EncodingValues;
  stream: MediaStream;
};

type EncodingHook = {
  getStream: () => Promise<AcquiredMicrophoneStream>;
};

type EncodingProps = {
  encodingConstraints: Partial<EncodingValues>;
};

const stopStream = (stream: MediaStream) => {
  stream.getTracks().forEach((track) => track.stop());
};

const useEncoding = ({ encodingConstraints }: EncodingProps): EncodingHook => {
  const { channelCount, sampleRate } = encodingConstraints;

  const getStream = useCallback(async () => {
    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount,
          sampleRate,
        },
        video: false,
      });

      return {
        encoding: getStreamSettings(stream, {
          channelCount,
          sampleRate,
        }),
        stream,
      };
    } catch (error) {
      if (stream) {
        stopStream(stream);
      }
      throw error;
    }
  }, [channelCount, sampleRate]);

  return { getStream };
};

export { useEncoding };
