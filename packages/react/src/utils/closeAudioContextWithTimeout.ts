/** Keep teardown from indefinitely blocking errors, replacement, or stop. */
const AUDIO_CONTEXT_CLOSE_TIMEOUT_MS = 1_000;

export const closeAudioContextWithTimeout = async (
  context: AudioContext,
): Promise<void> => {
  let closePromise: Promise<void>;
  try {
    closePromise = Promise.resolve(context.close()).catch(() => undefined);
  } catch {
    // Some browser implementations can throw before returning a promise.
    return;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closePromise,
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, AUDIO_CONTEXT_CLOSE_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }
};
