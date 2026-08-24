// cspell:ignore dataavailable
import type { MimeType } from 'hume';
import { getBrowserSupportedMimeType } from 'hume';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { convertLinearFrequenciesToBarkInto } from './convertFrequencyScale';
import { FftStore } from './fftStore';
import { useLatestRef } from './useLatestRef';
import type { MicErrorReason } from './VoiceProvider';

const BARK_BAND_COUNT = 24;
const MICROPHONE_RECORDING_UNSUPPORTED_MESSAGE =
  'This browser does not fully support microphone recording.';

export type MicrophoneProps = {
  onAudioCaptured: (b: ArrayBuffer) => void;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onError: (message: string, reason: MicErrorReason) => void;
};

export const useMicrophone = (props: MicrophoneProps) => {
  const { onAudioCaptured } = props;
  const onErrorRef = useLatestRef(props.onError);
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

  const dataHandler = useCallback((event: BlobEvent) => {
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
  }, []);

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

  const start = useCallback(
    (stream: MediaStream, sharedAudioContext?: AudioContext) => {
      if (!stream) {
        throw new Error('No stream connected');
      }

      const mimeType = mimeTypeRef.current;
      if (!mimeType) {
        throw new Error('No MimeType specified');
      }

      stopFftAnalyzer();
      currentStream.current = stream;

      const context = sharedAudioContext ?? new AudioContext();
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
      } catch (e) {
        const failedRecorder = recorder.current;
        recorder.current = null;
        if (failedRecorder) {
          failedRecorder.removeEventListener('dataavailable', dataHandler);
          try {
            failedRecorder.stop();
          } catch {
            // The recorder may not have reached its recording state.
          }
        }
        stopFftAnalyzer();
        if (currentStream.current === stream) {
          currentStream.current = null;
          stream.getTracks().forEach((track) => track.stop());
        }
        if (audioContext.current === context) {
          audioContext.current = null;
          ownsAudioContext.current = false;
        }
        if (!sharedAudioContext) {
          void context.close().catch(() => {
            // The context may already have been closed.
          });
        }
        throw e;
      }
    },
    [dataHandler, startFftAnalyzer, stopFftAnalyzer],
  );

  const stop = useCallback(async () => {
    stopFftAnalyzer();

    const recorderToStop = recorder.current;
    recorder.current = null;
    recorderToStop?.removeEventListener('dataavailable', dataHandler);
    try {
      recorderToStop?.stop();
    } catch {
      // The recorder may already be inactive.
    }

    const streamToStop = currentStream.current;
    currentStream.current = null;
    streamToStop?.getTracks().forEach((track) => track.stop());

    const contextToClose = audioContext.current;
    const shouldCloseContext = ownsAudioContext.current;
    audioContext.current = null;
    ownsAudioContext.current = false;
    if (contextToClose && shouldCloseContext) {
      await contextToClose.close().catch(() => {
        // .close() rejects if already closed; safe to ignore.
      });
    }

    setIsMuted(false);
  }, [dataHandler, stopFftAnalyzer]);

  const stopMicWithRetries = useCallback(
    async (maxAttempts = 3, delayMs = 500) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await stop();
          return;
        } catch (e) {
          if (attempt < maxAttempts) {
            await new Promise((res) => setTimeout(res, delayMs));
          } else {
            const message = e instanceof Error ? e.message : 'Unknown error';
            onErrorRef.current?.(
              `Failed to stop mic after ${maxAttempts} attempts: ${message}`,
              'mic_closure_failure',
            );
          }
        }
      }
    },
    [stop],
  );

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
  }, [currentStream]);

  useEffect(() => {
    return () => {
      const recorderToStop = recorder.current;
      recorder.current = null;
      recorderToStop?.removeEventListener('dataavailable', dataHandler);
      try {
        recorderToStop?.stop();
      } catch {
        // The recorder may already be inactive during unmount.
      }

      stopFftAnalyzer();

      const streamToStop = currentStream.current;
      currentStream.current = null;
      streamToStop?.getTracks().forEach((track) => track.stop());

      const contextToClose = audioContext.current;
      const shouldCloseContext = ownsAudioContext.current;
      audioContext.current = null;
      ownsAudioContext.current = false;
      if (contextToClose && shouldCloseContext) {
        void contextToClose.close().catch(() => {
          // .close() rejects if already closed; safe to ignore.
        });
      }
    };
  }, [dataHandler, currentStream, stopFftAnalyzer]);

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
  }, []);

  return useMemo(
    () => ({
      start,
      stop: stopMicWithRetries,
      mute,
      unmute,
      isMuted,
      fftStore,
    }),
    [start, stopMicWithRetries, mute, unmute, isMuted, fftStore],
  );
};
