// cspell:ignore dataavailable
import { getBrowserSupportedMimeType, type MimeType } from 'hume';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getBrowserErrorMessage,
  getBrowserErrorName,
} from '../utils/browserErrors';
import {
  appendCleanupFailures,
  createCleanupError,
  throwCleanupFailures,
} from '../utils/cleanupErrors';
import { closeAudioContextWithTimeout } from '../utils/closeAudioContextWithTimeout';
import { stopMediaStreamTracks } from '../utils/stopMediaStreamTracks';
import { convertLinearFrequenciesToBarkInto } from './convertFrequencyScale';
import {
  createVoiceDiagnosticsReporter,
  invokeIsolatedConsumerCallback,
  type VoiceDiagnosticsReporter,
} from './diagnostics';
import { FftStore } from './fftStore';
import { useLatestRef } from './useLatestRef';
import type { MicErrorReason } from './VoiceProvider';

const BARK_BAND_COUNT = 24;
const MICROPHONE_RECORDING_UNSUPPORTED_MESSAGE =
  'This browser does not fully support microphone recording.';
const MICROPHONE_ALREADY_STARTED_MESSAGE =
  'The microphone is already recording. Stop it before starting again.';
const MICROPHONE_OPERATION_IN_PROGRESS_MESSAGE =
  'A microphone operation is still in progress. Wait for it before starting again.';
const RECORDER_FINAL_DATA_TIMEOUT_MS = 1_000;

const createMicrophoneAbortError = () =>
  new DOMException(
    'The microphone operation was interrupted by a lifecycle change.',
    'AbortError',
  );

const createContextualCleanupFailure = (
  context: string,
  cause: unknown,
): Error =>
  new Error(`${context}: ${getBrowserErrorMessage(cause) ?? 'Unknown error'}`, {
    cause,
  });

type DisposeMicrophoneOptions = {
  notifyStop?: boolean;
  preserveAudioContext?: boolean;
  preserveMute?: boolean;
  restoreOnFailure?: boolean;
};

/**
 * Configuration for the deprecated low-level microphone hook.
 *
 * @internal
 */
export type MicrophoneProps = {
  diagnostics?: VoiceDiagnosticsReporter;
  onAudioCaptured: (b: ArrayBuffer) => void;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onError: (message: string, reason: MicErrorReason) => void;
};

/**
 * Manage microphone capture independently of the voice provider.
 *
 * @internal
 */
export const useMicrophone = (props: MicrophoneProps) => {
  const { onAudioCaptured } = props;
  const fallbackDiagnostics = useRef<VoiceDiagnosticsReporter | null>(null);
  if (fallbackDiagnostics.current === null) {
    fallbackDiagnostics.current = createVoiceDiagnosticsReporter(
      () => undefined,
    );
  }
  const onErrorRef = useLatestRef(props.onError);
  const onStartRecordingRef = useLatestRef(props.onStartRecording);
  const onStopRecordingRef = useLatestRef(props.onStopRecording);
  const diagnostics = useLatestRef(
    props.diagnostics ?? fallbackDiagnostics.current,
  );
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);
  const enabledStateBeforeMute = useRef(
    new WeakMap<MediaStreamTrack, boolean>(),
  );
  const currentStream = useRef<MediaStream | null>(null);
  const retiredStreams = useRef(new Set<MediaStream>());

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
  const pendingMicrophoneOperationCount = useRef(0);
  const microphoneLifecycleGeneration = useRef(0);
  const microphoneMounted = useRef(false);

  const sendAudio = useLatestRef(onAudioCaptured);

  const applyMuteStateToStream = useCallback(
    (stream: MediaStream, muted: boolean) => {
      stream.getAudioTracks().forEach((track) => {
        if (muted) {
          if (!enabledStateBeforeMute.current.has(track)) {
            enabledStateBeforeMute.current.set(track, track.enabled);
          }
          track.enabled = false;
          return;
        }

        const previousEnabledState = enabledStateBeforeMute.current.get(track);
        if (previousEnabledState !== undefined) {
          track.enabled = previousEnabledState;
          enabledStateBeforeMute.current.delete(track);
        }
      });
    },
    [],
  );

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

  const retryRetiredMicrophoneStream = useCallback(
    (retiredStream: MediaStream): unknown[] => {
      const failures: unknown[] = [];
      if (!retiredStreams.current.has(retiredStream)) return failures;

      try {
        stopMediaStreamTracks(retiredStream);
        retiredStreams.current.delete(retiredStream);
      } catch (error) {
        appendCleanupFailures(failures, error);
      }

      return failures;
    },
    [],
  );

  const retryRetiredMicrophoneStreams = useCallback(
    (excludedStream: MediaStream | null = null): unknown[] => {
      const failures: unknown[] = [];

      for (const retiredStream of retiredStreams.current) {
        if (retiredStream === excludedStream) continue;
        failures.push(...retryRetiredMicrophoneStream(retiredStream));
      }

      return failures;
    },
    [retryRetiredMicrophoneStream],
  );

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
            if (diagnostics.current?.isEnabled('debug')) {
              diagnostics.current.emit({
                level: 'debug',
                category: 'microphone',
                name: 'microphone.audio_chunk_captured',
                details: { byteLength: buffer.byteLength },
              });
            }
            sendAudio.current?.(buffer);
          }
        })
        .catch((err) => {
          diagnostics.current?.emit({
            level: 'warn',
            category: 'microphone',
            name: 'resource.cleanup_failed',
            details: {
              resource: 'microphone',
              message: 'Failed to read captured microphone data.',
              error: err,
            },
          });
        });
      pendingDataTasks.current.add(task);
      void task.then(
        () => pendingDataTasks.current.delete(task),
        () => pendingDataTasks.current.delete(task),
      );
    },
    [diagnostics, sendAudio],
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
      const barkBuffer = Array.from({ length: BARK_BAND_COUNT }, () => 0);

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
      const failures: unknown[] = [];

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
          failures.push(
            createContextualCleanupFailure(
              'Media track enumeration failed',
              error,
            ),
          );
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
            diagnostics.current?.emit({
              level: 'warn',
              category: 'microphone',
              name: 'resource.cleanup_failed',
              details: {
                resource: 'microphone',
                message: 'Recorder listener cleanup failed.',
                error,
              },
            });
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
            diagnostics.current?.emit({
              level: 'warn',
              category: 'microphone',
              name: 'resource.cleanup_failed',
              details: {
                resource: 'microphone',
                message: 'Recorder listener cleanup failed.',
                error,
              },
            });
          }
          resolveRecorderStop();
        };
        const removeStopHandler = () => {
          try {
            recorderToStop.removeEventListener('stop', handleRecorderStop);
          } catch (error) {
            diagnostics.current?.emit({
              level: 'warn',
              category: 'microphone',
              name: 'resource.cleanup_failed',
              details: {
                resource: 'microphone',
                message: 'Recorder listener cleanup failed.',
                error,
              },
            });
          }
        };
        let stopListenerAttached = false;
        try {
          recorderToStop.addEventListener('stop', handleRecorderStop);
          stopListenerAttached = true;
        } catch (error) {
          diagnostics.current?.emit({
            level: 'warn',
            category: 'microphone',
            name: 'resource.cleanup_failed',
            details: {
              resource: 'microphone',
              message: 'Recorder stop listener setup failed.',
              error,
            },
          });
        }
        try {
          recorderToStop.stop();
        } catch (error) {
          const errorName = getBrowserErrorName(error);
          if (stopListenerAttached) {
            removeStopHandler();
            stopListenerAttached = false;
          }
          if (errorName !== 'InvalidStateError') {
            recorderStopped = false;
            failures.push(
              createContextualCleanupFailure('Recorder cleanup failed', error),
            );
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
            failures.push(
              new Error('Recorder cleanup failed: stop event timed out'),
            );
          }
        } else if (recorderStopped) {
          removeDataHandler();
        }

        if (recorderStopped && pendingDataTasks.current.size > 0) {
          const flushStartedAt = globalThis.performance?.now() ?? Date.now();
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const finalDataFlushed = await Promise.race([
            Promise.allSettled(pendingDataTasks.current).then(() => true),
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
              new Error('Recorder cleanup failed: final audio data timed out'),
            );
          }
          diagnostics.current?.emit({
            level: finalDataFlushed ? 'info' : 'warn',
            category: 'microphone',
            name: 'microphone.flush_completed',
            durationMs:
              (globalThis.performance?.now() ?? Date.now()) - flushStartedAt,
            details: { completed: finalDataFlushed },
          });
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
            failures.push(
              createContextualCleanupFailure(
                `Media track ${index + 1} cleanup failed`,
                error,
              ),
            );
          }
        });
      }
      if (currentStream.current === streamToStop && tracksStopped) {
        currentStream.current = null;
      }
      if (streamToStop && tracksStopped) {
        retiredStreams.current.delete(streamToStop);
      }

      for (const error of retryRetiredMicrophoneStreams(streamToStop)) {
        failures.push(
          createContextualCleanupFailure(
            'Retired media stream cleanup failed',
            error,
          ),
        );
      }

      if (recorderStopped && tracksStopped && !preserveMute) {
        isMutedRef.current = false;
        setIsMuted(false);
      }

      if (wasRecording && recorderStopped && notifyStop) {
        diagnostics.current?.emit({
          level: 'info',
          category: 'microphone',
          name: 'microphone.recording_stopped',
        });
        invokeIsolatedConsumerCallback(
          diagnostics.current,
          'onStopRecording',
          () => onStopRecordingRef.current?.(),
        );
      }

      if (contextToClose && shouldCloseContext && !preserveAudioContext) {
        const closeResult = await closeAudioContextWithTimeout(contextToClose);
        if (!closeResult.success) {
          failures.push(
            createContextualCleanupFailure(
              'Audio context cleanup failed',
              closeResult.error,
            ),
          );
        }
      }

      throwCleanupFailures(failures, 'Microphone resource cleanup failed.');
    },
    [
      dataHandler,
      diagnostics,
      fftStore,
      onStopRecordingRef,
      retryRetiredMicrophoneStreams,
      stopFftAnalyzer,
    ],
  );

  const reportClosureFailure = useCallback(
    (message: string, error: unknown) => {
      const detail = getBrowserErrorMessage(error) ?? 'Unknown error';
      onErrorRef.current?.(`${message}: ${detail}`, 'mic_closure_failure');
    },
    [onErrorRef],
  );

  const enqueueMicrophoneOperation = useCallback(
    (operation: () => Promise<void>): Promise<void> => {
      pendingMicrophoneOperationCount.current += 1;
      const scheduled = microphoneOperationQueue.current.then(
        operation,
        operation,
      );
      const tracked = scheduled.finally(() => {
        pendingMicrophoneOperationCount.current -= 1;
      });
      microphoneOperationQueue.current = tracked.catch(() => undefined);
      return tracked;
    },
    [],
  );

  const start = useCallback(
    (stream: MediaStream, sharedAudioContext?: AudioContext) => {
      if (
        !microphoneMounted.current ||
        pendingMicrophoneOperationCount.current > 0
      ) {
        throw new Error(MICROPHONE_OPERATION_IN_PROGRESS_MESSAGE);
      }

      const mimeType = mimeTypeRef.current;
      if (mimeType === null) {
        throw new Error('No MimeType specified');
      }

      if (recorder.current || currentStream.current || audioContext.current) {
        throw new Error(MICROPHONE_ALREADY_STARTED_MESSAGE);
      }

      const context = sharedAudioContext ?? new AudioContext();
      recordingGeneration.current += 1;
      currentStream.current = stream;
      ownsAudioContext.current = sharedAudioContext === undefined;
      audioContext.current = context;

      try {
        startFftAnalyzer(stream);
      } catch (e: unknown) {
        stopFftAnalyzer();
        const message = getBrowserErrorMessage(e) ?? 'Unknown error';
        diagnostics.current?.emit({
          level: 'warn',
          category: 'microphone',
          name: 'microphone.analyzer_failed',
          details: { message, error: e },
        });
      }

      try {
        if (isMutedRef.current) {
          applyMuteStateToStream(stream, true);
          fftStore.clear();
        }
        const nextRecorder = new MediaRecorder(stream, { mimeType });
        recorder.current = nextRecorder;
        recorderDataHandler.current = dataHandler;
        nextRecorder.addEventListener('dataavailable', dataHandler);
        nextRecorder.start(100);
        recordingStarted.current = true;
        diagnostics.current?.emit({
          level: 'info',
          category: 'microphone',
          name: 'microphone.recording_started',
          details: { mimeType },
        });
        try {
          onStartRecordingRef.current?.();
        } catch (callbackError) {
          diagnostics.current?.emit({
            level: 'warn',
            category: 'consumer',
            name: 'consumer.callback_failed',
            details: {
              callback: 'onStartRecording',
              error: callbackError,
            },
          });
          throw callbackError;
        }
      } catch (e) {
        void enqueueMicrophoneOperation(() =>
          disposeMicrophoneResources(),
        ).catch((cleanupError) => {
          reportClosureFailure(
            'Failed to fully roll back microphone initialization',
            cleanupError,
          );
        });
        throw e;
      }
    },
    [
      applyMuteStateToStream,
      dataHandler,
      diagnostics,
      disposeMicrophoneResources,
      enqueueMicrophoneOperation,
      fftStore,
      onStartRecordingRef,
      reportClosureFailure,
      startFftAnalyzer,
      stopFftAnalyzer,
    ],
  );

  const performReplace = useCallback(
    async (
      stream: MediaStream,
      sharedAudioContext: AudioContext | undefined,
      isCurrent: () => boolean,
    ) => {
      const stopCandidateStream = () => {
        try {
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          // A stale candidate must not mask the lifecycle interruption.
        }
      };
      if (!isCurrent()) {
        stopCandidateStream();
        throw createMicrophoneAbortError();
      }

      const mimeType = mimeTypeRef.current;
      if (mimeType === null) {
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
      const previousStream = currentStream.current;
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
          .catch((error: unknown) => {
            diagnostics.current?.emit({
              level: 'warn',
              category: 'microphone',
              name: 'resource.cleanup_failed',
              details: {
                resource: 'microphone',
                message: 'Failed to read replacement microphone data.',
                error,
              },
            });
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
        stopCandidateStream();
      };

      try {
        if (isMutedRef.current) {
          applyMuteStateToStream(stream, true);
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
        let diagnosticError = cleanupError;
        if (currentStream.current === previousStream) {
          retiredStreams.current.add(previousStream);
          const retryFailures = retryRetiredMicrophoneStream(previousStream);
          if (
            !retiredStreams.current.has(previousStream) &&
            currentStream.current === previousStream
          ) {
            currentStream.current = null;
          }
          if (retryFailures.length > 0) {
            diagnosticError = createCleanupError(
              [
                cleanupError,
                ...retryFailures.map((error) =>
                  createContextualCleanupFailure(
                    'Retired media stream cleanup failed',
                    error,
                  ),
                ),
              ],
              'Failed to retire previous microphone resources after retry.',
            );
          }
        }
        // The replacement is already recording. Keep it authoritative even if
        // a nonstandard old recorder or track did not clean up cleanly. Failed
        // streams stay retained so later replacements or teardown retry them.
        diagnostics.current?.emit({
          level: 'warn',
          category: 'microphone',
          name: 'resource.cleanup_failed',
          details: {
            resource: 'microphone',
            message:
              'Failed to fully retire previous or retained microphone resources.',
            error: diagnosticError,
          },
        });
      }

      if (!isCurrent()) {
        disposeCandidate();
        throw createMicrophoneAbortError();
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
        const message = getBrowserErrorMessage(error) ?? 'Unknown error';
        diagnostics.current?.emit({
          level: 'warn',
          category: 'microphone',
          name: 'microphone.analyzer_failed',
          details: { message, error },
        });
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
      applyMuteStateToStream,
      disposeMicrophoneResources,
      diagnostics,
      fftStore,
      retryRetiredMicrophoneStream,
      sendAudio,
      startFftAnalyzer,
      stopFftAnalyzer,
    ],
  );

  const replace = useCallback(
    (stream: MediaStream, sharedAudioContext?: AudioContext) => {
      const generation = microphoneLifecycleGeneration.current;
      const isCurrent = () =>
        microphoneMounted.current &&
        generation === microphoneLifecycleGeneration.current;
      return enqueueMicrophoneOperation(() =>
        performReplace(stream, sharedAudioContext, isCurrent),
      );
    },
    [enqueueMicrophoneOperation, performReplace],
  );

  const stop = useCallback(() => {
    const generation = microphoneLifecycleGeneration.current;
    return enqueueMicrophoneOperation(async () => {
      if (
        !microphoneMounted.current ||
        generation !== microphoneLifecycleGeneration.current
      ) {
        return;
      }
      try {
        await disposeMicrophoneResources();
      } catch (e) {
        reportClosureFailure('Failed to fully stop microphone resources', e);
      }
    });
  }, [
    disposeMicrophoneResources,
    enqueueMicrophoneOperation,
    reportClosureFailure,
  ]);

  const mute = useCallback(() => {
    isMutedRef.current = true;
    fftStore.clear();

    if (currentStream.current) {
      applyMuteStateToStream(currentStream.current, true);
    }

    setIsMuted(true);
    diagnostics.current?.emit({
      level: 'info',
      category: 'microphone',
      name: 'control.changed',
      details: { control: 'microphone_mute', value: true },
    });
  }, [applyMuteStateToStream, diagnostics, fftStore]);

  const unmute = useCallback(() => {
    isMutedRef.current = false;
    if (currentStream.current) {
      applyMuteStateToStream(currentStream.current, false);
    }

    setIsMuted(false);
    diagnostics.current?.emit({
      level: 'info',
      category: 'microphone',
      name: 'control.changed',
      details: { control: 'microphone_mute', value: false },
    });
  }, [applyMuteStateToStream, diagnostics]);

  useEffect(() => {
    microphoneMounted.current = true;
    microphoneLifecycleGeneration.current += 1;
    const cleanupDiagnostics = diagnostics.current;

    return () => {
      microphoneMounted.current = false;
      const cleanupGeneration = ++microphoneLifecycleGeneration.current;
      void enqueueMicrophoneOperation(async () => {
        if (
          microphoneMounted.current ||
          cleanupGeneration !== microphoneLifecycleGeneration.current
        ) {
          return;
        }
        await disposeMicrophoneResources();
      }).catch((e) => {
        cleanupDiagnostics?.emit({
          level: 'error',
          category: 'microphone',
          name: 'resource.cleanup_failed',
          details: {
            resource: 'microphone',
            message:
              'Failed to fully dispose microphone resources during unmount.',
            error: e,
          },
        });
      });
    };
  }, [diagnostics, disposeMicrophoneResources, enqueueMicrophoneOperation]);

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
      diagnostics.current?.emit({
        level: 'error',
        category: 'microphone',
        name: 'resource.cleanup_failed',
        details: {
          resource: 'microphone',
          message: 'Failed to detect supported microphone MIME types.',
          error: e,
        },
      });
      onErrorRef.current(
        MICROPHONE_RECORDING_UNSUPPORTED_MESSAGE,
        'mime_types_not_supported',
      );
      return;
    }

    if (mimeTypeResult.success) {
      mimeTypeRef.current = mimeTypeResult.mimeType;
      diagnostics.current?.emit({
        level: 'info',
        category: 'microphone',
        name: 'microphone.mime_type_selected',
        details: { mimeType: mimeTypeResult.mimeType },
      });
    } else {
      onErrorRef.current(
        mimeTypeResult.error.message,
        'mime_types_not_supported',
      );
    }
  }, [diagnostics, onErrorRef]);

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
