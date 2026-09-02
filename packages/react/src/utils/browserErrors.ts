import { getDataProperty } from './aggregateErrors';

type NativeDomExceptionStringGetters = Partial<
  Record<'message' | 'name', (this: object) => unknown>
>;

let nativeDomExceptionStringGetters: NativeDomExceptionStringGetters | null =
  null;
let nativeDomExceptionPrototype: object | null = null;

const getNativeDomExceptionStringGetters = () => {
  const getters: NativeDomExceptionStringGetters = {};
  let prototype: object;
  try {
    // Re-read the current prototype so an installed, completed, or replaced
    // DOMException implementation can supply a new set of getters.
    if (typeof DOMException === 'undefined') return getters;
    prototype = DOMException.prototype;
    if (
      nativeDomExceptionStringGetters !== null &&
      nativeDomExceptionPrototype === prototype
    ) {
      return nativeDomExceptionStringGetters;
    }
    for (const key of ['message', 'name'] as const) {
      // oxlint-disable-next-line typescript/unbound-method -- captured for guarded invocation with a candidate DOMException receiver
      const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
      if (getter !== undefined) getters[key] = getter;
    }
  } catch {
    // A partial DOMException implementation may not expose a usable prototype.
    return getters;
  }
  if (getters.message === undefined || getters.name === undefined)
    return getters;
  nativeDomExceptionStringGetters = getters;
  nativeDomExceptionPrototype = prototype;
  return getters;
};

type NativeDomExceptionStringProbe = Readonly<{
  getter: (this: object) => unknown;
  value: string | null;
}>;

// Cache each getter probe independently and tie failures to the getter that
// produced them. If a partial DOMException implementation is later completed,
// the replacement getter can retry the same error object.
const nativeDomExceptionStrings = new WeakMap<
  object,
  Partial<Record<'message' | 'name', NativeDomExceptionStringProbe>>
>();

const getNativeDomExceptionString = (
  error: object,
  key: 'message' | 'name',
): string | null => {
  const getter = getNativeDomExceptionStringGetters()[key];
  if (getter === undefined) return null;
  const cached = nativeDomExceptionStrings.get(error);
  const cachedProbe = cached?.[key];
  if (cachedProbe?.getter === getter) return cachedProbe.value;

  let result: string | null = null;
  try {
    const value: unknown = getter.call(error);
    result = typeof value === 'string' ? value : null;
  } catch {
    // Invoking a native Web IDL getter with an ordinary object throws.
  }
  const values: Partial<
    Record<'message' | 'name', NativeDomExceptionStringProbe>
  > = cached ?? {};
  values[key] = { getter, value: result };
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
