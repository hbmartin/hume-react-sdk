import { convertBase64ToBlob } from 'hume';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { AudioOutputMessage } from '../models/messages';
import { getDataProperty } from '../utils/aggregateErrors';
import { getBrowserErrorMessage } from '../utils/browserErrors';
import { closeAudioContextWithTimeout } from '../utils/closeAudioContextWithTimeout';
import { loadAudioWorklet } from '../utils/loadAudioWorklet';
import { convertLinearFrequenciesToBarkInto } from './convertFrequencyScale';
import type { VoiceDiagnosticsReporter } from './diagnostics';
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

const getMonotonicTime = () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- older embedded browsers can omit the typed Performance global
  return globalThis.performance?.now() ?? Date.now();
};

const releaseSafely = (
  failures: string[],
  label: string,
  action: () => void,
) => {
  try {
    action();
  } catch (error) {
    const detail = getBrowserErrorMessage(error) ?? 'Unknown error';
    failures.push(`${label}: ${detail}`);
  }
};

interface PlayerResources {
  context: AudioContext | null;
  ownsContext: boolean;
  analyser: AnalyserNode | null;
  gain: GainNode | null;
  worklet: AudioWorkletNode | null;
  source: AudioBufferSourceNode | null;
  fftRafId: number | null;
}

const BARK_BAND_COUNT = 24;

/** Require an idle period so the final render quantum reaches the output. */
const DRAIN_SETTLE_MS = 50;
/** Upper bound on how long a server-initiated disconnect waits for audio. */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
/**
 * When autoplay policy blocks a suspended AudioContext, `resume()` never
 * settles, so the attempt must be bounded rather than awaited directly.
 */
const RESUME_TIMEOUT_MS = 1_000;

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

/**
 * The audio player itself. `propagateContextStopFailures` selects between the
 * lenient teardown used in isolation and the strict aggregation the provider
 * relies on to report cleanup failures.
 *
 */
const useSoundPlayerImplementation = (
  props: UseSoundPlayerProps,
  propagateContextStopFailures: boolean,
) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [volume, setVolumeState] = useState<number>(1.0);
  const isAudioMutedRef = useRef(false);
  const volumeRef = useRef(1.0);

  const [fftStore] = useState(() => new FftStore());

  const playerResources = useRef<PlayerResources | null>(null);
  const playerStopPromises = useRef(new WeakMap<AudioContext, Promise<void>>());
  const implicitPlayerStopPromise = useRef<Promise<void> | null>(null);
  const isInitialized = useRef(false);

  const isProcessing = useRef(false);

  const onPlayAudio = useLatestRef(props.onPlayAudio);
  const onStopAudio = useLatestRef(props.onStopAudio);
  const onError = useLatestRef(props.onError);
  const diagnostics = useLatestRef(props.diagnostics);

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
      if (diagnostics.current?.isEnabled('debug') === true) {
        diagnostics.current.emit({
          level: 'debug',
          category: 'audio_player',
          name: 'audio.queue_changed',
          details: { length },
        });
      }
    },
    [diagnostics, notifyDrainWaiters],
  );

  const publishIsPlaying = useCallback(
    (playing: boolean) => {
      isPlayingRef.current = playing;
      setIsPlaying(playing);
      notifyDrainWaiters();
    },
    [notifyDrainWaiters],
  );

  const cancelPlayerFft = useCallback((resources: PlayerResources) => {
    const rafId = resources.fftRafId;
    resources.fftRafId = null;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
    }
  }, []);

  const disposePlayerResources = useCallback(
    async (resources: PlayerResources) => {
      if (playerResources.current === resources) {
        playerResources.current = null;
      }

      const failures: string[] = [];
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
        release('Audio worklet disconnect failed', () => worklet.disconnect());
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

      const context = resources.context;
      const shouldCloseContext = resources.ownsContext;
      resources.context = null;
      resources.ownsContext = false;
      if (context && shouldCloseContext) {
        const closeResult = await closeAudioContextWithTimeout(context);
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
    [cancelPlayerFft],
  );

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
        onError.current(
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

      const updateFrequencyData = () => {
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
        } catch {
          fftStore.clear();
        }
      };

      const pollFft = () => {
        if (
          generation !== playerGeneration.current ||
          playerResources.current !== resources
        ) {
          return;
        }
        updateFrequencyData();
        resources.fftRafId = requestAnimationFrame(pollFft);
      };
      resources.fftRafId = requestAnimationFrame(pollFft);

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
        cancelPlayerFft(resources);
        fftStore.clear();
        bufferSource.disconnect();
        isProcessing.current = false;
        publishIsPlaying(false);
        onStopAudio.current(nextClip.id);
        resources.source = null;
        playNextClip();
      };
    },
    [
      cancelPlayerFft,
      fftStore,
      onError,
      onPlayAudio,
      onStopAudio,
      publishIsPlaying,
      publishQueueLength,
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
      isInitialized.current = false;
      isProcessing.current = false;
      publishIsPlaying(false);
      publishQueueLength(0);
      chunkBufferQueues.current.clear();
      lastQueuedChunk.current = null;
      clipQueue.current = [];

      const resourcesToReplace = playerResources.current;
      if (resourcesToReplace) {
        await disposePlayerResources(resourcesToReplace);
        if (generation !== playerGeneration.current) {
          return false;
        }
      }

      let resourcesForInitialization: PlayerResources | null = null;

      const cleanupInitialization = async () => {
        const resources = resourcesForInitialization;
        resourcesForInitialization = null;
        if (resources) {
          await disposePlayerResources(resources);
        }
      };

      const abandonInitialization = async () => {
        await cleanupInitialization();
        return false;
      };

      const failInitialization = async (
        message: string,
        reason: AudioPlayerErrorReason,
      ) => {
        if (generation === playerGeneration.current) {
          isInitialized.current = false;
          onError.current(message, reason);
        }
        await cleanupInitialization();
        return false;
      };

      try {
        const initAudioContext = sharedAudioContext ?? new AudioContext();
        const resources: PlayerResources = {
          context: initAudioContext,
          ownsContext: !sharedAudioContext,
          analyser: null,
          gain: null,
          worklet: null,
          source: null,
          fftRafId: null,
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
            return await abandonInitialization();
          }
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- some browsers resolve resume() while leaving the context suspended
          if (!resumed || initAudioContext.state === 'suspended') {
            return await failInitialization(
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
              return await abandonInitialization();
            }
            onError.current(
              `Failed to set speaker device: ${getBrowserErrorMessage(e) ?? 'Unknown error'}`,
              'audio_player_initialization_failure',
            );
            // Continue initialization even if setSinkId fails
          }
        }
        if (generation !== playerGeneration.current) {
          return await abandonInitialization();
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

        if (props.enableAudioWorklet) {
          const isWorkletLoaded = await loadAudioWorklet(initAudioContext);
          if (generation !== playerGeneration.current) {
            return await abandonInitialization();
          }
          if (!isWorkletLoaded) {
            return await failInitialization(
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
              return;
            }
            if (!isWorkletMessage(data)) {
              onError.current(
                'Audio worklet returned an invalid control message.',
                'malformed_audio',
              );
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

          // Use requestAnimationFrame instead of setInterval(5ms) for display-rate updates
          const pollFft = () => {
            if (
              generation !== playerGeneration.current ||
              playerResources.current !== resources
            ) {
              void cleanupInitialization();
              return;
            }
            analyser.getByteFrequencyData(frequencyDataBuffer);
            convertLinearFrequenciesToBarkInto(
              frequencyDataBuffer,
              initAudioContext.sampleRate,
              barkBuffer,
            );
            fftStore.write(barkBuffer);
            if (
              generation !== playerGeneration.current ||
              playerResources.current !== resources
            ) {
              void cleanupInitialization();
              return;
            }
            resources.fftRafId = requestAnimationFrame(pollFft);
          };
          resources.fftRafId = requestAnimationFrame(pollFft);

          isInitialized.current = true;
        } else {
          isInitialized.current = true;
        }
        return true;
      } catch (_error) {
        return failInitialization(
          'Failed to initialize audio player',
          'audio_player_initialization_failure',
        );
      }
    },
    [
      disposePlayerResources,
      props.enableAudioWorklet,
      fftStore,
      isAudioMutedRef,
      notifyDrainWaiters,
      onError,
      onPlayAudio,
      onStopAudio,
      publishIsPlaying,
      publishQueueLength,
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
        onError.current(
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
          if (props.enableAudioWorklet) {
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
        onError.current(
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
      onError,
      playNextClip,
      props.enableAudioWorklet,
      publishQueueLength,
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
        diagnostics.current?.emit({
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
    [diagnostics],
  );

  const stopAll = useCallback(
    // fallow-ignore-next-line complexity -- shutdown aggregates independent Web Audio cleanup failures without abandoning later resources
    async (expectedContext?: AudioContext) => {
      if (
        expectedContext &&
        playerResources.current?.context !== expectedContext
      ) {
        return;
      }
      const generation = ++playerGeneration.current;
      const stopStartedAt = getMonotonicTime();
      diagnostics.current?.emit({
        level: 'info',
        category: 'audio_player',
        name: 'resource.stop_started',
        details: { resource: 'audio_player' },
      });
      notifyDrainWaiters();
      const resourcesToStop = playerResources.current;
      playerResources.current = null;
      const workletToStop = resourcesToStop?.worklet ?? null;
      isInitialized.current = false;
      isProcessing.current = false;
      publishIsPlaying(false);
      publishQueueLength(0);
      fftStore.clear();

      chunkBufferQueues.current.clear();
      lastQueuedChunk.current = null;
      clipQueue.current = [];

      const failures: string[] = [];
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
          if (generation !== playerGeneration.current || isWorkletClosed) {
            break;
          }
          closed += 1;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      if (resourcesToStop) {
        try {
          await disposePlayerResources(resourcesToStop);
        } catch (error) {
          failures.push(
            getBrowserErrorMessage(error) ?? 'Unknown cleanup error',
          );
        }
      }

      if (failures.length > 0) {
        throw new Error(failures.join('; '));
      }
      diagnostics.current?.emit({
        level: 'info',
        category: 'audio_player',
        name: 'resource.stopped',
        durationMs: getMonotonicTime() - stopStartedAt,
        details: { resource: 'audio_player' },
      });
    },
    [
      cancelPlayerFft,
      diagnostics,
      disposePlayerResources,
      fftStore,
      notifyDrainWaiters,
      publishIsPlaying,
      publishQueueLength,
    ],
  );

  const stopAllTracked = useCallback(
    (expectedContext?: AudioContext) => {
      if (expectedContext === undefined && implicitPlayerStopPromise.current) {
        return implicitPlayerStopPromise.current;
      }

      const context = expectedContext ?? playerResources.current?.context;
      if (context) {
        const existingStop = playerStopPromises.current.get(context);
        if (existingStop) {
          return existingStop;
        }
      }

      const stopping = stopAll(expectedContext);

      if (expectedContext === undefined) {
        implicitPlayerStopPromise.current = stopping;
        const clearImplicitStop = () => {
          if (implicitPlayerStopPromise.current === stopping) {
            implicitPlayerStopPromise.current = null;
          }
        };
        void stopping.then(clearImplicitStop, clearImplicitStop);
      }

      if (context) {
        playerStopPromises.current.set(context, stopping);
        const clearStop = () => {
          if (playerStopPromises.current.get(context) === stopping) {
            playerStopPromises.current.delete(context);
          }
        };
        void stopping.then(clearStop, clearStop);
      }
      return stopping;
    },
    [stopAll],
  );

  const stopAllAndReport = useCallback(
    async (expectedContext?: AudioContext) => {
      // This hook is publicly exported, so callers outside VoiceProvider can
      // request deduplicated cleanup without handling resource-level failures.
      try {
        await stopAllTracked(expectedContext);
      } catch (e) {
        const message = getBrowserErrorMessage(e) ?? 'Unknown error';
        onError.current(
          `Failed to stop audio player: ${message}`,
          'audio_player_closure_failure',
        );
      }
    },
    [onError, stopAllTracked],
  );

  const stopAllForContext = useCallback(
    (context: AudioContext) =>
      propagateContextStopFailures
        ? stopAllTracked(context)
        : stopAllAndReport(context),
    [propagateContextStopFailures, stopAllAndReport, stopAllTracked],
  );

  const clearQueue = useCallback(() => {
    const resources = playerResources.current;
    if (props.enableAudioWorklet) {
      // AudioWorklet mode
      try {
        resources?.worklet?.port.postMessage({ type: 'fadeAndClear' });
      } catch (e) {
        const message = getBrowserErrorMessage(e) ?? 'Unknown error';
        onError.current(
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
        cancelPlayerFft(resources);
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
    fftStore.clear();
  }, [
    cancelPlayerFft,
    props.enableAudioWorklet,
    fftStore,
    onError,
    publishIsPlaying,
    publishQueueLength,
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
      diagnostics.current?.emit({
        level: 'info',
        category: 'audio_player',
        name: 'control.changed',
        details: { control: 'volume', value: clampedLevel },
      });
    },
    [diagnostics],
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
    diagnostics.current?.emit({
      level: 'info',
      category: 'audio_player',
      name: 'control.changed',
      details: { control: 'audio_mute', value: true },
    });
  }, [diagnostics]);

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
    diagnostics.current?.emit({
      level: 'info',
      category: 'audio_player',
      name: 'control.changed',
      details: { control: 'audio_mute', value: false },
    });
  }, [diagnostics]);

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
  useSoundPlayerImplementation(props, false);

/**
 * Strict player cleanup used for provider-level failure aggregation.
 *
 * @internal
 */
export const useSoundPlayerForVoiceProvider = (props: UseSoundPlayerProps) =>
  useSoundPlayerImplementation(props, true);
