/** Keep teardown from indefinitely blocking errors, replacement, or stop. */
const AUDIO_CONTEXT_CLOSE_TIMEOUT_MS = 1_000;

export type AudioContextCloseResult =
  | { success: true }
  | { success: false; error: Error };

const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message);
  }
  return new Error('Unknown audio context error');
};

export const closeAudioContextWithTimeout = async (
  context: AudioContext,
): Promise<AudioContextCloseResult> => {
  let closePromise: Promise<AudioContextCloseResult>;
  try {
    closePromise = Promise.resolve(context.close()).then(
      () => ({ success: true }),
      (error: unknown) => ({ success: false, error: toError(error) }),
    );
  } catch (error) {
    return { success: false, error: toError(error) };
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
