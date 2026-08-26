// cspell:ignore dataavailable

import { MimeType } from '@humeai/assistant';
import {
  MediaRecorder as ExtendableMediaRecorder,
  type IBlobEvent,
  type IMediaRecorder,
  register,
} from 'extendable-media-recorder';
import { connect } from 'extendable-media-recorder-wav-encoder';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

let wavEncoderRegistration: Promise<void> | null = null;

const registerWavEncoder = () => {
  if (!wavEncoderRegistration) {
    wavEncoderRegistration = connect()
      .then((port) => register(port))
      .catch((error: unknown) => {
        wavEncoderRegistration = null;
        throw error;
      });
  }

  return wavEncoderRegistration;
};

const stopStream = (stream: MediaStream) => {
  stream.getTracks().forEach((track) => track.stop());
};

export type MicrophoneProps = {
  streamRef?: MutableRefObject<MediaStream | null>;
  onAudioCaptured: (b: ArrayBuffer) => void;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onError: (message: string) => void;
};

export const useMicrophone = ({
  onAudioCaptured,
  onStartRecording,
  onStopRecording,
  onError,
  streamRef,
}: MicrophoneProps) => {
  const isMutedRef = useRef(false);
  const [isMuted, setIsMuted] = useState(false);
  const recorder = useRef<IMediaRecorder | null>(null);
  const currentStream = useRef<MediaStream | null>(null);
  const operationGeneration = useRef(0);
  const isMounted = useRef(false);

  const sendAudio = useRef(onAudioCaptured);
  sendAudio.current = onAudioCaptured;

  const dataHandler = useCallback(
    (event: IBlobEvent) => {
      if (isMutedRef.current) {
        return;
      }

      void event.data
        .arrayBuffer()
        .then((buffer) => sendAudio.current(buffer))
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          onError(`Error reading microphone audio: ${message}`);
        });
    },
    [onError],
  );

  const start = useCallback(
    async (
      stream: MediaStream | null = streamRef?.current ?? null,
    ): Promise<boolean> => {
      if (!stream) {
        onError('Error with microphone: no stream available.');
        return false;
      }
      if (recorder.current || currentStream.current) {
        stopStream(stream);
        onError('Error with microphone: the microphone is already recording.');
        return false;
      }

      const generation = ++operationGeneration.current;
      currentStream.current = stream;
      if (streamRef) {
        streamRef.current = stream;
      }
      let nextRecorder: IMediaRecorder | null = null;

      try {
        await registerWavEncoder();

        if (
          !isMounted.current ||
          generation !== operationGeneration.current ||
          currentStream.current !== stream
        ) {
          return false;
        }

        nextRecorder = new ExtendableMediaRecorder(stream, {
          mimeType: MimeType.WAV,
        });
        nextRecorder.addEventListener('dataavailable', dataHandler);
        nextRecorder.start(250);
        recorder.current = nextRecorder;
        onStartRecording?.();
        return true;
      } catch (error) {
        if (nextRecorder) {
          try {
            nextRecorder.removeEventListener('dataavailable', dataHandler);
            nextRecorder.stop();
          } catch {
            // The recorder may not have reached the recording state.
          }
        }

        if (generation !== operationGeneration.current || !isMounted.current) {
          return false;
        }

        if (currentStream.current === stream) {
          currentStream.current = null;
          if (streamRef?.current === stream) {
            streamRef.current = null;
          }
          stopStream(stream);
        }
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        onError(`Error with microphone: ${message}`);
        return false;
      }
    },
    [dataHandler, onError, onStartRecording, streamRef],
  );

  const stop = useCallback(() => {
    operationGeneration.current += 1;

    const recorderToStop = recorder.current;
    const streamToStop = currentStream.current;
    recorder.current = null;
    currentStream.current = null;
    if (streamRef?.current === streamToStop) {
      streamRef.current = null;
    }

    const failures: string[] = [];
    if (recorderToStop) {
      try {
        recorderToStop.removeEventListener('dataavailable', dataHandler);
        recorderToStop.stop();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Unknown error');
      }
    }

    if (streamToStop) {
      try {
        stopStream(streamToStop);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Unknown error');
      }
    }

    if (recorderToStop) {
      onStopRecording?.();
    }

    if (failures.length > 0) {
      onError(`Error stopping microphone: ${failures.join('; ')}`);
    }
  }, [dataHandler, onError, onStopRecording, streamRef]);

  const mute = useCallback(() => {
    isMutedRef.current = true;
    setIsMuted(true);
  }, []);

  const unmute = useCallback(() => {
    isMutedRef.current = false;
    setIsMuted(false);
  }, []);

  useEffect(() => {
    isMounted.current = true;

    return () => {
      isMounted.current = false;
      stop();
    };
  }, [stop]);

  return useMemo(
    () => ({ start, stop, mute, unmute, isMuted }),
    [isMuted, mute, start, stop, unmute],
  );
};
