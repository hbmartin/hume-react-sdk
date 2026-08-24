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
      try {
        cancelAnimationFrame(animationId);
      } catch {
        // The animation frame may already have been canceled by the browser.
      }
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

  const disposeMicrophoneResources = useCallback(
    async (resetMutedState: boolean) => {
      const recorderToStop = recorder.current;
      const wasRecording = recordingStarted.current;
      const streamToStop = currentStream.current;
      const contextToClose = audioContext.current;
      const shouldCloseContext = ownsAudioContext.current;

      // Relinquish every resource before running user or browser code so a
      // concurrent start cannot be cleared or closed by this teardown.
      recorder.current = null;
      recordingStarted.current = false;
      currentStream.current = null;
      audioContext.current = null;
      ownsAudioContext.current = false;

      const failures: string[] = [];
      const release = (label: string, action: () => void) => {
        try {
          action();
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Unknown error';
          failures.push(`${label}: ${message}`);
        }
      };

      release('FFT analyzer cleanup failed', stopFftAnalyzer);

      if (recorderToStop) {
        release('Recorder listener cleanup failed', () => {
          recorderToStop.removeEventListener('dataavailable', dataHandler);
        });
        try {
          recorderToStop.stop();
        } catch {
          // The recorder may already be inactive; continue releasing resources.
        }
      }

      if (streamToStop) {
        let tracks: MediaStreamTrack[] = [];
        release('Media track enumeration failed', () => {
          tracks = streamToStop.getTracks();
        });
        tracks.forEach((track, index) => {
          release(`Media track ${index + 1} cleanup failed`, () => {
            track.stop();
          });
        });
      }

      if (resetMutedState) {
        setIsMuted(false);
      }

      if (wasRecording) {
        try {
          onStopRecordingRef.current?.();
        } catch (callbackError) {
          console.error('onStopRecording callback failed.', callbackError);
        }
      }

      if (contextToClose && shouldCloseContext) {
        try {
          await closeAudioContextWithTimeout(contextToClose);
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Unknown error';
          failures.push(`Audio context cleanup failed: ${message}`);
        }
      }

      if (failures.length > 0) {
        throw new Error(failures.join('; '));
      }
    },
    [dataHandler, onStopRecordingRef, stopFftAnalyzer],
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
        const nextRecorder = new MediaRecorder(stream, { mimeType });
        recorder.current = nextRecorder;
        nextRecorder.addEventListener('dataavailable', dataHandler);
        nextRecorder.start(100);
        recordingStarted.current = true;
        setIsMuted(false);
        try {
          onStartRecordingRef.current?.();
        } catch (callbackError) {
          console.error('onStartRecording callback failed.', callbackError);
        }
      } catch (e) {
        void disposeMicrophoneResources(true).catch((cleanupError) => {
          console.error(
            'Failed to fully roll back microphone initialization.',
            cleanupError,
          );
        });
        throw e;
      }
    },
    [
      dataHandler,
      disposeMicrophoneResources,
      onStartRecordingRef,
      startFftAnalyzer,
      stopFftAnalyzer,
    ],
  );

  const stop = useCallback(async () => {
    try {
      await disposeMicrophoneResources(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      onErrorRef.current?.(
        `Failed to fully stop microphone resources: ${message}`,
        'mic_closure_failure',
      );
    }
  }, [disposeMicrophoneResources, onErrorRef]);

  const mute = useCallback(() => {
    if (currentAnalyzer.current) {
      fftStore.clear();
    }

    currentStream.current?.getTracks().forEach((track) => {
      track.enabled = false;
    });

    setIsMuted(true);
  }, [fftStore]);

  const unmute = useCallback(() => {
    currentStream.current?.getTracks().forEach((track) => {
      track.enabled = true;
    });

    setIsMuted(false);
  }, []);

  useEffect(() => {
    return () => {
      void disposeMicrophoneResources(false).catch((e) => {
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
