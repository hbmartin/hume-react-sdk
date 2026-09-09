import { normalizeBrowserError } from './browserErrors';

/** Keep teardown from indefinitely blocking errors, replacement, or stop. */
const AUDIO_CONTEXT_CLOSE_TIMEOUT_MS = 1_000;

export type AudioContextCloseResult =
  | { success: true }
  | {
      success: false;
      error: Error;
      reason: 'rejected' | 'timeout';
    };

// `AudioContext.state` changes to `closed` as soon as close() is accepted,
// before the returned promise confirms that system resources were released.
// Keep the original completion promise so later callers can join it after a
// bounded wait instead of treating `state` as proof or calling close() twice.
const audioContextCloseCompletions = new WeakMap<
  AudioContext,
  Promise<AudioContextCloseResult>
>();

/** Avoid a redundant close without letting host accessors abort cleanup. */
const isAudioContextClosed = (context: AudioContext): boolean => {
  try {
    return context.state === 'closed';
  } catch {
    // An unreadable state is not evidence that cleanup finished. Treat it as
    // open so callers still attempt close and retain ownership if that fails.
    return false;
  }
};

const toError = (error: unknown): Error =>
  normalizeBrowserError(error, 'Unknown audio context error');

const getOrStartAudioContextClose = (
  context: AudioContext,
): Promise<AudioContextCloseResult> => {
  const existingCompletion = audioContextCloseCompletions.get(context);
  if (existingCompletion) return existingCompletion;

  if (isAudioContextClosed(context)) {
    return Promise.resolve({ success: true });
  }

  let closeCompletion: Promise<AudioContextCloseResult>;
  try {
    closeCompletion = Promise.resolve(context.close()).then(
      () => ({ success: true }),
      (error: unknown) => ({
        success: false,
        error: toError(error),
        reason: 'rejected' as const,
      }),
    );
  } catch (error) {
    return Promise.resolve({
      success: false,
      error: toError(error),
      reason: 'rejected',
    });
  }

  audioContextCloseCompletions.set(context, closeCompletion);
  void closeCompletion.then((result) => {
    // A rejected invocation can be retried later. Successful and pending close
    // operations remain joinable for as long as the context itself is alive.
    if (
      !result.success &&
      audioContextCloseCompletions.get(context) === closeCompletion
    ) {
      audioContextCloseCompletions.delete(context);
    }
  });
  return closeCompletion;
};

export const closeAudioContextWithTimeout = async (
  context: AudioContext,
): Promise<AudioContextCloseResult> => {
  const closeCompletion = getOrStartAudioContextClose(context);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    closeCompletion,
    new Promise<AudioContextCloseResult>((resolve) => {
      timeoutId = setTimeout(
        () =>
          resolve({
            success: false,
            error: new Error('Audio context close timed out.'),
            reason: 'timeout',
          }),
        AUDIO_CONTEXT_CLOSE_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }
  return result;
};
