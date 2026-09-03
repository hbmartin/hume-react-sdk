import {
  getDataProperty,
  getPropertyDescriptorSafely,
} from './aggregateErrors';

type DomExceptionStringKey = 'message' | 'name';
type DomExceptionStringGetter = (this: object) => unknown;

/**
 * Read the accessor the current DOMException implementation uses for a key.
 *
 * The descriptor is re-read on every call, so a DOMException global that is
 * installed, completed, replaced, subclassed, or patched in place after import
 * is always observed. Walking the prototype chain finds an accessor that a
 * subclass inherits rather than owns; a data property ends the walk because
 * `Error.prototype` carries plain `name` and `message` values.
 */
const getNativeDomExceptionStringGetter = (
  key: DomExceptionStringKey,
): DomExceptionStringGetter | undefined => {
  try {
    if (typeof DOMException === 'undefined') return undefined;
    const descriptor = getPropertyDescriptorSafely(
      DOMException.prototype as object,
      key,
    );
    // oxlint-disable-next-line typescript/unbound-method -- captured for guarded invocation with a candidate DOMException receiver
    return descriptor?.get;
  } catch {
    // A partial DOMException implementation may not expose a usable prototype.
  }
  return undefined;
};

type NativeDomExceptionStringProbe = Readonly<{
  getter: DomExceptionStringGetter;
  value: string | null;
}>;
type NativeDomExceptionStringProbes = Partial<
  Record<DomExceptionStringKey, NativeDomExceptionStringProbe>
>;

// Cache each getter probe and tie it to the getter that produced it. If a
// partial DOMException implementation is later completed or replaced, the new
// getter retries the same error object.
const nativeDomExceptionStrings = new WeakMap<
  object,
  NativeDomExceptionStringProbes
>();

const getNativeDomExceptionString = (
  error: object,
  key: DomExceptionStringKey,
): string | null => {
  const getter = getNativeDomExceptionStringGetter(key);
  if (getter === undefined) return null;
  const probes = nativeDomExceptionStrings.get(error);
  const probe = probes?.[key];
  if (probe?.getter === getter) return probe.value;

  let value: string | null = null;
  try {
    const result: unknown = getter.call(error);
    value = typeof result === 'string' ? result : null;
  } catch {
    // Native brand checks and partial or patched accessors can both throw.
    // Cache only this probe because a sibling getter may still be usable.
  }
  const nextProbes: NativeDomExceptionStringProbes = probes ?? {};
  nextProbes[key] = { getter, value };
  if (probes === undefined) nativeDomExceptionStrings.set(error, nextProbes);
  return value;
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
