import { getDataProperty } from './aggregateErrors';

type NativeDomExceptionStringGetters = Partial<
  Record<'message' | 'name', (this: object) => unknown>
>;

let nativeDomExceptionStringGetters: NativeDomExceptionStringGetters | null =
  null;

const getNativeDomExceptionStringGetters = () => {
  if (nativeDomExceptionStringGetters !== null) {
    return nativeDomExceptionStringGetters;
  }
  const getters: Partial<
    Record<'message' | 'name', (this: object) => unknown>
  > = {};
  try {
    // Leave the cache empty so a later-installed DOMException polyfill can be
    // captured on the next call.
    if (typeof DOMException === 'undefined') return getters;
    for (const key of ['message', 'name'] as const) {
      // oxlint-disable-next-line typescript/unbound-method -- captured for guarded invocation with a candidate DOMException receiver
      const getter = Object.getOwnPropertyDescriptor(
        DOMException.prototype,
        key,
      )?.get;
      if (getter !== undefined) getters[key] = getter;
    }
  } catch {
    // A partial DOMException implementation may not expose a usable prototype.
  }
  nativeDomExceptionStringGetters = getters;
  return getters;
};

// DOMException name and message are immutable Web IDL values. Caching both
// successful and failed brand probes avoids exception-driven duplicate work.
const nativeDomExceptionStrings = new WeakMap<
  object,
  Partial<Record<'message' | 'name', string | null>>
>();

const getNativeDomExceptionString = (
  error: object,
  key: 'message' | 'name',
): string | null => {
  const cached = nativeDomExceptionStrings.get(error);
  if (cached !== undefined && Object.hasOwn(cached, key)) {
    return cached[key] ?? null;
  }

  let result: string | null = null;
  try {
    const getter = getNativeDomExceptionStringGetters()[key];
    if (getter === undefined) return result;
    const value: unknown = getter.call(error);
    result = typeof value === 'string' ? value : null;
  } catch {
    // Invoking a native Web IDL getter with an ordinary object throws.
  }
  const values = cached ?? {};
  values[key] = result;
  nativeDomExceptionStrings.set(error, values);
  return result;
};

/** Recognize same- and cross-realm native DOMException objects safely. */
export const isNativeDomException = (error: unknown): error is DOMException =>
  typeof error === 'object' &&
  error !== null &&
  getNativeDomExceptionString(error, 'name') !== null;

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
