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

const toError = (error: unknown): Error =>
  normalizeBrowserError(error, 'Unknown audio context error');

export const closeAudioContextWithTimeout = async (
  context: AudioContext,
): Promise<AudioContextCloseResult> => {
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
    return {
      success: false,
      error: toError(error),
      reason: 'rejected',
    };
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
  return result;
};
