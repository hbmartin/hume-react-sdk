// cspell:ignore dataavailable
import type { MimeType } from 'hume';
import { getBrowserSupportedMimeType } from 'hume';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { convertLinearFrequenciesToBarkInto } from './convertFrequencyScale';
import { FftStore } from './fftStore';
import { useLatestRef } from './useLatestRef';
import type { MicErrorReason } from './VoiceProvider';
import { closeAudioContextWithTimeout } from '../utils/closeAudioContextWithTimeout';

const BARK_BAND_COUNT = 24;
const MICROPHONE_RECORDING_UNSUPPORTED_MESSAGE =
  'This browser does not fully support microphone recording.';
const MICROPHONE_ALREADY_STARTED_MESSAGE =
  'The microphone is already recording. Stop it before starting again.';

export type MicrophoneProps = {
  onAudioCaptured: (b: ArrayBuffer) => void;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onError: (message: string, reason: MicErrorReason) => void;
};

export const useMicrophone = (props: MicrophoneProps) => {
  const { onAudioCaptured } = props;
  const onErrorRef = useLatestRef(props.onError);
  const onStartRecordingRef = useLatestRef(props.onStartRecording);
  const onStopRecordingRef = useLatestRef(props.onStopRecording);
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);
  const currentStream = useRef<MediaStream | null>(null);

  const fftStore = useRef(new FftStore()).current;

  const currentAnalyzer = useRef<AnalyserNode | null>(null);
  const fftAnimationId = useRef<number | null>(null);
  const analyzerSource = useRef<MediaStreamAudioSourceNode | null>(null);

  const mimeTypeRef = useRef<MimeType | null>(null);

  const audioContext = useRef<AudioContext | null>(null);
  const ownsAudioContext = useRef(false);

  const recorder = useRef<MediaRecorder | null>(null);
  const recordingStarted = useRef(false);

  const sendAudio = useLatestRef(onAudioCaptured);

  const stopFftAnalyzer = useCallback(() => {
    const animationId = fftAnimationId.current;
    fftAnimationId.current = null;
    if (animationId !== null) {
      cancelAnimationFrame(animationId);
    }

    const source = analyzerSource.current;
    analyzerSource.current = null;
    if (source) {
      try {
        source.disconnect();
      } catch {
        // The source may already have been disconnected.
      }
    }
    currentAnalyzer.current = null;
  }, []);

  const dataHandler = useCallback(
    (event: BlobEvent) => {
      const blob = event.data;

      blob
        .arrayBuffer()
        .then((buffer) => {
          if (buffer.byteLength > 0) {
            sendAudio.current?.(buffer);
          }
        })
        .catch((err) => {
          console.log(err);
        });
    },
    [sendAudio],
  );

  const startFftAnalyzer = useCallback(
    (stream: MediaStream) => {
      if (!audioContext.current) {
        return;
      }

      const source = audioContext.current.createMediaStreamSource(stream);
      analyzerSource.current = source;
      currentAnalyzer.current = audioContext.current.createAnalyser();
      currentAnalyzer.current.fftSize = 2048;
      const bufferLength = currentAnalyzer.current.frequencyBinCount;

      const dataArray = new Uint8Array(bufferLength);
      const barkBuffer = new Array<number>(BARK_BAND_COUNT).fill(0);

      source.connect(currentAnalyzer.current);
      const draw = () => {
        if (!currentAnalyzer.current || !audioContext.current) {
          return;
        }

        currentAnalyzer.current.getByteFrequencyData(dataArray);

        const sampleRate = audioContext.current.sampleRate;

        convertLinearFrequenciesToBarkInto(dataArray, sampleRate, barkBuffer);

        fftStore.write(barkBuffer);
        fftAnimationId.current = requestAnimationFrame(draw);
      };
      draw();
    },
    [fftStore],
  );

  const disposeMicrophoneResources = useCallback(async () => {
    const recorderToStop = recorder.current;
    const wasRecording = recordingStarted.current;
    const streamToStop = currentStream.current;
    const contextToClose = audioContext.current;
    const shouldCloseContext = ownsAudioContext.current;
    const failures: string[] = [];

    // Enumerate tracks before relinquishing the stream. getTracks() is
    // synchronous, so this cannot race a new start, and retaining the stream
    // leaves a handle available if a nonstandard implementation throws.
    let tracksToStop: MediaStreamTrack[] = [];
    let tracksEnumerated = true;
    if (streamToStop) {
      try {
        tracksToStop = streamToStop.getTracks();
      } catch (error) {
        tracksEnumerated = false;
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        failures.push(`Media track enumeration failed: ${message}`);
      }
    }

    // Detach resources that have durable local handles before awaiting. The
    // stream remains attached until all of its tracks stop successfully.
    recorder.current = null;
    recordingStarted.current = false;
    audioContext.current = null;
    ownsAudioContext.current = false;

    stopFftAnalyzer();
    fftStore.clear();

    let recorderStopped = true;
    if (recorderToStop) {
      const removeDataHandler = () => {
        try {
          recorderToStop.removeEventListener('dataavailable', dataHandler);
        } catch (error) {
          console.error('Recorder listener cleanup failed.', error);
        }
      };
      const handleRecorderStop = () => {
        removeDataHandler();
        try {
          recorderToStop.removeEventListener('stop', handleRecorderStop);
        } catch (error) {
          console.error('Recorder listener cleanup failed.', error);
        }
      };
      let stopListenerAttached = false;
      try {
        recorderToStop.addEventListener('stop', handleRecorderStop);
        stopListenerAttached = true;
      } catch (error) {
        console.error('Recorder stop listener setup failed.', error);
      }
      try {
        recorderToStop.stop();
      } catch (error) {
        const errorName =
          typeof error === 'object' && error !== null && 'name' in error
            ? error.name
            : null;
        if (stopListenerAttached) {
          try {
            recorderToStop.removeEventListener('stop', handleRecorderStop);
          } catch (listenerError) {
            console.error('Recorder listener cleanup failed.', listenerError);
          }
        }
        if (errorName !== 'InvalidStateError') {
          recorderStopped = false;
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          failures.push(`Recorder cleanup failed: ${message}`);
        } else {
          removeDataHandler();
        }
      }
    }
    if (!recorderStopped) {
      recorder.current = recorderToStop;
      recordingStarted.current = wasRecording;
    }

    let tracksStopped = tracksEnumerated;
    if (streamToStop && tracksEnumerated) {
      tracksToStop.forEach((track, index) => {
        try {
          track.stop();
        } catch (error) {
          tracksStopped = false;
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          failures.push(`Media track ${index + 1} cleanup failed: ${message}`);
        }
      });
    }
    if (currentStream.current === streamToStop && tracksStopped) {
      currentStream.current = null;
    }

    isMutedRef.current = false;
    setIsMuted(false);

    if (wasRecording && recorderStopped) {
      try {
        onStopRecordingRef.current?.();
      } catch (callbackError) {
        console.error('onStopRecording callback failed.', callbackError);
      }
    }

    if (contextToClose && shouldCloseContext) {
      const closeResult = await closeAudioContextWithTimeout(contextToClose);
      if (!closeResult.success) {
        failures.push(
          `Audio context cleanup failed: ${closeResult.error.message}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
  }, [dataHandler, fftStore, onStopRecordingRef, stopFftAnalyzer]);

  const reportClosureFailure = useCallback(
    (message: string, error: unknown) => {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      onErrorRef.current?.(`${message}: ${detail}`, 'mic_closure_failure');
    },
    [onErrorRef],
  );

  const start = useCallback(
    (stream: MediaStream, sharedAudioContext?: AudioContext) => {
      if (!stream) {
        throw new Error('No stream connected');
      }

      const mimeType = mimeTypeRef.current;
      if (!mimeType) {
        throw new Error('No MimeType specified');
      }

      if (recorder.current || currentStream.current || audioContext.current) {
        throw new Error(MICROPHONE_ALREADY_STARTED_MESSAGE);
      }

      const context = sharedAudioContext ?? new AudioContext();
      currentStream.current = stream;
      ownsAudioContext.current = !sharedAudioContext;
      audioContext.current = context;

      try {
        startFftAnalyzer(stream);
      } catch (e: unknown) {
        stopFftAnalyzer();
        const message = e instanceof Error ? e.message : 'Unknown error';
        console.error(`Failed to start mic analyzer: ${message}`);
      }

      try {
        if (isMutedRef.current) {
          stream.getTracks().forEach((track) => {
            track.enabled = false;
          });
          fftStore.clear();
        }
        const nextRecorder = new MediaRecorder(stream, { mimeType });
        recorder.current = nextRecorder;
        nextRecorder.addEventListener('dataavailable', dataHandler);
        nextRecorder.start(100);
        recordingStarted.current = true;
        try {
          onStartRecordingRef.current?.();
        } catch (callbackError) {
          console.error('onStartRecording callback failed.', callbackError);
        }
      } catch (e) {
        void disposeMicrophoneResources().catch((cleanupError) => {
          reportClosureFailure(
            'Failed to fully roll back microphone initialization',
            cleanupError,
          );
        });
        throw e;
      }
    },
    [
      dataHandler,
      disposeMicrophoneResources,
      fftStore,
      onStartRecordingRef,
      reportClosureFailure,
      startFftAnalyzer,
      stopFftAnalyzer,
    ],
  );

  const stop = useCallback(async () => {
    try {
      await disposeMicrophoneResources();
    } catch (e) {
      reportClosureFailure('Failed to fully stop microphone resources', e);
    }
  }, [disposeMicrophoneResources, reportClosureFailure]);

  const mute = useCallback(() => {
    isMutedRef.current = true;
    if (currentAnalyzer.current) {
      fftStore.clear();
    }

    currentStream.current?.getTracks().forEach((track) => {
      track.enabled = false;
    });

    setIsMuted(true);
  }, [fftStore]);

  const unmute = useCallback(() => {
    isMutedRef.current = false;
    currentStream.current?.getTracks().forEach((track) => {
      track.enabled = true;
    });

    setIsMuted(false);
  }, []);

  useEffect(() => {
    return () => {
      void disposeMicrophoneResources().catch((e) => {
        console.error(
          'Failed to fully dispose microphone resources during unmount.',
          e,
        );
      });
    };
  }, [disposeMicrophoneResources]);

  useEffect(() => {
    let mimeTypeResult: ReturnType<typeof getBrowserSupportedMimeType>;

    try {
      // getBrowserSupportedMimeType only checks that MediaRecorder is defined
      // before reaching for MediaRecorder.isTypeSupported, so an environment
      // with a partial MediaRecorder (a polyfill, an embedded WebView) throws
      // instead of returning a result. Uncaught here, that would tear down the
      // React tree rather than surface a mic error.
      mimeTypeResult = getBrowserSupportedMimeType();
    } catch (e) {
      console.error('Failed to detect supported microphone MIME types.', e);
      onErrorRef.current(
        MICROPHONE_RECORDING_UNSUPPORTED_MESSAGE,
        'mime_types_not_supported',
      );
      return;
    }

    if (mimeTypeResult.success) {
      mimeTypeRef.current = mimeTypeResult.mimeType;
    } else {
      onErrorRef.current(
        mimeTypeResult.error.message,
        'mime_types_not_supported',
      );
    }
  }, [onErrorRef]);

  return useMemo(
    () => ({
      start,
      stop,
      mute,
      unmute,
      isMuted,
      fftStore,
    }),
    [start, stop, mute, unmute, isMuted, fftStore],
  );
};
