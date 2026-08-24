import { convertBase64ToBlob } from 'hume';
import { useCallback, useMemo, useRef, useState } from 'react';

import { convertLinearFrequenciesToBarkInto } from './convertFrequencyScale';
import { FftStore } from './fftStore';
import { useLatestRef } from './useLatestRef';
import type { AudioPlayerErrorReason } from './VoiceProvider';
import type { AudioOutputMessage } from '../models/messages';
import { closeAudioContextWithTimeout } from '../utils/closeAudioContextWithTimeout';
import { loadAudioWorklet } from '../utils/loadAudioWorklet';

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

/** How often `waitForQueueToDrain` re-checks whether playback has finished. */
const DRAIN_POLL_INTERVAL_MS = 50;
/** Require an idle period so the final render quantum reaches the output. */
const DRAIN_SETTLE_MS = DRAIN_POLL_INTERVAL_MS;
/** Upper bound on how long a server-initiated disconnect waits for audio. */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
/**
 * When autoplay policy blocks a suspended AudioContext, `resume()` never
 * settles, so the attempt must be bounded rather than awaited directly.
 */
const RESUME_TIMEOUT_MS = 1_000;
export const useSoundPlayer = (props: {
  enableAudioWorklet: boolean;
  onError: (message: string, reason: AudioPlayerErrorReason) => void;
  onPlayAudio: (id: string) => void;
  onStopAudio: (id: string) => void;
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [volume, setVolumeState] = useState<number>(1.0);

  const fftStore = useRef(new FftStore()).current;

  const audioContext = useRef<AudioContext | null>(null);
  const analyserNode = useRef<AnalyserNode | null>(null);
  const gainNode = useRef<GainNode | null>(null);
  const workletNode = useRef<AudioWorkletNode | null>(null);
  const playerResources = useRef<PlayerResources | null>(null);
  const isInitialized = useRef(false);

  const isProcessing = useRef(false);
  const fftRafId = useRef<number | null>(null);

  const onPlayAudio = useLatestRef(props.onPlayAudio);
  const onStopAudio = useLatestRef(props.onStopAudio);
  const onError = useLatestRef(props.onError);

  // chunkBufferQueues and lastQueuedChunk are used to make sure that
  // we don't play chunks out of order. chunkBufferQueues is NOT the
  // audio playback queue.
  const chunkBufferQueues = useRef<
    Record<string, Array<AudioBuffer | undefined>>
  >({});
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
  const currentlyPlayingAudioBuffer = useRef<AudioBufferSourceNode | null>(
    null,
  );

  // Mirrors of the playback state, readable from inside async loops that would
  // otherwise close over a stale render's values.
  const queueLengthRef = useLatestRef(queueLength);
  const isPlayingRef = useLatestRef(isPlaying);
  const playerGeneration = useRef(0);
  const pendingAudioTasks = useRef(new Map<number, number>());
  const playbackActivitySequence = useRef(0);

  const cancelPlayerFft = useCallback((resources: PlayerResources) => {
    const rafId = resources.fftRafId;
    resources.fftRafId = null;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      if (fftRafId.current === rafId) {
        fftRafId.current = null;
      }
    }
  }, []);

  const disposePlayerResources = useCallback(
    async (resources: PlayerResources) => {
      if (playerResources.current === resources) {
        playerResources.current = null;
      }

      cancelPlayerFft(resources);

      const source = resources.source;
      resources.source = null;
      if (source) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // The source may already have ended; disconnecting it is sufficient.
        }
        source.disconnect();
        if (currentlyPlayingAudioBuffer.current === source) {
          currentlyPlayingAudioBuffer.current = null;
          isProcessing.current = false;
        }
      }

      const worklet = resources.worklet;
      resources.worklet = null;
      if (worklet) {
        worklet.port.onmessage = null;
        try {
          worklet.port.close();
        } catch {
          // Continue releasing the rest of this player's resources.
        }
        try {
          worklet.disconnect();
        } catch {
          // The worklet may already have been disconnected.
        }
        if (workletNode.current === worklet) {
          workletNode.current = null;
        }
      }

      const analyser = resources.analyser;
      resources.analyser = null;
      if (analyser) {
        try {
          analyser.disconnect();
        } catch {
          // The analyser may already have been disconnected.
        }
        if (analyserNode.current === analyser) {
          analyserNode.current = null;
        }
      }

      const gain = resources.gain;
      resources.gain = null;
      if (gain) {
        try {
          gain.disconnect();
        } catch {
          // The gain node may already have been disconnected.
        }
        if (gainNode.current === gain) {
          gainNode.current = null;
        }
      }

      const context = resources.context;
      const shouldCloseContext = resources.ownsContext;
      resources.context = null;
      resources.ownsContext = false;
      if (audioContext.current === context) {
        audioContext.current = null;
      }
      if (context && shouldCloseContext) {
        await closeAudioContextWithTimeout(context);
      }
    },
    [cancelPlayerFft],
  );

  /**
   * Only for non-AudioWorklet mode.
   * This function is called when the current audio clip ends.
   * It will play the next clip in the queue if there is one.
   */
  const playNextClip = useCallback(() => {
    // While a clip is mid-playback the queue may still hold entries, so
    // report its real length instead of zeroing it.
    if (clipQueue.current.length === 0 || isProcessing.current) {
      setQueueLength(clipQueue.current.length);
      return;
    }

    if (analyserNode.current === null || audioContext.current === null) {
      onError.current(
        'Audio player is not initialized',
        'audio_player_initialization_failure',
      );
      return;
    }
    const resources = playerResources.current;
    if (!resources) {
      return;
    }

    const nextClip = clipQueue.current.shift();
    setQueueLength(clipQueue.current.length);

    if (!nextClip) return;

    isProcessing.current = true;
    setIsPlaying(true);

    const generation = playerGeneration.current;
    const bufferSource = audioContext.current.createBufferSource();

    bufferSource.buffer = nextClip.buffer;

    bufferSource.connect(analyserNode.current);

    currentlyPlayingAudioBuffer.current = bufferSource;
    resources.source = bufferSource;

    const frequencyDataBuffer = new Uint8Array(
      analyserNode.current.frequencyBinCount,
    );
    const barkBuffer = new Array<number>(BARK_BAND_COUNT).fill(0);

    const updateFrequencyData = () => {
      try {
        const bufferSampleRate = bufferSource.buffer?.sampleRate;

        if (!analyserNode.current || typeof bufferSampleRate === 'undefined')
          return;

        analyserNode.current.getByteFrequencyData(frequencyDataBuffer);
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
      fftRafId.current = resources.fftRafId;
    };
    resources.fftRafId = requestAnimationFrame(pollFft);
    fftRafId.current = resources.fftRafId;

    bufferSource.start(0);
    if (nextClip.index === 0) {
      onPlayAudio.current(nextClip.id);
    }

    bufferSource.onended = () => {
      if (
        generation !== playerGeneration.current ||
        currentlyPlayingAudioBuffer.current !== bufferSource
      ) {
        bufferSource.disconnect();
        return;
      }
      cancelPlayerFft(resources);
      fftStore.clear();
      bufferSource.disconnect();
      isProcessing.current = false;
      setIsPlaying(false);
      onStopAudio.current(nextClip.id);
      currentlyPlayingAudioBuffer.current = null;
      resources.source = null;
      playNextClip();
    };
  }, [cancelPlayerFft, fftStore]);

  const initPlayer = useCallback(
    async (
      speakerDeviceId?: string,
      sharedAudioContext?: AudioContext,
    ): Promise<boolean> => {
      const generation = ++playerGeneration.current;
      playbackActivitySequence.current = 0;
      isInitialized.current = false;
      isProcessing.current = false;
      setIsPlaying(false);
      setQueueLength(0);
      chunkBufferQueues.current = {};
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
        audioContext.current = initAudioContext;

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
          if (!resumed || initAudioContext.state === 'suspended') {
            return await failInitialization(
              'The browser blocked audio playback (autoplay policy). Connect from a user gesture, such as a click handler.',
              'audio_player_initialization_failure',
            );
          }
        }

        // Set the speaker device if specified and supported
        if (speakerDeviceId && 'setSinkId' in initAudioContext) {
          try {
            // TypeScript doesn't recognize setSinkId on AudioContext yet, so we need to cast
            await (
              initAudioContext as AudioContext & {
                setSinkId: (deviceId: string) => Promise<void>;
              }
            ).setSinkId(speakerDeviceId);
          } catch (e) {
            if (generation !== playerGeneration.current) {
              return await abandonInitialization();
            }
            onError.current(
              `Failed to set speaker device: ${e instanceof Error ? e.message : 'Unknown error'}`,
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

        analyser.fftSize = 2048; // Must be a power of 2
        analyser.connect(gain);
        gain.connect(initAudioContext.destination);

        analyserNode.current = analyser;
        gainNode.current = gain;

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
          workletNode.current = worklet;

          worklet.port.onmessage = (e: MessageEvent) => {
            if (
              generation !== playerGeneration.current ||
              playerResources.current !== resources
            ) {
              return;
            }
            const data = e.data as WorkletMessage;

            switch (data.type) {
              case 'start_clip':
                if (data.index === 0) {
                  onPlayAudio.current(data.id);
                }
                setIsPlaying(true);
                break;

              case 'ended':
                setIsPlaying(false);
                onStopAudio.current('stream');
                break;

              case 'queueLength':
                if (data.length === 0) {
                  setIsPlaying(false);
                }
                setQueueLength(data.length);
                break;

              case 'worklet_closed':
                break;
            }
          };

          // Pre-allocate buffers for FFT analysis (zero allocations per frame)
          const frequencyDataBuffer = new Uint8Array(
            analyser.frequencyBinCount,
          );
          const barkBuffer = new Array<number>(BARK_BAND_COUNT).fill(0);

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
            fftRafId.current = resources.fftRafId;
          };
          resources.fftRafId = requestAnimationFrame(pollFft);
          fftRafId.current = resources.fftRafId;

          isInitialized.current = true;
        } else {
          isInitialized.current = true;
        }
        return true;
      } catch (e) {
        return failInitialization(
          'Failed to initialize audio player',
          'audio_player_initialization_failure',
        );
      }
    },
    [disposePlayerResources, props.enableAudioWorklet, fftStore],
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
      if (!chunkBufferQueues.current[message.id]) {
        chunkBufferQueues.current[message.id] = [];
      }
      const queueForCurrMessage = chunkBufferQueues.current[message.id] || [];
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
      let nextIdx = (lastQueuedChunk.current?.index || 0) + 1;
      let nextBuf = queueForCurrMessage[nextIdx];
      while (nextBuf) {
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
    async (message: AudioOutputMessage) => {
      const generation = playerGeneration.current;
      const context = audioContext.current;
      if (!isInitialized.current || !context) {
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
      try {
        const audioBuffer = await convertToAudioBuffer(message, context);
        if (
          generation !== playerGeneration.current ||
          !isInitialized.current ||
          audioContext.current !== context
        ) {
          return;
        }
        if (!audioBuffer) {
          onError.current(
            'Failed to convert data to audio buffer',
            'malformed_audio',
          );
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
            workletNode.current?.port.postMessage({
              type: 'audio',
              data: pcmData,
              id: nextAudioBufferToPlay.id,
              index: nextAudioBufferToPlay.index,
            });
          } else if (!props.enableAudioWorklet) {
            // Non-AudioWorklet mode
            clipQueue.current.push({
              id: nextAudioBufferToPlay.id,
              buffer: nextAudioBufferToPlay.buffer,
              index: nextAudioBufferToPlay.index,
            });
            setQueueLength(clipQueue.current.length);
            // playNextClip will iterate the queue when playback ends, so it
            // only needs to be started when this is the first queued clip.
            if (clipQueue.current.length === 1) {
              playNextClip();
            }
          }
        }
      } catch (e) {
        const eMessage = e instanceof Error ? e.message : 'Unknown error';
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
      }
    },
    [
      convertToAudioBuffer,
      getNextAudioBuffers,
      playNextClip,
      props.enableAudioWorklet,
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
    async (timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<boolean> => {
      const generation = playerGeneration.current;
      const isDrained = () =>
        (pendingAudioTasks.current.get(generation) ?? 0) === 0 &&
        queueLengthRef.current === 0 &&
        isPlayingRef.current === false;

      // Preserve the zero-work fast path. Once audio work has started, require
      // a stable idle period so an in-flight decode or the worklet's final
      // render quantum cannot race teardown.
      if (isDrained() && playbackActivitySequence.current === 0) {
        return true;
      }

      const deadline = Date.now() + timeoutMs;
      let stableSince: number | null = null;
      let observedActivitySequence = playbackActivitySequence.current;

      while (Date.now() < deadline) {
        if (generation !== playerGeneration.current) {
          return false;
        }
        const now = Date.now();
        const currentActivitySequence = playbackActivitySequence.current;
        if (currentActivitySequence !== observedActivitySequence) {
          observedActivitySequence = currentActivitySequence;
          stableSince = null;
        }

        if (isDrained()) {
          stableSince ??= now;
          if (now - stableSince >= DRAIN_SETTLE_MS) {
            return true;
          }
        } else {
          stableSince = null;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(DRAIN_POLL_INTERVAL_MS, remainingMs)),
        );
      }

      // The queue never emptied. The caller stops the player anyway rather
      // than leaving the socket teardown hanging on stuck audio.
      return false;
    },
    [queueLengthRef, isPlayingRef],
  );

  const stopAll = useCallback(async () => {
    const generation = ++playerGeneration.current;
    const resourcesToStop = playerResources.current;
    playerResources.current = null;
    const workletToStop = resourcesToStop?.worklet ?? null;
    isInitialized.current = false;
    isProcessing.current = false;
    setIsPlaying(false);
    setIsAudioMuted(false);
    setVolumeState(1.0);
    fftStore.clear();

    chunkBufferQueues.current = {};
    lastQueuedChunk.current = null;

    if (resourcesToStop) {
      cancelPlayerFft(resourcesToStop);
    }

    try {
      if (workletToStop) {
        // AudioWorklet mode
        let isWorkletClosed = false;
        workletToStop.port.onmessage = (e: MessageEvent) => {
          if ((e.data as WorkletMessage).type === 'worklet_closed') {
            isWorkletClosed = true;
          }
        };
        workletToStop.port.postMessage({ type: 'fadeAndClear' });
        workletToStop.port.postMessage({ type: 'end' });

        // We use this loop to make sure the worklet has been closed before we consider
        // the player to be successfully stopped. The audio worklet asynchronously emits
        // the 'worklet_closed' message in order to confirm that it has been closed successfully.
        // If you close the worklet before the fade-out, the user may hear a small audio
        // artifact when the call ends.
        // (Reference the `_fadeOutDurationMs` constant in `audio-worklet.js`
        // to see how long it takes for the worklet to close - the current default is 300ms.)
        let closed = 0;
        while (closed < 5) {
          if (generation !== playerGeneration.current || isWorkletClosed) {
            break;
          }
          closed += 1;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } else {
        // Non-AudioWorklet mode
        clipQueue.current = [];
        setQueueLength(0);
      }
    } finally {
      if (resourcesToStop) {
        await disposePlayerResources(resourcesToStop);
      }
    }
  }, [cancelPlayerFft, disposePlayerResources, fftStore]);

  const stopAllWithRetries = useCallback(
    async (maxAttempts = 3, delayMs = 500) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await stopAll();
          return;
        } catch (e) {
          if (attempt < maxAttempts) {
            await new Promise((res) => setTimeout(res, delayMs));
          } else {
            const message = e instanceof Error ? e.message : 'Unknown error';
            onError.current?.(
              `Failed to stop audio player after ${maxAttempts} attempts: ${message}`,
              'audio_player_closure_failure',
            );
          }
        }
      }
    },
    [stopAll],
  );

  const clearQueue = useCallback(() => {
    if (props.enableAudioWorklet) {
      // AudioWorklet mode
      workletNode.current?.port.postMessage({
        type: 'fadeAndClear',
      });
    } else if (!props.enableAudioWorklet) {
      // Non-AudioWorklet mode
      if (currentlyPlayingAudioBuffer.current) {
        currentlyPlayingAudioBuffer.current.stop();
        currentlyPlayingAudioBuffer.current = null;
      }
      clipQueue.current = [];
      setQueueLength(0);
    }

    isProcessing.current = false;
    setIsPlaying(false);
    fftStore.clear();
  }, [props.enableAudioWorklet, fftStore]);

  const setVolume = useCallback(
    (newLevel: number) => {
      const clampedLevel = Math.max(0, Math.min(newLevel, 1.0));
      setVolumeState(clampedLevel);
      if (gainNode.current && audioContext.current && !isAudioMuted) {
        gainNode.current.gain.setValueAtTime(
          clampedLevel,
          audioContext.current.currentTime,
        );
      }
    },
    [isAudioMuted],
  );

  const muteAudio = useCallback(() => {
    if (gainNode.current && audioContext.current) {
      gainNode.current.gain.setValueAtTime(0, audioContext.current.currentTime);
      setIsAudioMuted(true);
    }
  }, []);

  const unmuteAudio = useCallback(() => {
    if (gainNode.current && audioContext.current) {
      gainNode.current.gain.setValueAtTime(
        volume,
        audioContext.current.currentTime,
      );
      setIsAudioMuted(false);
    }
  }, [volume]);

  return useMemo(
    () => ({
      addToQueue,
      fftStore,
      initPlayer,
      isPlaying,
      isAudioMuted,
      muteAudio,
      unmuteAudio,
      stopAll: stopAllWithRetries,
      waitForQueueToDrain,
      clearQueue,
      volume,
      setVolume,
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
      stopAllWithRetries,
      waitForQueueToDrain,
      clearQueue,
      volume,
      setVolume,
      queueLength,
    ],
  );
};
