/** Return the DOM-style name carried by a browser error, including cross-realm errors. */
export const getBrowserErrorName = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return null;
  }
  return typeof error.name === 'string' ? error.name : null;
};

/** Return a useful message carried by a browser error, including cross-realm errors. */
export const getBrowserErrorMessage = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('message' in error)) {
    return null;
  }
  return typeof error.message === 'string' && error.message.trim().length > 0
    ? error.message
    : null;
};

/** Normalize a browser failure without discarding cross-realm name or message fields. */
export const normalizeBrowserError = (
  error: unknown,
  fallbackMessage: string,
): Error => {
  const message = getBrowserErrorMessage(error);
  if (error instanceof Error && message !== null) return error;

  const normalized = new Error(message ?? fallbackMessage);
  const name = getBrowserErrorName(error);
  if (name !== null) normalized.name = name;
  return normalized;
};

/** Whether microphone access was denied by browser policy or by the user. */
export const isMicrophonePermissionDeniedError = (error: unknown): boolean => {
  const name = getBrowserErrorName(error);
  return name === 'NotAllowedError' || name === 'SecurityError';
};
