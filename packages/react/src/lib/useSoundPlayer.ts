import { convertBase64ToBlob } from 'hume';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AudioOutputMessage } from '../models/messages';
import { getDataProperty } from '../utils/aggregateErrors';
import { getBrowserErrorMessage } from '../utils/browserErrors';
import {
  appendCleanupFailures,
  throwCleanupFailures,
} from '../utils/cleanupErrors';
import { closeAudioContextWithTimeout } from '../utils/closeAudioContextWithTimeout';
import { getMonotonicTime } from '../utils/getMonotonicTime';
import { loadAudioWorklet } from '../utils/loadAudioWorklet';
import { convertLinearFrequenciesToBarkInto } from './convertFrequencyScale';
import {
  invokeIsolatedConsumerCallback,
  type VoiceDiagnosticsReporter,
} from './diagnostics';
import { FftStore } from './fftStore';
import { useLatestRef } from './useLatestRef';
import type { AudioPlayerErrorReason } from './VoiceProvider';

// Worklet message types (replaces Zod schemas)
interface WorkletStartClipMessage {
  type: 'start_clip';
  id: string;
  index: number;
}
interface WorkletEndedMessage {
  type: 'ended';
}
interface WorkletQueueLengthMessage {
  type: 'queueLength';
  length: number;
}
interface WorkletClosedMessage {
  type: 'worklet_closed';
}
type WorkletMessage =
  | WorkletStartClipMessage
  | WorkletEndedMessage
  | WorkletQueueLengthMessage
  | WorkletClosedMessage;

const workletMessageTypes = new Set([
  'ended',
  'queueLength',
  'start_clip',
  'worklet_closed',
]);

const getWorkletMessageType = (value: unknown) =>
  typeof value === 'object' && value !== null
    ? getDataProperty(value, 'type')?.value
    : undefined;

const isWorkletMessage = (value: unknown): value is WorkletMessage => {
  if (typeof value !== 'object' || value === null) return false;
  const type = getDataProperty(value, 'type')?.value;
  if (type === 'ended' || type === 'worklet_closed') return true;
  if (type === 'queueLength') {
    const length = getDataProperty(value, 'length')?.value;
    return (
      typeof length === 'number' && Number.isSafeInteger(length) && length >= 0
    );
  }
  return (
    type === 'start_clip' &&
    typeof getDataProperty(value, 'id')?.value === 'string' &&
    typeof getDataProperty(value, 'index')?.value === 'number'
  );
};

const supportsSetSinkId = (
  context: AudioContext,
): context is AudioContext & {
  setSinkId: (deviceId: string) => Promise<void>;
} => 'setSinkId' in context && typeof context.setSinkId === 'function';

const isAudioContextClosed = (context: AudioContext): boolean =>
  context.state === 'closed';

const releaseSafely = (
  failures: unknown[],
  label: string,
  action: () => void,
) => {
  try {
    action();
  } catch (error) {
    const detail = getBrowserErrorMessage(error) ?? 'Unknown error';
    failures.push(new Error(`${label}: ${detail}`, { cause: error }));
  }
};

const trackWeakMapPromise = <K extends object, V extends object>(
  map: WeakMap<K, V>,
  key: K,
  promise: Promise<void>,
  createValue: (trackedPromise: Promise<void>) => V,
): Promise<void> => {
  let trackedValue: V | null = null;
  const trackedPromise = promise.finally(() => {
    if (trackedValue !== null && map.get(key) === trackedValue) {
      map.delete(key);
    }
  });
  trackedValue = createValue(trackedPromise);
  map.set(key, trackedValue);
  return trackedPromise;
};

interface PlayerResources {
  context: AudioContext | null;
  ownsContext: boolean;
  playbackMode: 'buffer-source' | 'worklet';
  analyser: AnalyserNode | null;
  gain: GainNode | null;
  worklet: AudioWorkletNode | null;
  source: AudioBufferSourceNode | null;
  fftRafId: number | null;
  fftGeneration: number;
  malformedWorkletMessageReported: boolean;
  reportedUnknownWorkletMessageTypes: Set<string>;
}

interface TrackedPlayerStop {
  generation: number;
  promise: Promise<void>;
}

interface FailedPlayerContextRetry {
  attemptedResources: Set<PlayerResources>;
  pendingResources: Set<PlayerResources>;
  promise: Promise<void>;
  settled: boolean;
}

class PlayerInitializationFailure extends Error {
  readonly reason: AudioPlayerErrorReason;

  constructor(message: string, reason: AudioPlayerErrorReason) {
    super(message);
    this.name = 'PlayerInitializationFailure';
    this.reason = reason;
  }
}

const BARK_BAND_COUNT = 24;
/** Bound protocol-drift diagnostics retained during a player session. */
const MAX_REPORTED_UNKNOWN_WORKLET_MESSAGE_TYPES = 16;
/** Prevent an untrusted worklet payload from retaining an arbitrarily long key. */
const MAX_WORKLET_MESSAGE_TYPE_LENGTH = 128;

/** Require an idle period so the final render quantum reaches the output. */
const DRAIN_SETTLE_MS = 50;
/** Upper bound on how long a server-initiated disconnect waits for audio. */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
/**
 * When autoplay policy blocks a suspended AudioContext, `resume()` never
 * settles, so the attempt must be bounded rather than awaited directly.
 */
const RESUME_TIMEOUT_MS = 1_000;
/** Prevent repeated standalone initialization from retaining contexts forever. */
const MAX_RETAINED_PLAYER_CONTEXTS = 2;

/**
 * Options accepted by the deprecated standalone sound player.
 *
 * @deprecated Use {@link VoiceProvider} and {@link useVoice}.
 */
export interface UseSoundPlayerProps {
  /** Optional diagnostics reporter used by the standalone player. */
  diagnostics?: VoiceDiagnosticsReporter;
  /** Whether playback should use the AudioWorklet implementation. */
  enableAudioWorklet: boolean;
  /** Receives player failures that cannot be recovered internally. */
  onError: (message: string, reason: AudioPlayerErrorReason) => void;
  /** Called when playback starts for an audio message id. */
  onPlayAudio: (id: string) => void;
  /** Called when playback stops for an audio message id. */
  onStopAudio: (id: string) => void;
}

const usePlayerCallbackRefs = (props: UseSoundPlayerProps) => {
  const onPlayAudio = useLatestRef(props.onPlayAudio);
  const onStopAudio = useLatestRef(props.onStopAudio);
  const onError = useLatestRef(props.onError);
  const diagnostics = useLatestRef(props.diagnostics);
  return { diagnostics, onError, onPlayAudio, onStopAudio };
};

interface PlayerLifecyclePolicy {
  contextStopFailureMode: 'propagate' | 'report';
  errorCallbackOwner: 'consumer' | 'voice-provider';
  unmountCleanupOwner: 'player' | 'voice-provider';
}

const standalonePlayerLifecyclePolicy: PlayerLifecyclePolicy = {
  contextStopFailureMode: 'report',
  errorCallbackOwner: 'consumer',
  unmountCleanupOwner: 'player',
};

const voiceProviderPlayerLifecyclePolicy: PlayerLifecyclePolicy = {
  contextStopFailureMode: 'propagate',
  errorCallbackOwner: 'voice-provider',
  unmountCleanupOwner: 'voice-provider',
};

/**
 * The audio player itself. Its lifecycle policy independently selects cleanup
 * failure propagation, error callback ownership, and the owner responsible for
 * unmount disposal.
 *
 */
const useSoundPlayerImplementation = (
  props: UseSoundPlayerProps,
  lifecyclePolicy: PlayerLifecyclePolicy,
) => {
  const { contextStopFailureMode, errorCallbackOwner, unmountCleanupOwner } =
    lifecyclePolicy;
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [volume, setVolumeState] = useState<number>(1.0);
  const isAudioMutedRef = useRef(false);
  const volumeRef = useRef(1.0);

  const playerResources = useRef<PlayerResources | null>(null);
  const failedPlayerContextResources = useRef(new Set<PlayerResources>());
  const playerResourceDisposals = useRef(
    new WeakMap<PlayerResources, Promise<void>>(),
  );
  const failedPlayerContextRetry = useRef<FailedPlayerContextRetry | null>(
    null,
  );
  const playerStopPromises = useRef(
    new WeakMap<AudioContext, TrackedPlayerStop>(),
  );
  const implicitPlayerStop = useRef<TrackedPlayerStop | null>(null);
  const reportedPlayerStopPromises = useRef(
    new WeakMap<Promise<void>, Promise<void>>(),
  );
  const isInitialized = useRef(false);

  const isProcessing = useRef(false);

  const { diagnostics, onError, onPlayAudio, onStopAudio } =
    usePlayerCallbackRefs(props);

  const emitPlayerDiagnostic = useCallback(
    (input: Parameters<VoiceDiagnosticsReporter['emit']>[0]) => {
      try {
        diagnostics.current?.emit(input);
      } catch {
        // Custom diagnostics reporters must never affect player control flow.
      }
    },
    [diagnostics],
  );

  const isPlayerDiagnosticEnabled = useCallback(
    (level: Parameters<VoiceDiagnosticsReporter['isEnabled']>[0]) => {
      try {
        return diagnostics.current?.isEnabled(level) === true;
      } catch {
        return false;
      }
    },
    [diagnostics],
  );

  const reportPlayerResourceFailure = useCallback(
    (message: string, error: unknown) => {
      emitPlayerDiagnostic({
        level: 'warn',
        category: 'audio_player',
        name: 'resource.cleanup_failed',
        details: { resource: 'audio_player', message, error },
      });
    },
    [emitPlayerDiagnostic],
  );

  const reportPlayerError = useCallback(
    (
      message: string,
      reason: AudioPlayerErrorReason,
      propagateProviderFailure = false,
    ) => {
      if (errorCallbackOwner === 'voice-provider' && propagateProviderFailure) {
        onError.current(message, reason);
        return;
      }
      invokeIsolatedConsumerCallback(diagnostics.current, 'onError', () => {
        onError.current(message, reason);
      });
    },
    [diagnostics, errorCallbackOwner, onError],
  );

  const [fftStore] = useState(
    () =>
      new FftStore((error, context) => {
        reportPlayerResourceFailure(context, error);
      }),
  );

  const clearPlayerFftStore = useCallback(
    (message: string) => {
      // `message` also labels a cancellation failure the store reports through
      // its error observer, so both paths name the same call site.
      try {
        fftStore.clear(message);
      } catch (error) {
        reportPlayerResourceFailure(message, error);
      }
    },
    [fftStore, reportPlayerResourceFailure],
  );

  const reportPlayerAnalyzerFailure = useCallback(
    (error: unknown) => {
      const message = getBrowserErrorMessage(error) ?? 'Unknown error';
      emitPlayerDiagnostic({
        level: 'warn',
        category: 'audio_player',
        name: 'audio.analyzer_failed',
        details: { message, error },
      });
      clearPlayerFftStore(
        'Failed to reset FFT state after a player analyzer failure.',
      );
    },
    [clearPlayerFftStore, emitPlayerDiagnostic],
  );

  // chunkBufferQueues and lastQueuedChunk are used to make sure that
  // we don't play chunks out of order. chunkBufferQueues is NOT the
  // audio playback queue.
  const chunkBufferQueues = useRef(
    new Map<string, Array<AudioBuffer | undefined>>(),
  );
  const lastQueuedChunk = useRef<{ id: string; index: number } | null>(null);

  /**
   * Only for non-AudioWorklet mode.
   * In non-AudioWorklet mode, audio clips are managed and played sequentially.
   * When the current audio clip finishes, the next clip in the queue is played automatically.
   * In AudioWorklet mode, audio processing and playback are handled by the worklet itself.
   * In non-AudioWorklet, we must track the currently playing audio buffer
   * in order to stop it when a new clip is added or when playback is manually stopped by the user.
   */
  const clipQueue = useRef<
    Array<{
      id: string;
      buffer: AudioBuffer;
      index: number;
    }>
  >([]);
  const [queueLength, setQueueLength] = useState(0);
  // Authoritative mirrors of public playback state. They are updated before
  // React renders so drain waiters never observe a stale render.
  const queueLengthRef = useRef(0);
  const isPlayingRef = useRef(false);
  const drainWaiters = useRef(new Set<() => void>());
  const playerGeneration = useRef(0);
  const pendingAudioTasks = useRef(new Map<number, number>());
  const playbackActivitySequence = useRef(0);

  const notifyDrainWaiters = useCallback(() => {
    const waiters = [...drainWaiters.current];
    drainWaiters.current.clear();
    waiters.forEach((resolve) => resolve());
  }, []);

  const publishQueueLength = useCallback(
    (length: number) => {
      queueLengthRef.current = length;
      setQueueLength(length);
      notifyDrainWaiters();
      if (isPlayerDiagnosticEnabled('debug')) {
        emitPlayerDiagnostic({
          level: 'debug',
          category: 'audio_player',
          name: 'audio.queue_changed',
          details: { length },
        });
      }
    },
    [emitPlayerDiagnostic, isPlayerDiagnosticEnabled, notifyDrainWaiters],
  );

  const publishIsPlaying = useCallback(
    (playing: boolean) => {
      isPlayingRef.current = playing;
      setIsPlaying(playing);
      notifyDrainWaiters();
    },
    [notifyDrainWaiters],
  );

  const resetPlayerState = useCallback(
    (fftFailureMessage: string) => {
      isInitialized.current = false;
      isProcessing.current = false;
      publishIsPlaying(false);
      publishQueueLength(0);
      clearPlayerFftStore(fftFailureMessage);
      chunkBufferQueues.current.clear();
      lastQueuedChunk.current = null;
      clipQueue.current = [];
    },
    [clearPlayerFftStore, publishIsPlaying, publishQueueLength],
  );

  const cancelPlayerFft = useCallback((resources: PlayerResources) => {
    resources.fftGeneration += 1;
    const rafId = resources.fftRafId;
    resources.fftRafId = null;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
    }
  }, []);

  const cancelPlayerFftSafely = useCallback(
    (resources: PlayerResources, message: string) => {
      try {
        cancelPlayerFft(resources);
      } catch (error) {
        reportPlayerResourceFailure(message, error);
      }
    },
    [cancelPlayerFft, reportPlayerResourceFailure],
  );

  const closeOwnedPlayerContext = useCallback(
    async (resources: PlayerResources): Promise<Error | null> => {
      const context = resources.context;
      if (!context || !resources.ownsContext) {
        resources.context = null;
        resources.ownsContext = false;
        failedPlayerContextResources.current.delete(resources);
        return null;
      }

      let closeFailure: Error | null = null;
      if (!isAudioContextClosed(context)) {
        const closeResult = await closeAudioContextWithTimeout(context);
        // A close may finish immediately after the timeout wins its race.
        // Treat the context's terminal state as authoritative so a later
        // retry can release ownership without calling close() again.
        if (!closeResult.success && !isAudioContextClosed(context)) {
          closeFailure = closeResult.error;
        }
      }
      if (closeFailure === null) {
        resources.context = null;
        resources.ownsContext = false;
        failedPlayerContextResources.current.delete(resources);
        return null;
      }

      failedPlayerContextResources.current.add(resources);
      const activeRetry = failedPlayerContextRetry.current;
      if (
        activeRetry !== null &&
        !activeRetry.settled &&
        !activeRetry.attemptedResources.has(resources)
      ) {
        activeRetry.pendingResources.add(resources);
      }
      return new Error(
        `Audio context cleanup failed: ${closeFailure.message}`,
        { cause: closeFailure },
      );
    },
    [],
  );

  const disposePlayerResources = useCallback(
    (resources: PlayerResources): Promise<void> => {
      const existingDisposal = playerResourceDisposals.current.get(resources);
      if (existingDisposal) {
        return existingDisposal;
      }

      const performDisposal = async () => {
        if (playerResources.current === resources) {
          playerResources.current = null;
        }

        const failures: unknown[] = [];
        const release = (label: string, action: () => void) =>
          releaseSafely(failures, label, action);

        release('FFT cleanup failed', () => cancelPlayerFft(resources));

        const source = resources.source;
        resources.source = null;
        if (source) {
          release('Audio source listener cleanup failed', () => {
            source.onended = null;
          });
          release('Audio source stop failed', () => source.stop());
          release('Audio source disconnect failed', () => source.disconnect());
          isProcessing.current = false;
        }

        const worklet = resources.worklet;
        resources.worklet = null;
        if (worklet) {
          release('Audio worklet listener cleanup failed', () => {
            worklet.port.onmessage = null;
          });
          release('Audio worklet port cleanup failed', () =>
            worklet.port.close(),
          );
          release('Audio worklet disconnect failed', () =>
            worklet.disconnect(),
          );
        }

        const analyser = resources.analyser;
        resources.analyser = null;
        if (analyser) {
          release('Analyser disconnect failed', () => analyser.disconnect());
        }

        const gain = resources.gain;
        resources.gain = null;
        if (gain) {
          release('Gain disconnect failed', () => gain.disconnect());
        }

        const contextFailure = await closeOwnedPlayerContext(resources);
        if (contextFailure !== null) {
          failures.push(contextFailure);
        }

        throwCleanupFailures(failures, 'Audio player resource cleanup failed.');
      };

      return trackWeakMapPromise(
        playerResourceDisposals.current,
        resources,
        Promise.resolve().then(performDisposal),
        (trackedPromise) => trackedPromise,
      );
    },
    [cancelPlayerFft, closeOwnedPlayerContext],
  );

  const disposePlayerResourceBatch = useCallback(
    async (resources: readonly PlayerResources[]) => {
      const failureGroups = await Promise.all(
        [...new Set(resources)].map(async (resource) => {
          const failures: unknown[] = [];
          try {
            await disposePlayerResources(resource);
          } catch (error) {
            appendCleanupFailures(failures, error);
          }
          return failures;
        }),
      );
      const failures = failureGroups.flat();
      throwCleanupFailures(
        failures,
        'One or more audio player resources could not be cleaned up.',
      );
    },
    [disposePlayerResources],
  );

  const retryFailedPlayerContextClosures = useCallback(() => {
    const existingRetry = failedPlayerContextRetry.current;
    if (existingRetry !== null && !existingRetry.settled) {
      for (const resources of failedPlayerContextResources.current) {
        if (!existingRetry.attemptedResources.has(resources)) {
          existingRetry.pendingResources.add(resources);
        }
      }
      return existingRetry.promise;
    }
    const failedResources = [...failedPlayerContextResources.current];
    if (failedResources.length === 0) {
      return Promise.resolve();
    }

    const retry: FailedPlayerContextRetry = {
      attemptedResources: new Set(),
      pendingResources: new Set(failedResources),
      promise: Promise.resolve(),
      settled: false,
    };
    const retrying = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      try {
        while (retry.pendingResources.size > 0) {
          const resourcesToRetry = [...retry.pendingResources].filter(
            (resources) => !retry.attemptedResources.has(resources),
          );
          retry.pendingResources.clear();
          if (resourcesToRetry.length === 0) break;
          resourcesToRetry.forEach((resources) =>
            retry.attemptedResources.add(resources),
          );
          try {
            await disposePlayerResourceBatch(resourcesToRetry);
          } catch (error) {
            appendCleanupFailures(failures, error);
          }
        }
        throwCleanupFailures(
          failures,
          'One or more detached audio player contexts could not be closed.',
        );
      } finally {
        retry.settled = true;
      }
    });
    retry.promise = retrying;
    failedPlayerContextRetry.current = retry;
    const clearRetry = () => {
      if (failedPlayerContextRetry.current === retry) {
        failedPlayerContextRetry.current = null;
      }
    };
    void retrying.then(clearRetry, clearRetry);
    return retrying;
    // oxlint-disable-next-line react/memo-dependencies -- the explicit callback dependency preserves retry ownership if disposal behavior changes
  }, [disposePlayerResourceBatch]);

  const retryFailedPlayerContextClosuresBestEffort = useCallback(async () => {
    if (failedPlayerContextResources.current.size === 0) return;
    try {
      await retryFailedPlayerContextClosures();
    } catch (error) {
      reportPlayerResourceFailure(
        'Failed to close a previously detached audio player.',
        error,
      );
    }
  }, [reportPlayerResourceFailure, retryFailedPlayerContextClosures]);

  /**
   * Only for non-AudioWorklet mode.
   * This function is called when the current audio clip ends.
   * It will play the next clip in the queue if there is one.
   */
  const playNextClip = useCallback(
    function playNextClip() {
      // While a clip is mid-playback the queue may still hold entries, so
      // report its real length instead of zeroing it.
      if (clipQueue.current.length === 0 || isProcessing.current) {
        publishQueueLength(clipQueue.current.length);
        return;
      }

      const resources = playerResources.current;
      const context = resources?.context;
      const analyser = resources?.analyser;
      if (!resources || !context || !analyser) {
        reportPlayerError(
          'Audio player is not initialized',
          'audio_player_initialization_failure',
        );
        return;
      }
      const nextClip = clipQueue.current.shift();
      publishQueueLength(clipQueue.current.length);

      if (!nextClip) return;

      isProcessing.current = true;
      publishIsPlaying(true);

      const generation = playerGeneration.current;
      const bufferSource = context.createBufferSource();

      bufferSource.buffer = nextClip.buffer;

      bufferSource.connect(analyser);

      resources.source = bufferSource;

      const frequencyDataBuffer = new Uint8Array(analyser.frequencyBinCount);
      const barkBuffer = Array.from({ length: BARK_BAND_COUNT }, () => 0);

      const fftGeneration = ++resources.fftGeneration;
      const stopPollingAfterFailure = (error: unknown) => {
        if (resources.fftGeneration !== fftGeneration) return;
        resources.fftGeneration += 1;
        resources.fftRafId = null;
        reportPlayerAnalyzerFailure(error);
      };

      const pollFft = () => {
        if (
          generation !== playerGeneration.current ||
          playerResources.current !== resources ||
          resources.source !== bufferSource ||
          resources.fftGeneration !== fftGeneration
        ) {
          return;
        }
        resources.fftRafId = null;
        try {
          const bufferSampleRate = bufferSource.buffer?.sampleRate;
          if (typeof bufferSampleRate === 'undefined') return;

          analyser.getByteFrequencyData(frequencyDataBuffer);
          convertLinearFrequenciesToBarkInto(
            frequencyDataBuffer,
            bufferSampleRate,
            barkBuffer,
          );
          fftStore.write(barkBuffer);
          if (
            generation !== playerGeneration.current ||
            playerResources.current !== resources ||
            resources.source !== bufferSource ||
            resources.fftGeneration !== fftGeneration
          ) {
            return;
          }
          resources.fftRafId = requestAnimationFrame(pollFft);
        } catch (error) {
          stopPollingAfterFailure(error);
        }
      };
      try {
        resources.fftRafId = requestAnimationFrame(pollFft);
      } catch (error) {
        stopPollingAfterFailure(error);
      }

      bufferSource.start(0);
      if (nextClip.index === 0) {
        onPlayAudio.current(nextClip.id);
      }

      bufferSource.onended = () => {
        if (
          generation !== playerGeneration.current ||
          playerResources.current !== resources ||
          resources.source !== bufferSource
        ) {
          bufferSource.disconnect();
          return;
        }
        bufferSource.onended = null;
        cancelPlayerFftSafely(
          resources,
          'Failed to cancel the player analyzer animation frame.',
        );
        clearPlayerFftStore(
          'Failed to clear FFT state after audio playback ended.',
        );
        bufferSource.disconnect();
        isProcessing.current = false;
        publishIsPlaying(false);
        onStopAudio.current(nextClip.id);
        resources.source = null;
        playNextClip();
      };
    },
    [
      cancelPlayerFftSafely,
      clearPlayerFftStore,
      fftStore,
      onPlayAudio,
      onStopAudio,
      publishIsPlaying,
      publishQueueLength,
      reportPlayerError,
      reportPlayerAnalyzerFailure,
    ],
  );

  const initPlayer = useCallback(
    // fallow-ignore-next-line complexity -- initialization rollback spans behavior-sensitive Web Audio resources and generation ownership
    async (
      speakerDeviceId?: string,
      sharedAudioContext?: AudioContext,
    ): Promise<boolean> => {
      const generation = ++playerGeneration.current;
      notifyDrainWaiters();
      playbackActivitySequence.current = 0;
      resetPlayerState(
        'Failed to clear FFT state while initializing the player.',
      );

      const resourcesToReplace = playerResources.current;
      if (resourcesToReplace) {
        try {
          await disposePlayerResources(resourcesToReplace);
        } catch (error) {
          if (generation === playerGeneration.current) {
            const detail = getBrowserErrorMessage(error) ?? 'Unknown error';
            reportPlayerError(
              `Failed to replace audio player: ${detail}`,
              'audio_player_closure_failure',
              true,
            );
          }
          return false;
        }
        if (generation !== playerGeneration.current) {
          return false;
        }
      }

      const retainedContextRetry = retryFailedPlayerContextClosuresBestEffort();
      if (
        sharedAudioContext === undefined &&
        failedPlayerContextResources.current.size >=
          MAX_RETAINED_PLAYER_CONTEXTS
      ) {
        await retainedContextRetry;
        if (generation !== playerGeneration.current) {
          return false;
        }
        const retainedContextCount = failedPlayerContextResources.current.size;
        if (retainedContextCount >= MAX_RETAINED_PLAYER_CONTEXTS) {
          reportPlayerError(
            `Failed to initialize audio player because ${retainedContextCount} previous audio contexts could not be closed.`,
            'audio_player_closure_failure',
          );
          return false;
        }
      } else {
        void retainedContextRetry;
      }

      let resourcesForInitialization: PlayerResources | null = null;
      const cleanupInitialization = async (): Promise<string | null> => {
        const resources = resourcesForInitialization;
        resourcesForInitialization = null;
        if (resources) {
          try {
            await disposePlayerResources(resources);
          } catch (error) {
            reportPlayerResourceFailure(
              'Failed to clean up an incomplete audio player initialization.',
              error,
            );
            return getBrowserErrorMessage(error) ?? 'Unknown cleanup error';
          }
        }
        return null;
      };

      const failInitialization = async (
        message: string,
        reason: AudioPlayerErrorReason,
      ) => {
        let callbackFailure: unknown;
        let callbackFailureCaptured = false;
        let cleanupFailure: string | null = null;
        try {
          if (generation === playerGeneration.current) {
            isInitialized.current = false;
            try {
              reportPlayerError(message, reason, true);
            } catch (error) {
              callbackFailure = error;
              callbackFailureCaptured = true;
            }
          }
        } finally {
          cleanupFailure = await cleanupInitialization();
        }
        if (
          cleanupFailure !== null &&
          generation === playerGeneration.current &&
          !callbackFailureCaptured
        ) {
          reportPlayerError(
            `${message}; cleanup also failed: ${cleanupFailure}`,
            reason,
          );
        }
        if (callbackFailureCaptured) {
          throw callbackFailure;
        }
      };

      try {
        const initAudioContext = sharedAudioContext ?? new AudioContext();
        const resources: PlayerResources = {
          context: initAudioContext,
          ownsContext: !sharedAudioContext,
          playbackMode: props.enableAudioWorklet ? 'worklet' : 'buffer-source',
          analyser: null,
          gain: null,
          worklet: null,
          source: null,
          fftRafId: null,
          fftGeneration: 0,
          malformedWorkletMessageReported: false,
          reportedUnknownWorkletMessageTypes: new Set(),
        };
        resourcesForInitialization = resources;
        playerResources.current = resources;

        // An AudioContext created outside a user gesture starts 'suspended'
        // and renders no audio, so every queued clip would pile up silently.
        // Resume it here, and fail initialization loudly if the browser's
        // autoplay policy keeps it suspended.
        if (initAudioContext.state === 'suspended') {
          let resumeTimeoutId: ReturnType<typeof setTimeout> | undefined;
          const resumed = await Promise.race([
            initAudioContext.resume().then(
              () => true,
              () => false,
            ),
            new Promise<boolean>((resolve) => {
              resumeTimeoutId = setTimeout(
                () => resolve(false),
                RESUME_TIMEOUT_MS,
              );
            }),
          ]);
          if (resumeTimeoutId !== undefined) {
            clearTimeout(resumeTimeoutId);
          }
          if (generation !== playerGeneration.current) {
            await cleanupInitialization();
            return false;
          }
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- some browsers resolve resume() while leaving the context suspended
          if (!resumed || initAudioContext.state === 'suspended') {
            throw new PlayerInitializationFailure(
              'The browser blocked audio playback (autoplay policy). Connect from a user gesture, such as a click handler.',
              'audio_player_initialization_failure',
            );
          }
        }

        // Set the speaker device if specified and supported
        if (
          speakerDeviceId !== undefined &&
          speakerDeviceId !== '' &&
          supportsSetSinkId(initAudioContext)
        ) {
          try {
            await initAudioContext.setSinkId(speakerDeviceId);
          } catch (e) {
            if (generation !== playerGeneration.current) {
              await cleanupInitialization();
              return false;
            }
            reportPlayerError(
              `Failed to set speaker device: ${getBrowserErrorMessage(e) ?? 'Unknown error'}`,
              'audio_player_initialization_failure',
            );
            // Continue initialization even if setSinkId fails
          }
        }
        if (generation !== playerGeneration.current) {
          await cleanupInitialization();
          return false;
        }

        // Use AnalyserNode to get fft frequency data for visualizations
        const analyser = initAudioContext.createAnalyser();
        resources.analyser = analyser;
        // Use GainNode to adjust volume
        const gain = initAudioContext.createGain();
        resources.gain = gain;
        gain.gain.setValueAtTime(
          isAudioMutedRef.current ? 0 : volumeRef.current,
          initAudioContext.currentTime,
        );

        analyser.fftSize = 2048; // Must be a power of 2
        analyser.connect(gain);
        gain.connect(initAudioContext.destination);

        if (resources.playbackMode === 'worklet') {
          const isWorkletLoaded = await loadAudioWorklet(initAudioContext);
          if (generation !== playerGeneration.current) {
            await cleanupInitialization();
            return false;
          }
          if (!isWorkletLoaded) {
            throw new PlayerInitializationFailure(
              'Failed to load audio worklet',
              'audio_worklet_load_failure',
            );
          }

          const worklet = new AudioWorkletNode(
            initAudioContext,
            'audio-processor',
          );
          resources.worklet = worklet;
          worklet.connect(analyser);

          // fallow-ignore-next-line complexity -- the worklet protocol handler must validate ownership and every audio control message before mutating playback state
          worklet.port.onmessage = (e: MessageEvent) => {
            if (
              generation !== playerGeneration.current ||
              playerResources.current !== resources
            ) {
              return;
            }
            const data: unknown = e.data;
            const messageType = getWorkletMessageType(data);
            if (
              typeof messageType === 'string' &&
              !workletMessageTypes.has(messageType)
            ) {
              // The worklet is loaded remotely and may add control messages
              // before this SDK learns how to consume them. Unknown extensions
              // must remain forward-compatible no-ops.
              const diagnosticMessageType = messageType.slice(
                0,
                MAX_WORKLET_MESSAGE_TYPE_LENGTH,
              );
              if (
                resources.reportedUnknownWorkletMessageTypes.size <
                  MAX_REPORTED_UNKNOWN_WORKLET_MESSAGE_TYPES &&
                !resources.reportedUnknownWorkletMessageTypes.has(
                  diagnosticMessageType,
                ) &&
                isPlayerDiagnosticEnabled('debug')
              ) {
                resources.reportedUnknownWorkletMessageTypes.add(
                  diagnosticMessageType,
                );
                emitPlayerDiagnostic({
                  level: 'debug',
                  category: 'audio_player',
                  name: 'audio.worklet_message_ignored',
                  details: { messageType: diagnosticMessageType },
                });
              }
              return;
            }
            if (!isWorkletMessage(data)) {
              if (!resources.malformedWorkletMessageReported) {
                resources.malformedWorkletMessageReported = true;
                reportPlayerError(
                  'Audio worklet returned an invalid control message.',
                  'malformed_audio',
                );
              }
              return;
            }

            switch (data.type) {
              case 'start_clip':
                if (data.index === 0) {
                  onPlayAudio.current(data.id);
                }
                publishIsPlaying(true);
                break;

              case 'ended':
                publishIsPlaying(false);
                onStopAudio.current('stream');
                break;

              case 'queueLength':
                if (data.length === 0) {
                  publishIsPlaying(false);
                }
                publishQueueLength(data.length);
                break;

              case 'worklet_closed':
                break;
            }
          };

          // Pre-allocate buffers for FFT analysis (zero allocations per frame)
          const frequencyDataBuffer = new Uint8Array(
            analyser.frequencyBinCount,
          );
          const barkBuffer = Array.from({ length: BARK_BAND_COUNT }, () => 0);
          const fftGeneration = ++resources.fftGeneration;
          const stopPollingAfterFailure = (error: unknown) => {
            if (resources.fftGeneration !== fftGeneration) return;
            resources.fftGeneration += 1;
            resources.fftRafId = null;
            reportPlayerAnalyzerFailure(error);
          };

          // Use requestAnimationFrame instead of setInterval(5ms) for display-rate updates
          const pollFft = () => {
            if (
              generation !== playerGeneration.current ||
              playerResources.current !== resources ||
              resources.fftGeneration !== fftGeneration
            ) {
              return;
            }
            resources.fftRafId = null;
            try {
              analyser.getByteFrequencyData(frequencyDataBuffer);
              convertLinearFrequenciesToBarkInto(
                frequencyDataBuffer,
                initAudioContext.sampleRate,
                barkBuffer,
              );
              fftStore.write(barkBuffer);
              if (
                generation !== playerGeneration.current ||
                playerResources.current !== resources ||
                resources.fftGeneration !== fftGeneration
              ) {
                return;
              }
              resources.fftRafId = requestAnimationFrame(pollFft);
            } catch (error) {
              stopPollingAfterFailure(error);
            }
          };
          try {
            resources.fftRafId = requestAnimationFrame(pollFft);
          } catch (error) {
            stopPollingAfterFailure(error);
          }
        }
        isInitialized.current = true;
        // Initialization is complete. Release rollback ownership while
        // `playerResources` retains ownership of the live audio graph.
        resourcesForInitialization = null;
        return true;
      } catch (error) {
        if (error instanceof PlayerInitializationFailure) {
          await failInitialization(error.message, error.reason);
          return false;
        }
        const detail = getBrowserErrorMessage(error);
        await failInitialization(
          detail !== null
            ? `Failed to initialize audio player: ${detail}`
            : 'Failed to initialize audio player',
          'audio_player_initialization_failure',
        );
        return false;
      }
    },
    [
      disposePlayerResources,
      emitPlayerDiagnostic,
      props.enableAudioWorklet,
      fftStore,
      isAudioMutedRef,
      isPlayerDiagnosticEnabled,
      notifyDrainWaiters,
      onPlayAudio,
      onStopAudio,
      publishIsPlaying,
      publishQueueLength,
      reportPlayerAnalyzerFailure,
      reportPlayerError,
      reportPlayerResourceFailure,
      resetPlayerState,
      retryFailedPlayerContextClosuresBestEffort,
      volumeRef,
    ],
  );

  const convertToAudioBuffer = useCallback(
    async (message: AudioOutputMessage, context: AudioContext) => {
      const blob = convertBase64ToBlob(message.data);
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await context.decodeAudioData(arrayBuffer);
      return audioBuffer;
    },
    [],
  );

  const getNextAudioBuffers = useCallback(
    (message: AudioOutputMessage, audioBuffer: AudioBuffer) => {
      //1. Add the current buffer to the queue
      let queueForCurrMessage = chunkBufferQueues.current.get(message.id);
      if (queueForCurrMessage === undefined) {
        queueForCurrMessage = [];
        chunkBufferQueues.current.set(message.id, queueForCurrMessage);
      }
      queueForCurrMessage[message.index] = audioBuffer;

      // 2. Now collect buffers that are ready to be played
      const lastId = lastQueuedChunk.current?.id;
      const buffers: Array<{ id: string; index: number; buffer: AudioBuffer }> =
        [];

      // If the current message ID is different from the last one that was added
      // to the queue, that means that we're playing a new message now, so the first chunk
      // we play needs to be at index 0.
      if (message.id !== lastId) {
        if (queueForCurrMessage[0]) {
          lastQueuedChunk.current = { id: message.id, index: 0 };
          buffers.push({
            id: message.id,
            index: 0,
            buffer: queueForCurrMessage[0],
          });
          // Every time we add a buffer to the buffers array, we set the current index to undefined.
          // This is so that we don't try to add the same buffer to the buffers array again the next
          // time we call this function.
          queueForCurrMessage[0] = undefined;
        } else {
          // If the current index is not 0, that means the chunks came out of order,
          // so we return an empty array instead of returning anything to be added to the queue.
          return [];
        }
      }

      // Drain the queue - basically if any chunks were received out of order previously,
      // and they're now ready to be played because the earlier chunks
      // have been received, we can add them to the buffers array.
      let nextIdx = (lastQueuedChunk.current?.index ?? 0) + 1;
      let nextBuf = queueForCurrMessage[nextIdx];
      while (nextBuf !== undefined) {
        buffers.push({ index: nextIdx, buffer: nextBuf, id: message.id });
        // As above re: setting queueForCurrMessage[nextIdx] to undefined
        queueForCurrMessage[nextIdx] = undefined;
        lastQueuedChunk.current = { id: message.id, index: nextIdx };
        nextIdx += 1;
        nextBuf = queueForCurrMessage[nextIdx];
      }

      return buffers;
    },
    [],
  );

  const addToQueue = useCallback(
    // fallow-ignore-next-line complexity -- queue validation and generation checks preserve ordered streaming audio playback
    async (message: AudioOutputMessage) => {
      const generation = playerGeneration.current;
      const resources = playerResources.current;
      const context = resources?.context;
      if (!isInitialized.current || !resources || !context) {
        reportPlayerError(
          'Audio player has not been initialized',
          'audio_player_not_initialized',
        );
        return;
      }

      pendingAudioTasks.current.set(
        generation,
        (pendingAudioTasks.current.get(generation) ?? 0) + 1,
      );
      playbackActivitySequence.current += 1;
      notifyDrainWaiters();
      try {
        const audioBuffer = await convertToAudioBuffer(message, context);
        if (
          generation !== playerGeneration.current ||
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- initialization can change while audio decoding awaits
          !isInitialized.current ||
          playerResources.current !== resources
        ) {
          return;
        }
        // Because converting the data to an audio buffer is async, chunks that
        // are only a few ms apart can end up converting out of order. Preserve
        // playback order before adding the ready buffers to the player queue.
        const playableBuffers = getNextAudioBuffers(message, audioBuffer);
        if (playableBuffers.length === 0) {
          return;
        }

        for (const nextAudioBufferToPlay of playableBuffers) {
          if (generation !== playerGeneration.current) {
            return;
          }
          if (resources.playbackMode === 'worklet') {
            // AudioWorklet mode
            const pcmData = nextAudioBufferToPlay.buffer.getChannelData(0);
            resources.worklet?.port.postMessage({
              type: 'audio',
              data: pcmData,
              id: nextAudioBufferToPlay.id,
              index: nextAudioBufferToPlay.index,
            });
          } else {
            // Non-AudioWorklet mode
            clipQueue.current.push({
              id: nextAudioBufferToPlay.id,
              buffer: nextAudioBufferToPlay.buffer,
              index: nextAudioBufferToPlay.index,
            });
            publishQueueLength(clipQueue.current.length);
            // playNextClip will iterate the queue when playback ends, so it
            // only needs to be started when this is the first queued clip.
            if (clipQueue.current.length === 1) {
              playNextClip();
            }
          }
        }
      } catch (e) {
        const eMessage = getBrowserErrorMessage(e) ?? 'Unknown error';
        reportPlayerError(
          `Failed to add clip to queue: ${eMessage}`,
          'malformed_audio',
        );
      } finally {
        const remaining = (pendingAudioTasks.current.get(generation) ?? 1) - 1;
        if (remaining === 0) {
          pendingAudioTasks.current.delete(generation);
        } else {
          pendingAudioTasks.current.set(generation, remaining);
        }
        notifyDrainWaiters();
      }
    },
    [
      convertToAudioBuffer,
      getNextAudioBuffers,
      notifyDrainWaiters,
      playNextClip,
      publishQueueLength,
      reportPlayerError,
    ],
  );

  /**
   * Resolve once the queue has emptied and playback has finished, or once
   * `timeoutMs` has elapsed. Resolves `true` if the audio drained, `false` if
   * the timeout won.
   *
   * Used so a server-initiated disconnect can let the assistant finish its
   * current sentence. A disconnect the consumer asked for should call
   * `stopAll` directly instead, cutting audio immediately.
   */
  const waitForQueueToDrain = useCallback(
    // fallow-ignore-next-line complexity -- drain completion races queue progress against a bounded disconnect timeout
    async (timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<boolean> => {
      const startedAt = getMonotonicTime();
      const finish = (drained: boolean) => {
        emitPlayerDiagnostic({
          level: drained ? 'info' : 'warn',
          category: 'audio_player',
          name: 'audio.drain_completed',
          durationMs: getMonotonicTime() - startedAt,
          details: { drained, timeoutMs },
        });
        return drained;
      };
      const generation = playerGeneration.current;
      const isDrained = () =>
        (pendingAudioTasks.current.get(generation) ?? 0) === 0 &&
        queueLengthRef.current === 0 &&
        !isPlayingRef.current;

      // Preserve the zero-work fast path. Once audio work has started, require
      // a stable idle period so an in-flight decode or the worklet's final
      // render quantum cannot race teardown.
      if (isDrained() && playbackActivitySequence.current === 0) {
        return finish(true);
      }

      const deadline = Date.now() + timeoutMs;
      let stableSince: number | null = null;
      let observedActivitySequence = playbackActivitySequence.current;

      const waitForPlaybackChange = (waitMs: number) =>
        new Promise<void>((resolve) => {
          const timer: { id?: ReturnType<typeof setTimeout> } = {};
          const settle = () => {
            drainWaiters.current.delete(settle);
            if (timer.id !== undefined) {
              clearTimeout(timer.id);
            }
            resolve();
          };
          drainWaiters.current.add(settle);
          timer.id = setTimeout(settle, waitMs);
        });

      while (Date.now() <= deadline) {
        if (generation !== playerGeneration.current) {
          return finish(false);
        }
        const now = Date.now();
        const currentActivitySequence = playbackActivitySequence.current;
        if (currentActivitySequence !== observedActivitySequence) {
          observedActivitySequence = currentActivitySequence;
          stableSince = null;
        }

        const drained = isDrained();
        if (drained) {
          stableSince ??= now;
          if (now - stableSince >= DRAIN_SETTLE_MS) {
            return finish(true);
          }
        } else {
          stableSince = null;
        }

        const remainingMs = deadline - now;
        if (remainingMs <= 0) {
          break;
        }
        const settleRemainingMs =
          drained && stableSince !== null
            ? DRAIN_SETTLE_MS - (now - stableSince)
            : remainingMs;
        await waitForPlaybackChange(
          Math.max(1, Math.min(remainingMs, settleRemainingMs)),
        );
      }

      // The queue never emptied. The caller stops the player anyway rather
      // than leaving the socket teardown hanging on stuck audio.
      return finish(false);
    },
    [emitPlayerDiagnostic],
  );

  const stopAll = useCallback(
    // fallow-ignore-next-line complexity -- shutdown aggregates independent Web Audio cleanup failures without abandoning later resources
    async (expectedContext?: AudioContext) => {
      const currentResources = playerResources.current;
      const resourcesToStop =
        expectedContext === undefined ||
        currentResources?.context === expectedContext
          ? currentResources
          : null;
      const failedResourcesToRetry = [
        ...failedPlayerContextResources.current,
      ].filter(
        (resources) =>
          resources !== resourcesToStop &&
          (expectedContext === undefined ||
            resources.context === expectedContext),
      );

      if (
        expectedContext !== undefined &&
        resourcesToStop === null &&
        failedResourcesToRetry.length === 0
      ) {
        return;
      }

      // An implicit stop owns the overall player state. A context-scoped stop
      // only resets it when that context is still the active player; retrying a
      // detached context must not invalidate a newer player.
      if (expectedContext === undefined || resourcesToStop !== null) {
        playerGeneration.current += 1;
        notifyDrainWaiters();
        if (resourcesToStop && playerResources.current === resourcesToStop) {
          playerResources.current = null;
        }
        resetPlayerState(
          'Failed to clear FFT state while stopping the player.',
        );
      }

      if (!resourcesToStop && failedResourcesToRetry.length === 0) {
        return;
      }

      let stopScope = 'active_player';
      if (resourcesToStop === null) {
        stopScope = 'detached_context_retry';
      } else if (failedResourcesToRetry.length > 0) {
        stopScope = 'active_player_with_detached_retry';
      }
      const stopStartedAt = getMonotonicTime();
      emitPlayerDiagnostic({
        level: 'info',
        category: 'audio_player',
        name: 'resource.stop_started',
        details: { resource: 'audio_player', scope: stopScope },
      });
      const workletToStop = resourcesToStop?.worklet ?? null;

      const failures: unknown[] = [];
      const release = (label: string, action: () => void) =>
        releaseSafely(failures, label, action);

      if (resourcesToStop) {
        release('FFT cleanup failed', () => cancelPlayerFft(resourcesToStop));
      }

      if (workletToStop) {
        // AudioWorklet mode
        let isWorkletClosed = false;
        release('Audio worklet close listener setup failed', () => {
          workletToStop.port.onmessage = (e: MessageEvent) => {
            const data: unknown = e.data;
            if (isWorkletMessage(data) && data.type === 'worklet_closed') {
              isWorkletClosed = true;
            }
          };
        });
        release('Audio worklet fade request failed', () => {
          workletToStop.port.postMessage({ type: 'fadeAndClear' });
        });
        release('Audio worklet close request failed', () => {
          workletToStop.port.postMessage({ type: 'end' });
        });

        // Wait for the worklet's fade-out acknowledgement before disconnecting
        // its nodes, bounded to 500 ms.
        let closed = 0;
        while (closed < 5) {
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the worklet message callback mutates this flag asynchronously
          if (isWorkletClosed) {
            break;
          }
          closed += 1;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      try {
        await disposePlayerResourceBatch([
          ...(resourcesToStop ? [resourcesToStop] : []),
          ...failedResourcesToRetry,
        ]);
      } catch (error) {
        appendCleanupFailures(failures, error);
      }

      if (failures.length > 0) {
        emitPlayerDiagnostic({
          level: 'warn',
          category: 'audio_player',
          name: 'resource.cleanup_failed',
          durationMs: getMonotonicTime() - stopStartedAt,
          details: {
            operation: 'stop',
            resource: 'audio_player',
            scope: stopScope,
            failureCount: failures.length,
          },
        });
        throwCleanupFailures(failures, 'Audio player cleanup failed.');
      }
      emitPlayerDiagnostic({
        level: 'info',
        category: 'audio_player',
        name: 'resource.stopped',
        durationMs: getMonotonicTime() - stopStartedAt,
        details: { resource: 'audio_player', scope: stopScope },
      });
    },
    [
      cancelPlayerFft,
      disposePlayerResourceBatch,
      emitPlayerDiagnostic,
      notifyDrainWaiters,
      resetPlayerState,
    ],
  );

  const stopAllTracked = useCallback(
    (expectedContext?: AudioContext) => {
      const currentContext = playerResources.current?.context ?? null;
      const currentGeneration = playerGeneration.current;
      const existingImplicitStop = implicitPlayerStop.current;
      if (
        expectedContext === undefined &&
        existingImplicitStop &&
        existingImplicitStop.generation === currentGeneration
      ) {
        return existingImplicitStop.promise;
      }

      const context = expectedContext ?? currentContext ?? undefined;
      if (context) {
        const existingStop = playerStopPromises.current.get(context);
        if (existingStop && existingStop.generation === currentGeneration) {
          return existingStop.promise;
        }
      }

      let stopping = stopAll(expectedContext);
      const stopGeneration = playerGeneration.current;

      if (context) {
        stopping = trackWeakMapPromise(
          playerStopPromises.current,
          context,
          stopping,
          (trackedPromise) => ({
            generation: stopGeneration,
            promise: trackedPromise,
          }),
        );
      }

      if (expectedContext === undefined) {
        const trackedStop: TrackedPlayerStop = {
          generation: stopGeneration,
          promise: stopping,
        };
        implicitPlayerStop.current = trackedStop;
        const clearImplicitStop = () => {
          if (implicitPlayerStop.current === trackedStop) {
            implicitPlayerStop.current = null;
          }
        };
        void stopping.then(clearImplicitStop, clearImplicitStop);
      }
      return stopping;
    },
    [stopAll],
  );

  const stopAllAndReportWithPrefix = useCallback(
    (failurePrefix: string, expectedContext?: AudioContext) => {
      // This hook is publicly exported, so callers outside VoiceProvider can
      // request deduplicated cleanup without handling resource-level failures.
      const stopping = stopAllTracked(expectedContext);
      const existingReport = reportedPlayerStopPromises.current.get(stopping);
      if (existingReport) {
        return existingReport;
      }
      const reporting = stopping.catch((e: unknown) => {
        const message = getBrowserErrorMessage(e) ?? 'Unknown error';
        reportPlayerError(
          `${failurePrefix}: ${message}`,
          'audio_player_closure_failure',
        );
      });
      reportedPlayerStopPromises.current.set(stopping, reporting);
      return reporting;
    },
    [reportPlayerError, stopAllTracked],
  );

  const stopAllAndReport = useCallback(
    (expectedContext?: AudioContext) =>
      stopAllAndReportWithPrefix(
        'Failed to stop audio player',
        expectedContext,
      ),
    [stopAllAndReportWithPrefix],
  );

  const stopAllAndReportOnUnmount = useCallback(
    () =>
      stopAllAndReportWithPrefix(
        'Failed to dispose audio player while unmounting',
      ),
    [stopAllAndReportWithPrefix],
  );

  const stopAllForContext = useCallback(
    (context: AudioContext) =>
      contextStopFailureMode === 'propagate'
        ? stopAllTracked(context)
        : stopAllAndReport(context),
    [contextStopFailureMode, stopAllAndReport, stopAllTracked],
  );

  const clearQueue = useCallback(() => {
    const resources = playerResources.current;
    if (resources?.playbackMode === 'worklet') {
      // AudioWorklet mode
      try {
        resources.worklet?.port.postMessage({ type: 'fadeAndClear' });
      } catch (e) {
        const message = getBrowserErrorMessage(e) ?? 'Unknown error';
        reportPlayerError(
          `Failed to clear audio worklet queue: ${message}`,
          'audio_player_closure_failure',
        );
      }
    } else {
      // Non-AudioWorklet mode
      clipQueue.current = [];
      if (resources?.source) {
        const source = resources.source;
        const handleEnded = source.onended;
        cancelPlayerFftSafely(
          resources,
          'Failed to cancel the player analyzer animation frame while interrupting playback.',
        );
        try {
          source.stop();
        } catch {
          // The source may already have ended.
        } finally {
          if (resources.source === source) {
            handleEnded?.call(source, new Event('ended'));
          }
        }
      }
    }

    isProcessing.current = false;
    publishQueueLength(0);
    publishIsPlaying(false);
    clearPlayerFftStore(
      'Failed to clear FFT state while interrupting audio playback.',
    );
  }, [
    cancelPlayerFftSafely,
    clearPlayerFftStore,
    publishIsPlaying,
    publishQueueLength,
    reportPlayerError,
  ]);

  const setVolume = useCallback(
    (newLevel: number) => {
      const clampedLevel = Math.max(0, Math.min(newLevel, 1.0));
      volumeRef.current = clampedLevel;
      setVolumeState(clampedLevel);
      const resources = playerResources.current;
      if (resources?.gain && resources.context && !isAudioMutedRef.current) {
        resources.gain.gain.setValueAtTime(
          clampedLevel,
          resources.context.currentTime,
        );
      }
      emitPlayerDiagnostic({
        level: 'info',
        category: 'audio_player',
        name: 'control.changed',
        details: { control: 'volume', value: clampedLevel },
      });
    },
    [emitPlayerDiagnostic],
  );

  const setOutputDevice = useCallback(async (deviceId: string | null) => {
    const resources = playerResources.current;
    const context = resources?.context;
    const generation = playerGeneration.current;
    if (!resources || !context || !isInitialized.current) {
      throw new Error('The audio player is not initialized.');
    }

    if (!supportsSetSinkId(context)) {
      if (deviceId === null) {
        return;
      }
      throw new DOMException(
        'This browser does not support selecting an audio output device.',
        'NotSupportedError',
      );
    }

    await context.setSinkId(deviceId ?? '');
    if (
      generation !== playerGeneration.current ||
      playerResources.current !== resources ||
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- output selection awaits a browser promise while teardown may clear initialization
      !isInitialized.current
    ) {
      throw new DOMException(
        'The audio player changed while selecting an output device.',
        'AbortError',
      );
    }
  }, []);

  const muteAudio = useCallback(() => {
    isAudioMutedRef.current = true;
    setIsAudioMuted(true);
    const resources = playerResources.current;
    if (resources?.gain && resources.context) {
      resources.gain.gain.setValueAtTime(0, resources.context.currentTime);
    }
    emitPlayerDiagnostic({
      level: 'info',
      category: 'audio_player',
      name: 'control.changed',
      details: { control: 'audio_mute', value: true },
    });
  }, [emitPlayerDiagnostic]);

  const unmuteAudio = useCallback(() => {
    isAudioMutedRef.current = false;
    setIsAudioMuted(false);
    const resources = playerResources.current;
    if (resources?.gain && resources.context) {
      resources.gain.gain.setValueAtTime(
        volumeRef.current,
        resources.context.currentTime,
      );
    }
    emitPlayerDiagnostic({
      level: 'info',
      category: 'audio_player',
      name: 'control.changed',
      details: { control: 'audio_mute', value: false },
    });
  }, [emitPlayerDiagnostic]);

  // VoiceProvider owns ordered teardown of its shared resources. The standalone
  // hook has no parent owner, so unmount starts the same tracked shutdown used
  // by explicit stops, including the worklet fade/close handshake.
  useEffect(
    () => () => {
      if (unmountCleanupOwner === 'voice-provider') {
        playerGeneration.current += 1;
        notifyDrainWaiters();
        const resources = playerResources.current;
        if (resources) {
          cancelPlayerFftSafely(
            resources,
            'Failed to cancel the player analyzer animation frame while unmounting.',
          );
        }
        clearPlayerFftStore(
          'Failed to clear FFT state while unmounting the player.',
        );
        return;
      }

      const pendingImplicitStop = implicitPlayerStop.current;
      const joiningPendingImplicitStop =
        playerResources.current === null &&
        pendingImplicitStop !== null &&
        pendingImplicitStop.generation === playerGeneration.current;
      if (joiningPendingImplicitStop) {
        playerGeneration.current += 1;
        notifyDrainWaiters();
        if (failedPlayerContextResources.current.size === 0) {
          return;
        }
      }
      if (
        playerResources.current !== null ||
        failedPlayerContextResources.current.size > 0
      ) {
        void stopAllAndReportOnUnmount();
        return;
      }

      // Even an uninitialized player may have an async initialization call
      // about to publish resources. Invalidate it without emitting a fake stop
      // lifecycle or publishing state for an unmounted hook.
      playerGeneration.current += 1;
      notifyDrainWaiters();
      clearPlayerFftStore(
        'Failed to clear FFT state while unmounting the player.',
      );
    },
    [
      cancelPlayerFftSafely,
      clearPlayerFftStore,
      notifyDrainWaiters,
      stopAllAndReportOnUnmount,
      unmountCleanupOwner,
    ],
  );

  return useMemo(
    () => ({
      addToQueue,
      fftStore,
      initPlayer,
      isPlaying,
      isAudioMuted,
      muteAudio,
      unmuteAudio,
      stopAll: stopAllAndReport,
      stopAllForContext,
      waitForQueueToDrain,
      clearQueue,
      volume,
      setVolume,
      setOutputDevice,
      queueLength,
    }),
    [
      addToQueue,
      fftStore,
      initPlayer,
      isPlaying,
      isAudioMuted,
      muteAudio,
      unmuteAudio,
      stopAllAndReport,
      stopAllForContext,
      waitForQueueToDrain,
      clearQueue,
      volume,
      setVolume,
      setOutputDevice,
      queueLength,
    ],
  );
};

/**
 * Stops player resources and reports teardown failures through `onError`.
 *
 * @deprecated Use {@link VoiceProvider} and {@link useVoice}. This wrapper is
 * retained for compatibility and will only be removed in a future breaking
 * release.
 */
export const useSoundPlayer = (props: UseSoundPlayerProps) =>
  useSoundPlayerImplementation(props, standalonePlayerLifecyclePolicy);

/**
 * Strict player cleanup used for provider-level failure aggregation.
 *
 * @internal
 */
export const useSoundPlayerForVoiceProvider = (props: UseSoundPlayerProps) =>
  useSoundPlayerImplementation(props, voiceProviderPlayerLifecyclePolicy);
