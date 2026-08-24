/** Keep teardown from indefinitely blocking errors, replacement, or stop. */
const AUDIO_CONTEXT_CLOSE_TIMEOUT_MS = 1_000;

export const closeAudioContextWithTimeout = async (
  context: AudioContext,
): Promise<void> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const closePromise = Promise.resolve()
    .then(() => context.close())
    .catch(() => undefined);

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
