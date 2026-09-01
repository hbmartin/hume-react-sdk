import { getDataProperty } from './aggregateErrors';

const getNativeDomExceptionString = (
  error: object,
  key: 'message' | 'name',
): string | null => {
  try {
    if (
      typeof DOMException === 'undefined' ||
      !(error instanceof DOMException)
    ) {
      return null;
    }
    // oxlint-disable-next-line typescript/unbound-method -- invoked with the validated DOMException receiver below
    const getter = Object.getOwnPropertyDescriptor(
      DOMException.prototype,
      key,
    )?.get;
    if (getter === undefined) return null;
    const value: unknown = getter.call(error);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

/** Read a browser error string without invoking user-defined accessors. */
export const getBrowserErrorString = (
  error: unknown,
  key: 'message' | 'name',
): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const dataValue = getDataProperty(error, key)?.value;
  if (typeof dataValue === 'string') return dataValue;
  return getNativeDomExceptionString(error, key);
};

/** Return the DOM-style name carried by a browser error, including cross-realm errors. */
export const getBrowserErrorName = (error: unknown): string | null =>
  getBrowserErrorString(error, 'name');

/** Return a useful message carried by a browser error, including cross-realm errors. */
export const getBrowserErrorMessage = (error: unknown): string | null => {
  const message = getBrowserErrorString(error, 'message');
  return message !== null && message.trim().length > 0 ? message : null;
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
