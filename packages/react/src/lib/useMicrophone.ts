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
const RECORDER_FINAL_DATA_TIMEOUT_MS = 1_000;

type DisposeMicrophoneOptions = {
  notifyStop?: boolean;
  preserveAudioContext?: boolean;
  preserveMute?: boolean;
  restoreOnFailure?: boolean;
};

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
  const recorderDataHandler = useRef<((event: BlobEvent) => void) | null>(null);
  const recordingStarted = useRef(false);
  const recordingGeneration = useRef(0);
  const pendingDataTasks = useRef(new Set<Promise<void>>());
  const microphoneOperationQueue = useRef<Promise<void>>(Promise.resolve());

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
      const generation = recordingGeneration.current;

      const task = blob
        .arrayBuffer()
        .then((buffer) => {
          if (
            buffer.byteLength > 0 &&
            generation === recordingGeneration.current
          ) {
            sendAudio.current?.(buffer);
          }
        })
        .catch((err) => {
          console.log(err);
        });
      pendingDataTasks.current.add(task);
      void task.then(
        () => pendingDataTasks.current.delete(task),
        () => pendingDataTasks.current.delete(task),
      );
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
    async (options: DisposeMicrophoneOptions = {}) => {
      const {
        notifyStop = true,
        preserveAudioContext = false,
        preserveMute = false,
        restoreOnFailure = true,
      } = options;
      const recorderToStop = recorder.current;
      const recorderHandlerToRemove =
        recorderDataHandler.current ?? dataHandler;
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
      recorderDataHandler.current = null;
      recordingStarted.current = false;
      if (!preserveAudioContext) {
        audioContext.current = null;
        ownsAudioContext.current = false;
      }

      stopFftAnalyzer();
      fftStore.clear();

      let recorderStopped = true;
      if (recorderToStop) {
        const removeDataHandler = () => {
          try {
            recorderToStop.removeEventListener(
              'dataavailable',
              recorderHandlerToRemove,
            );
          } catch (error) {
            console.error('Recorder listener cleanup failed.', error);
          }
        };
        let resolveRecorderStop = () => {};
        const recorderStopEvent = new Promise<void>((resolve) => {
          resolveRecorderStop = resolve;
        });
        const handleRecorderStop = () => {
          removeDataHandler();
          try {
            recorderToStop.removeEventListener('stop', handleRecorderStop);
          } catch (error) {
            console.error('Recorder listener cleanup failed.', error);
          }
          resolveRecorderStop();
        };
        const removeStopHandler = () => {
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
            removeStopHandler();
            stopListenerAttached = false;
          }
          if (errorName !== 'InvalidStateError') {
            recorderStopped = false;
            const message =
              error instanceof Error ? error.message : 'Unknown error';
            failures.push(`Recorder cleanup failed: ${message}`);
            if (!restoreOnFailure) {
              removeDataHandler();
            }
          } else {
            removeDataHandler();
          }
        }

        const finalDataDeadline = Date.now() + RECORDER_FINAL_DATA_TIMEOUT_MS;

        if (recorderStopped && stopListenerAttached) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const stopEventReceived = await Promise.race([
            recorderStopEvent.then(() => true),
            new Promise<boolean>((resolve) => {
              timeoutId = setTimeout(
                () => resolve(false),
                Math.max(0, finalDataDeadline - Date.now()),
              );
            }),
          ]);
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
          if (!stopEventReceived) {
            recorderStopped = false;
            removeDataHandler();
            removeStopHandler();
            failures.push('Recorder cleanup failed: stop event timed out');
          }
        } else if (recorderStopped) {
          removeDataHandler();
        }

        if (recorderStopped && pendingDataTasks.current.size > 0) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const finalDataFlushed = await Promise.race([
            Promise.allSettled([...pendingDataTasks.current]).then(() => true),
            new Promise<boolean>((resolve) => {
              timeoutId = setTimeout(
                () => resolve(false),
                Math.max(0, finalDataDeadline - Date.now()),
              );
            }),
          ]);
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
          if (!finalDataFlushed) {
            failures.push(
              'Recorder cleanup failed: final audio data timed out',
            );
          }
        }
      }
      if (!recorderStopped && restoreOnFailure) {
        recorder.current = recorderToStop;
        recorderDataHandler.current = recorderHandlerToRemove;
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
            failures.push(
              `Media track ${index + 1} cleanup failed: ${message}`,
            );
          }
        });
      }
      if (currentStream.current === streamToStop && tracksStopped) {
        currentStream.current = null;
      }

      if (recorderStopped && tracksStopped && !preserveMute) {
        isMutedRef.current = false;
        setIsMuted(false);
      }

      if (wasRecording && recorderStopped && notifyStop) {
        try {
          onStopRecordingRef.current?.();
        } catch (callbackError) {
          console.error('onStopRecording callback failed.', callbackError);
        }
      }

      if (contextToClose && shouldCloseContext && !preserveAudioContext) {
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
    },
    [dataHandler, fftStore, onStopRecordingRef, stopFftAnalyzer],
  );

  const reportClosureFailure = useCallback(
    (message: string, error: unknown) => {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      onErrorRef.current?.(`${message}: ${detail}`, 'mic_closure_failure');
    },
    [onErrorRef],
  );

  const enqueueMicrophoneOperation = useCallback(
    (operation: () => Promise<void>): Promise<void> => {
      const scheduled = microphoneOperationQueue.current.then(
        operation,
        operation,
      );
      microphoneOperationQueue.current = scheduled.catch(() => undefined);
      return scheduled;
    },
    [],
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
      recordingGeneration.current += 1;
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
        recorderDataHandler.current = dataHandler;
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

  const performReplace = useCallback(
    async (stream: MediaStream, sharedAudioContext?: AudioContext) => {
      if (!stream) {
        throw new Error('No stream connected');
      }

      const mimeType = mimeTypeRef.current;
      if (!mimeType) {
        throw new Error('No MimeType specified');
      }

      const currentContext = audioContext.current;
      if (
        !recorder.current ||
        !currentStream.current ||
        !currentContext ||
        !recordingStarted.current
      ) {
        throw new Error('The microphone is not recording.');
      }
      if (sharedAudioContext && sharedAudioContext !== currentContext) {
        throw new Error('The microphone audio context changed.');
      }

      const candidateBuffers: ArrayBuffer[] = [];
      const candidateTasks = new Set<Promise<void>>();
      let candidateMode: 'buffering' | 'forwarding' | 'disposed' = 'buffering';
      let candidateGeneration: number | null = null;
      let candidateDataChain = Promise.resolve();
      const candidateDataHandler = (event: BlobEvent) => {
        const task = candidateDataChain
          .then(() => event.data.arrayBuffer())
          .then((buffer) => {
            if (buffer.byteLength === 0 || candidateMode === 'disposed') {
              return;
            }
            if (candidateMode === 'buffering') {
              candidateBuffers.push(buffer);
            } else if (candidateGeneration === recordingGeneration.current) {
              sendAudio.current?.(buffer);
            }
          })
          .catch((error) => {
            console.log(error);
          });
        candidateDataChain = task;
        const tasks =
          candidateMode === 'buffering'
            ? candidateTasks
            : pendingDataTasks.current;
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      };

      let candidateRecorder: MediaRecorder | null = null;
      let candidateStarted = false;
      const disposeCandidate = () => {
        candidateMode = 'disposed';
        if (candidateRecorder) {
          try {
            candidateRecorder.removeEventListener(
              'dataavailable',
              candidateDataHandler,
            );
          } catch {
            // The listener may not have been installed.
          }
          if (candidateStarted) {
            try {
              candidateRecorder.stop();
            } catch {
              // The recorder may already have stopped.
            }
          }
        }
        try {
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          // The caller will receive the original startup failure.
        }
      };

      try {
        if (isMutedRef.current) {
          stream.getTracks().forEach((track) => {
            track.enabled = false;
          });
        }
        candidateRecorder = new MediaRecorder(stream, { mimeType });
        candidateRecorder.addEventListener(
          'dataavailable',
          candidateDataHandler,
        );
        candidateRecorder.start(100);
        candidateStarted = true;
      } catch (error) {
        disposeCandidate();
        throw error;
      }

      try {
        await disposeMicrophoneResources({
          notifyStop: false,
          preserveAudioContext: true,
          preserveMute: true,
          restoreOnFailure: false,
        });
      } catch (cleanupError) {
        // The replacement is already recording. Keep it authoritative even if
        // a nonstandard old recorder or track did not clean up cleanly.
        console.error(
          'Failed to fully retire the previous microphone resources.',
          cleanupError,
        );
      }

      recordingGeneration.current += 1;
      candidateGeneration = recordingGeneration.current;
      currentStream.current = stream;
      audioContext.current = currentContext;
      recorder.current = candidateRecorder;
      recorderDataHandler.current = candidateDataHandler;
      recordingStarted.current = true;

      try {
        startFftAnalyzer(stream);
      } catch (error) {
        stopFftAnalyzer();
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        console.error(`Failed to start mic analyzer: ${message}`);
      }
      if (isMutedRef.current) {
        fftStore.clear();
      }

      candidateMode = 'forwarding';
      candidateTasks.forEach((task) => {
        pendingDataTasks.current.add(task);
        void task.finally(() => pendingDataTasks.current.delete(task));
      });
      const bufferedCandidateAudio = candidateBuffers.splice(0);
      bufferedCandidateAudio.forEach((buffer) => sendAudio.current?.(buffer));
    },
    [
      disposeMicrophoneResources,
      fftStore,
      sendAudio,
      startFftAnalyzer,
      stopFftAnalyzer,
    ],
  );

  const replace = useCallback(
    (stream: MediaStream, sharedAudioContext?: AudioContext) =>
      enqueueMicrophoneOperation(() =>
        performReplace(stream, sharedAudioContext),
      ),
    [enqueueMicrophoneOperation, performReplace],
  );

  const stop = useCallback(
    () =>
      enqueueMicrophoneOperation(async () => {
        try {
          await disposeMicrophoneResources();
        } catch (e) {
          reportClosureFailure('Failed to fully stop microphone resources', e);
        }
      }),
    [
      disposeMicrophoneResources,
      enqueueMicrophoneOperation,
      reportClosureFailure,
    ],
  );

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
      void enqueueMicrophoneOperation(() => disposeMicrophoneResources()).catch(
        (e) => {
          console.error(
            'Failed to fully dispose microphone resources during unmount.',
            e,
          );
        },
      );
    };
  }, [disposeMicrophoneResources, enqueueMicrophoneOperation]);

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
      replace,
      stop,
      mute,
      unmute,
      isMuted,
      fftStore,
    }),
    [start, replace, stop, mute, unmute, isMuted, fftStore],
  );
};
