import packageJson from '../../package.json';
import {
  getAggregateErrorDetails,
  getDataProperty,
  getOwnEnumerableDataProperty,
  getOwnDataProperty,
  getOwnPropertyDescriptorSafely,
} from '../utils/aggregateErrors';
import {
  getBrowserErrorString,
  isNativeDomException,
} from '../utils/browserErrors';

/** Severity threshold for diagnostic events. */
export type VoiceDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

/** Subsystem a diagnostic event came from. */
export type VoiceDiagnosticCategory =
  | 'connection'
  | 'socket'
  | 'microphone'
  | 'audio_player'
  | 'audio_device'
  | 'message'
  | 'tool'
  | 'consumer';

/**
 * Name of a diagnostic event.
 *
 * Schema version 1 keeps existing event meanings and fields stable, but future
 * minor releases may add names. Ignore names you do not recognize.
 */
export type VoiceDiagnosticEventName =
  | 'connection.attempt_started'
  | 'connection.attempt_ignored'
  | 'connection.attempt_cancelled'
  | 'connection.connected'
  | 'connection.disconnect_started'
  | 'connection.disconnected'
  | 'socket.opened'
  | 'socket.closed'
  | 'resource.initialization_started'
  | 'resource.initialized'
  | 'resource.stop_started'
  | 'resource.stopped'
  | 'resource.cleanup_failed'
  | 'microphone.permission_requested'
  | 'microphone.permission_resolved'
  | 'microphone.mime_type_selected'
  | 'microphone.recording_started'
  | 'microphone.recording_stopped'
  | 'microphone.audio_chunk_captured'
  | 'microphone.flush_completed'
  | 'microphone.analyzer_failed'
  | 'audio.chunk_received'
  | 'audio.queue_changed'
  | 'audio.playback_started'
  | 'audio.playback_ended'
  | 'audio.drain_completed'
  | 'audio_device.switch_started'
  | 'audio_device.switch_completed'
  | 'audio_device.switch_failed'
  | 'audio_device.switch_ignored'
  | 'message.sent'
  | 'message.received'
  | 'message.skipped'
  | 'tool.handler_started'
  | 'tool.handler_completed'
  | 'tool.handler_failed'
  | 'tool.handler_skipped'
  | 'control.changed'
  | 'consumer.callback_failed'
  | 'sdk.error'
  | 'sdk.error_cleared';

/** A JSON-serializable value carried in a diagnostic event's details. */
export type VoiceDiagnosticValue =
  | string
  | number
  | boolean
  | null
  | readonly VoiceDiagnosticValue[]
  | { readonly [key: string]: VoiceDiagnosticValue };

/** Structured, sanitized context attached to a diagnostic event. */
export type VoiceDiagnosticDetails = Readonly<
  Record<string, VoiceDiagnosticValue>
>;

/**
 * A single structured diagnostic event.
 *
 * Events are local only: the SDK never sends them to Hume or any other
 * service. Each carries a monotonically increasing `sequence` plus connection
 * and chat correlation when available.
 */
export type VoiceDiagnosticEvent = Readonly<{
  schemaVersion: 1;
  sdkVersion: string;
  timestamp: string;
  sequence: number;
  instanceId: string;
  connectionId?: string;
  chatId?: string;
  level: VoiceDiagnosticLevel;
  category: VoiceDiagnosticCategory;
  name: VoiceDiagnosticEventName;
  durationMs?: number;
  /** Whether detail values are incomplete due to safety limits or sanitization failure. */
  detailsTruncated?: true;
  details: VoiceDiagnosticDetails;
}>;

/** Sink that receives diagnostic events as leveled log calls. */
export interface VoiceLogger {
  /** Receives verbose lifecycle events, including high-volume ones. */
  debug(message: string, event: VoiceDiagnosticEvent): void;
  /** Receives notable lifecycle transitions. */
  info(message: string, event: VoiceDiagnosticEvent): void;
  /** Receives recoverable problems. */
  warn(message: string, event: VoiceDiagnosticEvent): void;
  /** Receives failures that put the provider into its error state. */
  error(message: string, event: VoiceDiagnosticEvent): void;
}

/** Configures how the provider reports diagnostic events. */
export interface VoiceDiagnosticsOptions {
  /**
   * Minimum severity to report, filtering both `logger` and `onEvent`.
   * Defaults to `'warn'`.
   */
  level?: VoiceDiagnosticLevel;
  /**
   * Where to write events. Defaults to the browser console; pass `false` to
   * write nowhere while still delivering events to `onEvent`.
   */
  logger?: VoiceLogger | false;
  /**
   * Receives every event that passes `level`, for forwarding to an
   * observability vendor. Failures here are isolated from the call.
   */
  onEvent?: (event: VoiceDiagnosticEvent) => void;
  /**
   * Include transcript and tool content in event details.
   *
   * Off by default. Enable only where your data-handling policy permits
   * forwarding user and assistant text, tool arguments, results, and errors.
   * Even when enabled, events never carry authentication values, raw audio,
   * PCM or base64 payloads, session-setting values such as prompts, or audio
   * device IDs and labels. Defaults to `false`.
   */
  includeContent?: boolean;
}

type DiagnosticConfiguration = false | VoiceDiagnosticsOptions | undefined;

/**
 * Low-level diagnostic event input accepted by a diagnostics reporter.
 *
 * @deprecated Configure diagnostics with {@link VoiceDiagnosticsOptions} on
 * {@link VoiceProvider}. This type remains for `useSoundPlayer` compatibility.
 */
export type VoiceDiagnosticInput = {
  level: VoiceDiagnosticLevel;
  category: VoiceDiagnosticCategory;
  name: VoiceDiagnosticEventName;
  /**
   * Override the active connection correlation for a delayed event. Pass
   * `null` when the event is intentionally uncorrelated.
   */
  connectionId?: string | null;
  /**
   * Override the active chat correlation for a delayed event. Pass `null`
   * when the event must not inherit the currently active chat.
   */
  chatId?: string | null;
  durationMs?: number;
  details?: Record<string, unknown>;
  sensitiveDetails?: Record<string, unknown>;
};

/**
 * Low-level diagnostics sink used by internal provider resources and retained
 * for the deprecated `useSoundPlayer` compatibility wrapper.
 *
 * @deprecated Configure diagnostics with {@link VoiceDiagnosticsOptions} on
 * {@link VoiceProvider} instead.
 */
export interface VoiceDiagnosticsReporter {
  /** Adds a sensitive value that must be redacted from future events. */
  addRedactionValue(value?: string): void;
  /** Starts correlation for a connection attempt and returns its identifier. */
  beginConnection(secret?: string): string;
  /** Clears active connection and chat correlation. */
  clearConnection(): void;
  /** Emits a structured diagnostic event. */
  emit(input: VoiceDiagnosticInput): void;
  /** Returns the active connection and chat correlation identifiers. */
  getCorrelation(): Readonly<{
    connectionId?: string;
    chatId?: string;
  }>;
  /** Whether an event at the given level would be reported. */
  isEnabled(level: VoiceDiagnosticLevel): boolean;
  /** Updates the chat identifier attached to later events. */
  setChatId(chatId?: string): void;
}

/** Invoke application code without allowing sync or async failures into SDK control flow. */
export const invokeIsolatedConsumerCallback = (
  diagnostics: VoiceDiagnosticsReporter | undefined,
  callback: string,
  invoke: () => unknown,
): void => {
  let shouldReportFailure = diagnostics !== undefined;
  if (diagnostics !== undefined) {
    try {
      shouldReportFailure = diagnostics.isEnabled('warn');
    } catch {
      // Preserve reporting for custom reporters whose enabled check is broken.
    }
  }
  let correlation: ReturnType<VoiceDiagnosticsReporter['getCorrelation']> = {};
  if (shouldReportFailure) {
    try {
      correlation = diagnostics?.getCorrelation() ?? {};
    } catch {
      // A custom reporter may not support correlation snapshots reliably.
    }
  }
  const reportFailure = (error: unknown) => {
    if (!shouldReportFailure) return;
    try {
      diagnostics?.emit({
        level: 'warn',
        category: 'consumer',
        name: 'consumer.callback_failed',
        connectionId: correlation.connectionId ?? null,
        chatId: correlation.chatId ?? null,
        details: { callback, error },
      });
    } catch {
      // A custom diagnostics reporter must not break consumer callback isolation.
    }
  };

  try {
    const result: unknown = invoke();
    if (result !== undefined) {
      void Promise.resolve(result).catch(reportFailure);
    }
  } catch (error) {
    reportFailure(error);
  }
};

const LEVEL_PRIORITY: Record<VoiceDiagnosticLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = '[REDACTED]';
const TRUNCATED_SUFFIX = '[Truncated]';
const TRUNCATED_PROPERTY = '__humeDiagnosticTruncated';
const TRUNCATED_VALUE = Object.freeze({
  [TRUNCATED_PROPERTY]: true,
});
const MAX_SANITIZED_ENTRIES = 1_000;
const MAX_SANITIZED_OBJECTS = 1_000;
const MAX_SANITIZED_STRING_LENGTH = 16_384;
const MAX_SANITIZED_TOTAL_STRING_LENGTH = 262_144;
const MAX_ENUMERATED_OBJECT_KEYS = MAX_SANITIZED_ENTRIES;
const MAX_PRIORITY_SEARCH_DEPTH = 8;
const MAX_PRIORITY_SEARCH_NODES = 128;
const PRIORITY_DIAGNOSTIC_KEYS = [
  'error',
  'errors',
  'failures',
  'cause',
] as const;
const PRIORITY_DIAGNOSTIC_KEY_SET = new Set<string>(PRIORITY_DIAGNOSTIC_KEYS);
const REDACTED_KEYS = new Set([
  'apikey',
  'accesstoken',
  'token',
  'authorization',
  'auth',
  'sessionsettings',
  'systemprompt',
  'context',
  'metadata',
  'deviceid',
  'microphonedeviceid',
  'speakerdeviceid',
  'label',
  'audio',
  'pcm',
  'arraybuffer',
  'buffer',
  'data',
]);

let fallbackId = 0;

const createId = (prefix: string) => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- older supported browsers can omit crypto
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  fallbackId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
};

const normalizeKey = (key: string) => key.replaceAll(/[_-]/g, '').toLowerCase();

const redactSecrets = (value: string, secrets: ReadonlySet<string>) => {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      sanitized = sanitized.split(secret).join(REDACTED);
    }
  }
  return sanitized;
};

type BoundedRedaction = Readonly<{
  sourceTruncated: boolean;
  value: string;
}>;

/**
 * Redact only the source prefix that can contribute to the bounded output.
 * Matching against the original value lets a secret that begins before the
 * input cutoff consume the complete secret instead of exposing its prefix.
 */
const redactSecretsWithinLimits = (
  value: string,
  secrets: ReadonlySet<string>,
  maximumInputLength: number,
  maximumOutputLength: number,
): BoundedRedaction => {
  if (maximumInputLength === 0 || maximumOutputLength === 0) {
    return { sourceTruncated: value.length > 0, value: '' };
  }
  if (secrets.size === 0) {
    return {
      sourceTruncated: value.length > maximumInputLength,
      value: value.slice(0, maximumInputLength),
    };
  }

  let cursor = 0;
  let sanitized = '';
  while (
    cursor < value.length &&
    cursor < maximumInputLength &&
    sanitized.length < maximumOutputLength
  ) {
    let matchedSecret = '';
    for (const secret of secrets) {
      if (
        secret.length > matchedSecret.length &&
        value.startsWith(secret, cursor)
      ) {
        matchedSecret = secret;
      }
    }
    if (matchedSecret !== '') {
      sanitized += REDACTED;
      cursor += matchedSecret.length;
    } else {
      sanitized += value[cursor] ?? '';
      cursor += 1;
    }
  }

  return { sourceTruncated: cursor < value.length, value: sanitized };
};

type SanitizationBudget = {
  prioritizedKeys: WeakMap<object, Set<string>>;
  remainingEntries: number;
  remainingObjects: number;
  remainingStringLength: number;
  truncated: boolean;
};

const markTruncated = (budget: SanitizationBudget): VoiceDiagnosticValue => {
  budget.truncated = true;
  return TRUNCATED_VALUE;
};

const truncateDiagnosticString = (
  value: string,
  budget: SanitizationBudget,
  sourceTruncated = false,
) => {
  const maximumLength = Math.min(
    MAX_SANITIZED_STRING_LENGTH,
    budget.remainingStringLength,
  );
  if (!sourceTruncated && value.length <= maximumLength) {
    budget.remainingStringLength -= value.length;
    return value;
  }
  budget.truncated = true;
  if (maximumLength === 0) return '';
  const suffix = TRUNCATED_SUFFIX.slice(0, maximumLength);
  const truncated = `${value.slice(0, maximumLength - suffix.length)}${suffix}`;
  budget.remainingStringLength -= truncated.length;
  return truncated;
};

const sanitizeString = (
  value: string,
  secrets: ReadonlySet<string>,
  budget: SanitizationBudget,
) => {
  const maximumLength = Math.min(
    MAX_SANITIZED_STRING_LENGTH,
    budget.remainingStringLength,
  );
  const redacted = redactSecretsWithinLimits(
    value,
    secrets,
    maximumLength,
    maximumLength,
  );
  return truncateDiagnosticString(
    redacted.value,
    budget,
    redacted.sourceTruncated,
  );
};

const sanitizeObjectKey = (
  value: string,
  secrets: ReadonlySet<string>,
  budget: SanitizationBudget,
): string | null => {
  const maximumLength = Math.min(
    MAX_SANITIZED_STRING_LENGTH,
    budget.remainingStringLength,
  );
  const redacted = redactSecretsWithinLimits(
    value,
    secrets,
    maximumLength,
    maximumLength,
  );
  if (!redacted.sourceTruncated && redacted.value.length <= maximumLength) {
    budget.remainingStringLength -= redacted.value.length;
    return redacted.value;
  }
  budget.truncated = true;
  if (maximumLength < TRUNCATED_SUFFIX.length) return null;
  const sanitized = `${redacted.value.slice(
    0,
    maximumLength - TRUNCATED_SUFFIX.length,
  )}${TRUNCATED_SUFFIX}`;
  budget.remainingStringLength -= sanitized.length;
  return sanitized;
};

const getStringDataProperty = (
  value: object,
  key: PropertyKey,
  fallback: string,
) => {
  const property = getDataProperty(value, key)?.value;
  return typeof property === 'string' ? property : fallback;
};

const nativeLazyErrorStackGetters = (() => {
  const getters = new Set<() => unknown>();
  const capture = (value: object) => {
    try {
      // oxlint-disable-next-line typescript/unbound-method -- captured only for identity checking and guarded invocation with an Error receiver
      const getter = Object.getOwnPropertyDescriptor(value, 'stack')?.get;
      if (getter !== undefined) getters.add(getter);
    } catch {
      // Stack descriptors are non-standard and may be unavailable.
    }
  };
  capture(new Error());
  capture(Error.prototype);
  return getters;
})();

const getErrorStack = (value: object) => {
  const dataStack = getStringDataProperty(value, 'stack', '');
  if (dataStack !== '') return dataStack;

  try {
    const visited = new WeakSet<object>();
    let current: object | null = value;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, 'stack');
      if (descriptor !== undefined) {
        if ('value' in descriptor) {
          return typeof descriptor.value === 'string' ? descriptor.value : '';
        }
        // oxlint-disable-next-line typescript/unbound-method -- identity-checked below and invoked with the original Error receiver
        const getter = descriptor.get;
        if (getter === undefined || !nativeLazyErrorStackGetters.has(getter)) {
          return '';
        }
        const stack: unknown = getter.call(value);
        return typeof stack === 'string' ? stack : '';
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return '';
  } catch {
    return '';
  }
};

const consumeObjectBudget = (budget: SanitizationBudget) => {
  if (budget.remainingObjects === 0) {
    markTruncated(budget);
    return false;
  }
  budget.remainingObjects -= 1;
  return true;
};

const isErrorInstance = (value: object): value is Error => {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
};

const isDateInstance = (value: object): value is Date => {
  try {
    return value instanceof Date;
  } catch {
    return false;
  }
};

const isArrayValue = (value: object): value is unknown[] => {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
};

const isTerminalBinaryValue = (value: object) => {
  try {
    return (
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value) ||
      (typeof Blob !== 'undefined' && value instanceof Blob)
    );
  } catch {
    return false;
  }
};

const getEnumerableOwnKeys = (value: object) => {
  const keys: string[] = [];
  let scannedKeys = 0;
  let incomplete = false;
  try {
    for (const key in value) {
      if (scannedKeys === MAX_ENUMERATED_OBJECT_KEYS) {
        incomplete = true;
        break;
      }
      scannedKeys += 1;
      try {
        if (Object.hasOwn(value, key)) keys.push(key);
      } catch {
        incomplete = true;
      }
    }
  } catch {
    incomplete = true;
  }
  return { incomplete, keys };
};

const isPriorityDiagnosticObject = (value: object) =>
  getAggregateErrorDetails(value) !== null ||
  isErrorInstance(value) ||
  isNativeDomException(value);

type PriorityPathEntry = Readonly<{ key: string; object: object }>;

const getPrioritizedKeysByObject = (root: object) => {
  const prioritizedKeys = new WeakMap<object, Set<string>>();
  const markPath = (path: readonly PriorityPathEntry[]) => {
    for (const { key, object } of path) {
      const keys = prioritizedKeys.get(object) ?? new Set<string>();
      keys.add(key);
      prioritizedKeys.set(object, keys);
    }
  };
  const queue: Array<
    Readonly<{
      depth: number;
      path: readonly PriorityPathEntry[];
      value: object;
    }>
  > = [{ depth: 0, path: [], value: root }];
  const seen = new WeakSet<object>();
  let cursor = 0;
  let scheduledNodes = 1;

  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined || seen.has(current.value)) continue;
    seen.add(current.value);

    for (const key of PRIORITY_DIAGNOSTIC_KEYS) {
      const property = getOwnEnumerableDataProperty(current.value, key);
      if (property !== null && property.value !== undefined) {
        markPath([...current.path, { key, object: current.value }]);
      }
    }

    const { keys } = getEnumerableOwnKeys(current.value);
    for (const key of keys) {
      if (PRIORITY_DIAGNOSTIC_KEY_SET.has(key)) continue;
      const property = getOwnEnumerableDataProperty(current.value, key);
      if (
        property === null ||
        typeof property.value !== 'object' ||
        property.value === null
      ) {
        continue;
      }
      const path = [...current.path, { key, object: current.value }];
      if (isPriorityDiagnosticObject(property.value)) {
        markPath(path);
      } else if (
        current.depth < MAX_PRIORITY_SEARCH_DEPTH &&
        scheduledNodes < MAX_PRIORITY_SEARCH_NODES
      ) {
        queue.push({
          depth: current.depth + 1,
          path,
          value: property.value,
        });
        scheduledNodes += 1;
      }
    }
  }

  return prioritizedKeys;
};

const getUniqueSanitizedKey = (
  result: Record<string, VoiceDiagnosticValue>,
  sanitizedKey: string,
) => {
  if (
    sanitizedKey !== TRUNCATED_PROPERTY &&
    !Object.hasOwn(result, sanitizedKey)
  ) {
    return sanitizedKey;
  }
  for (let collision = 2; ; collision += 1) {
    const suffix = `#${collision}`;
    const candidate = `${sanitizedKey.slice(
      0,
      MAX_SANITIZED_STRING_LENGTH - suffix.length,
    )}${suffix}`;
    if (candidate !== TRUNCATED_PROPERTY && !Object.hasOwn(result, candidate)) {
      return candidate;
    }
  }
};

const setSanitizedProperty = (
  result: Record<string, VoiceDiagnosticValue>,
  key: string,
  value: VoiceDiagnosticValue,
) => {
  Object.defineProperty(result, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const markSanitizedObjectTruncated = (
  result: Record<string, VoiceDiagnosticValue>,
  budget: SanitizationBudget,
) => {
  markTruncated(budget);
  setSanitizedProperty(result, TRUNCATED_PROPERTY, true);
};

const mergeOwnDataProperties = (
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
) => {
  if (source === undefined) return false;
  let incomplete = false;
  const mergeProperty = (key: string) => {
    const descriptor = getOwnPropertyDescriptorSafely(source, key);
    if (descriptor === null) {
      incomplete = true;
    } else if (descriptor?.enumerable === true && 'value' in descriptor) {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    } else if (descriptor?.enumerable === true) {
      incomplete = true;
    }
  };
  for (const key of PRIORITY_DIAGNOSTIC_KEYS) {
    mergeProperty(key);
  }
  const enumerated = getEnumerableOwnKeys(source);
  incomplete ||= enumerated.incomplete;
  for (const key of enumerated.keys) {
    if (!PRIORITY_DIAGNOSTIC_KEY_SET.has(key)) mergeProperty(key);
  }
  return incomplete;
};

const sanitizeValue = (
  value: unknown,
  secrets: ReadonlySet<string>,
  seen: WeakSet<object>,
  budget: SanitizationBudget,
): VoiceDiagnosticValue | undefined => {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return Number.isFinite(value as number) || typeof value !== 'number'
      ? value
      : String(value);
  }
  if (typeof value === 'string') {
    return sanitizeString(value, secrets, budget);
  }
  if (typeof value === 'bigint') {
    return truncateDiagnosticString(value.toString(), budget);
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return undefined;
  }
  if (isDateInstance(value)) {
    try {
      const time = Date.prototype.getTime.call(value);
      return truncateDiagnosticString(
        Number.isFinite(time)
          ? Date.prototype.toISOString.call(value)
          : 'Invalid Date',
        budget,
      );
    } catch {
      return truncateDiagnosticString('Invalid Date', budget);
    }
  }
  if (isTerminalBinaryValue(value)) {
    return REDACTED;
  }
  if (typeof value === 'object' && seen.has(value)) return '[Circular]';

  const aggregate = getAggregateErrorDetails(value);
  if (aggregate !== null) {
    const canTraverse = consumeObjectBudget(budget);
    seen.add(aggregate.error);
    try {
      const sanitizedFailures = canTraverse
        ? sanitizeValue(aggregate.failures, secrets, seen, budget)
        : markTruncated(budget);
      const errors = Array.isArray(sanitizedFailures)
        ? sanitizedFailures
        : [sanitizedFailures ?? null];
      const causeProperty = canTraverse
        ? getOwnDataProperty(aggregate.error, 'cause')
        : null;
      const cause =
        causeProperty === null
          ? undefined
          : sanitizeValue(causeProperty.value, secrets, seen, budget);
      const stack = getErrorStack(aggregate.error);
      return {
        name: sanitizeString(
          getStringDataProperty(aggregate.error, 'name', 'AggregateError'),
          secrets,
          budget,
        ),
        message: sanitizeString(
          getStringDataProperty(aggregate.error, 'message', ''),
          secrets,
          budget,
        ),
        ...(stack === ''
          ? undefined
          : { stack: sanitizeString(stack, secrets, budget) }),
        errors,
        ...(cause === undefined ? undefined : { cause }),
        ...(canTraverse ? undefined : { [TRUNCATED_PROPERTY]: true }),
      };
    } finally {
      seen.delete(aggregate.error);
    }
  }
  if (isNativeDomException(value)) {
    const canTraverse = consumeObjectBudget(budget);
    seen.add(value);
    try {
      const causeProperty = canTraverse
        ? getOwnDataProperty(value, 'cause')
        : null;
      const cause =
        causeProperty === null
          ? undefined
          : sanitizeValue(causeProperty.value, secrets, seen, budget);
      const stack = getErrorStack(value);
      return {
        name: sanitizeString(
          getBrowserErrorString(value, 'name') ?? 'DOMException',
          secrets,
          budget,
        ),
        message: sanitizeString(
          getBrowserErrorString(value, 'message') ?? '',
          secrets,
          budget,
        ),
        ...(stack !== ''
          ? { stack: sanitizeString(stack, secrets, budget) }
          : undefined),
        ...(cause === undefined ? undefined : { cause }),
        ...(canTraverse ? undefined : { [TRUNCATED_PROPERTY]: true }),
      };
    } finally {
      seen.delete(value);
    }
  }
  if (isErrorInstance(value)) {
    const canTraverse = consumeObjectBudget(budget);
    seen.add(value);
    try {
      const causeProperty = canTraverse
        ? getOwnDataProperty(value, 'cause')
        : null;
      const cause =
        causeProperty === null
          ? undefined
          : sanitizeValue(causeProperty.value, secrets, seen, budget);
      const stack = getErrorStack(value);
      return {
        name: sanitizeString(
          getStringDataProperty(value, 'name', 'Error'),
          secrets,
          budget,
        ),
        message: sanitizeString(
          getStringDataProperty(value, 'message', ''),
          secrets,
          budget,
        ),
        ...(stack === ''
          ? undefined
          : { stack: sanitizeString(stack, secrets, budget) }),
        ...(cause === undefined ? undefined : { cause }),
        ...(canTraverse ? undefined : { [TRUNCATED_PROPERTY]: true }),
      };
    } finally {
      seen.delete(value);
    }
  }
  if (!consumeObjectBudget(budget)) return markTruncated(budget);
  if (isArrayValue(value)) {
    seen.add(value);
    try {
      const result: VoiceDiagnosticValue[] = [];
      const length = getOwnDataProperty(value, 'length')?.value;
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        result.push(markTruncated(budget));
        return result;
      }
      for (let index = 0; index < length; index += 1) {
        if (budget.remainingEntries === 0) {
          result.push(markTruncated(budget));
          break;
        }
        budget.remainingEntries -= 1;
        const descriptor = getOwnPropertyDescriptorSafely(value, index);
        if (descriptor === null) {
          result.push(markTruncated(budget));
        } else if (descriptor?.enumerable === true && 'value' in descriptor) {
          try {
            result.push(
              sanitizeValue(descriptor.value, secrets, seen, budget) ?? null,
            );
          } catch {
            result.push(markTruncated(budget));
          }
        } else {
          if (descriptor?.enumerable === true) budget.truncated = true;
          result.push(null);
        }
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  seen.add(value);
  try {
    const result: Record<string, VoiceDiagnosticValue> = {};
    const sanitizeEntry = (key: string): boolean => {
      const descriptor = getOwnPropertyDescriptorSafely(value, key);
      if (descriptor === null) {
        markSanitizedObjectTruncated(result, budget);
        return true;
      }
      if (descriptor === undefined || descriptor.enumerable !== true)
        return true;
      if (!('value' in descriptor)) {
        markSanitizedObjectTruncated(result, budget);
        return true;
      }
      if (budget.remainingEntries === 0) {
        markSanitizedObjectTruncated(result, budget);
        return false;
      }
      budget.remainingEntries -= 1;
      const sanitizedKey = sanitizeObjectKey(key, secrets, budget);
      if (sanitizedKey === null) {
        markSanitizedObjectTruncated(result, budget);
        return false;
      }
      const resultKey = getUniqueSanitizedKey(result, sanitizedKey);
      if (REDACTED_KEYS.has(normalizeKey(key))) {
        setSanitizedProperty(result, resultKey, REDACTED);
        return true;
      }
      let sanitized: VoiceDiagnosticValue | undefined;
      try {
        sanitized = sanitizeValue(descriptor.value, secrets, seen, budget);
      } catch {
        sanitized = markTruncated(budget);
        markSanitizedObjectTruncated(result, budget);
      }
      if (sanitized !== undefined) {
        setSanitizedProperty(result, resultKey, sanitized);
      }
      return true;
    };

    for (const key of PRIORITY_DIAGNOSTIC_KEYS) {
      if (!sanitizeEntry(key)) return result;
    }
    const enumerated = getEnumerableOwnKeys(value);
    if (enumerated.incomplete) markSanitizedObjectTruncated(result, budget);
    const priorityKeys = budget.prioritizedKeys.get(value);
    const prioritized: string[] = [];
    const remaining: string[] = [];
    for (const key of enumerated.keys) {
      if (PRIORITY_DIAGNOSTIC_KEY_SET.has(key)) continue;
      (priorityKeys?.has(key) === true ? prioritized : remaining).push(key);
    }
    for (const key of [...prioritized, ...remaining]) {
      if (!sanitizeEntry(key)) break;
    }
    return result;
  } finally {
    seen.delete(value);
  }
};

const freezeDiagnosticValue = <Value extends VoiceDiagnosticValue>(
  value: Value,
): Value => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeDiagnosticValue(child);
    }
    Object.freeze(value);
  }
  return value;
};

const sanitizeDetails = (
  details: Record<string, unknown>,
  secrets: ReadonlySet<string>,
  initiallyTruncated = false,
): Readonly<{ details: VoiceDiagnosticDetails; truncated: boolean }> => {
  const budget: SanitizationBudget = {
    prioritizedKeys: getPrioritizedKeysByObject(details),
    remainingEntries: MAX_SANITIZED_ENTRIES,
    remainingObjects: MAX_SANITIZED_OBJECTS,
    remainingStringLength: MAX_SANITIZED_TOTAL_STRING_LENGTH,
    truncated: initiallyTruncated,
  };
  const sanitized = sanitizeValue(details, secrets, new WeakSet(), budget);
  if (
    sanitized !== null &&
    !Array.isArray(sanitized) &&
    typeof sanitized === 'object'
  ) {
    if (initiallyTruncated) {
      setSanitizedProperty(
        sanitized as Record<string, VoiceDiagnosticValue>,
        TRUNCATED_PROPERTY,
        true,
      );
    }
    return {
      details: freezeDiagnosticValue(
        sanitized as Record<string, VoiceDiagnosticValue>,
      ),
      truncated: budget.truncated,
    };
  }
  return {
    details: freezeDiagnosticValue({ value: sanitized ?? null }),
    truncated: budget.truncated,
  };
};

const getConfiguration = (configuration: DiagnosticConfiguration) => {
  if (configuration === false) {
    return null;
  }
  const logger: VoiceLogger | false =
    configuration?.logger === false
      ? false
      : (configuration?.logger ?? console);
  return {
    includeContent: configuration?.includeContent ?? false,
    level: configuration?.level ?? 'warn',
    logger,
    onEvent: configuration?.onEvent,
  };
};

export const createVoiceDiagnosticsReporter = (
  getOptions: () => DiagnosticConfiguration,
): VoiceDiagnosticsReporter => {
  const instanceId = createId('instance');
  const secrets = new Set<string>();
  let chatId: string | undefined;
  let connectionId: string | undefined;
  let sequence = 0;

  const isEnabled = (level: VoiceDiagnosticLevel) => {
    const configuration = getConfiguration(getOptions());
    return (
      configuration !== null &&
      LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configuration.level]
    );
  };

  return {
    addRedactionValue(value) {
      if (value !== undefined && value !== '') {
        secrets.add(value);
      }
    },
    beginConnection(secret) {
      secrets.clear();
      if (secret !== undefined && secret !== '') {
        secrets.add(secret);
      }
      chatId = undefined;
      connectionId = createId('connection');
      return connectionId;
    },
    clearConnection() {
      chatId = undefined;
      connectionId = undefined;
    },
    emit(input) {
      const configuration = getConfiguration(getOptions());
      if (
        configuration === null ||
        LEVEL_PRIORITY[input.level] < LEVEL_PRIORITY[configuration.level]
      ) {
        return;
      }

      let details: VoiceDiagnosticDetails;
      let detailsTruncated = false;
      try {
        const combinedDetails: Record<string, unknown> = {};
        let mergeIncomplete = mergeOwnDataProperties(
          combinedDetails,
          input.details,
        );
        if (configuration.includeContent) {
          const sensitiveMergeIncomplete = mergeOwnDataProperties(
            combinedDetails,
            input.sensitiveDetails,
          );
          mergeIncomplete ||= sensitiveMergeIncomplete;
        }
        const sanitized = sanitizeDetails(
          combinedDetails,
          secrets,
          mergeIncomplete,
        );
        details = sanitized.details;
        detailsTruncated = sanitized.truncated;
      } catch {
        details = Object.freeze({ sanitizationFailed: true });
        detailsTruncated = true;
      }
      sequence += 1;
      const eventConnectionId =
        input.connectionId === null
          ? undefined
          : (input.connectionId ?? connectionId);
      const shouldInheritActiveChat =
        input.connectionId === undefined || input.connectionId === connectionId;
      const eventChatId =
        input.chatId === null
          ? undefined
          : (input.chatId ?? (shouldInheritActiveChat ? chatId : undefined));
      const event = Object.freeze({
        schemaVersion: 1 as const,
        sdkVersion: packageJson.version,
        timestamp: new Date().toISOString(),
        sequence,
        instanceId,
        ...(eventConnectionId !== undefined && eventConnectionId !== ''
          ? { connectionId: eventConnectionId }
          : undefined),
        ...(eventChatId !== undefined && eventChatId !== ''
          ? { chatId: eventChatId }
          : undefined),
        level: input.level,
        category: input.category,
        name: input.name,
        ...(input.durationMs === undefined
          ? undefined
          : { durationMs: Math.max(0, input.durationMs) }),
        ...(detailsTruncated ? { detailsTruncated: true as const } : undefined),
        details,
      }) satisfies VoiceDiagnosticEvent;

      try {
        configuration.onEvent?.(event);
      } catch {
        // Diagnostics must never affect the voice lifecycle.
      }

      if (configuration.logger !== false) {
        try {
          configuration.logger[input.level](
            `[Hume Voice][${input.category}] ${input.name}`,
            event,
          );
        } catch {
          // A broken logger is isolated from both the SDK and the event callback.
        }
      }
    },
    getCorrelation() {
      return Object.freeze({
        ...(connectionId !== undefined && connectionId !== ''
          ? { connectionId }
          : undefined),
        ...(chatId !== undefined && chatId !== '' ? { chatId } : undefined),
      });
    },
    isEnabled,
    setChatId(nextChatId) {
      chatId =
        nextChatId !== undefined && nextChatId !== ''
          ? redactSecrets(nextChatId, secrets)
          : undefined;
    },
  };
};
