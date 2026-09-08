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

/** Read the terminal AudioContext state without letting host accessors abort cleanup. */
const isAudioContextClosed = (context: AudioContext): boolean => {
  try {
    return context.state === 'closed';
  } catch {
    // An unreadable state is not evidence that cleanup finished. Treat it as
    // open so callers still attempt close and retain ownership if that fails.
    return false;
  }
};

/** Treat the context's observable terminal state as authoritative. */
export const reconcileAudioContextCloseResult = (
  context: AudioContext,
  result: AudioContextCloseResult,
): AudioContextCloseResult =>
  result.success || !isAudioContextClosed(context) ? result : { success: true };

const toError = (error: unknown): Error =>
  normalizeBrowserError(error, 'Unknown audio context error');

export const closeAudioContextWithTimeout = async (
  context: AudioContext,
): Promise<AudioContextCloseResult> => {
  if (isAudioContextClosed(context)) {
    return { success: true };
  }

  let closePromise: Promise<AudioContextCloseResult>;
  try {
    closePromise = Promise.resolve(context.close()).then(
      () => ({ success: true }),
      (error: unknown) => ({
        success: false,
        error: toError(error),
        reason: 'rejected' as const,
      }),
    );
  } catch (error) {
    return reconcileAudioContextCloseResult(context, {
      success: false,
      error: toError(error),
      reason: 'rejected',
    });
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    closePromise,
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
  return reconcileAudioContextCloseResult(context, result);
};
