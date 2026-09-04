import packageJson from '../../package.json';
import {
  getAggregateErrorDetails,
  getDataProperty,
  getOwnEnumerableDataProperty,
  getOwnDataProperty,
  getOwnPropertyDescriptorSafely,
  getPropertyDescriptorSafely,
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
  | 'control.change_failed'
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
  let correlation: ReturnType<VoiceDiagnosticsReporter['getCorrelation']> = {};
  let correlationCaptured = false;
  const isFailureReportingEnabled = () => {
    if (diagnostics === undefined) return false;
    try {
      return diagnostics.isEnabled('warn');
    } catch {
      // Preserve reporting for custom reporters whose enabled check is broken.
      return true;
    }
  };
  const captureCorrelation = () => {
    if (correlationCaptured) return;
    correlationCaptured = true;
    try {
      correlation = diagnostics?.getCorrelation() ?? {};
    } catch {
      // A custom reporter may not support correlation snapshots reliably.
    }
  };
  if (isFailureReportingEnabled()) captureCorrelation();

  const reportFailure = (error: unknown) => {
    const reporter = diagnostics;
    if (reporter === undefined || !isFailureReportingEnabled()) return;
    captureCorrelation();
    try {
      reporter.emit({
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
      // A disabled reporter may become enabled before an asynchronous callback
      // rejects, so retain the invocation's correlation for delayed failures.
      captureCorrelation();
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
// Redaction work meters explicit code-unit comparisons against candidate
// secrets. Bounding it per string keeps one pathological value from starving
// its siblings; bounding it per event caps the total cost of an emit.
const MAX_SANITIZED_STRING_REDACTION_WORK = 262_144;
const MAX_SANITIZED_TOTAL_REDACTION_WORK =
  MAX_SANITIZED_STRING_REDACTION_WORK * 4;
const MAX_ENUMERATED_OBJECT_KEYS = MAX_SANITIZED_ENTRIES;
// Non-enumerable properties do not consume the result-entry budget, but their
// descriptors still execute proxy traps. Keep that inspection work separately
// bounded while leaving enough headroom for ordinary objects with hidden state.
const MAX_SCANNED_OBJECT_KEYS = MAX_ENUMERATED_OBJECT_KEYS * 16;
// A chain of individually bounded objects must not multiply own-key scan work
// across one emit. Share one allowance across merging, priority discovery, and
// sanitization; selected data descriptors are read separately.
const MAX_SCANNED_TOTAL_OBJECT_KEYS = MAX_SCANNED_OBJECT_KEYS;
const PRIORITY_DIAGNOSTIC_KEYS = [
  'error',
  'errors',
  'failures',
  'cause',
] as const;
const PRIORITY_DIAGNOSTIC_KEY_SET = new Set<string>(PRIORITY_DIAGNOSTIC_KEYS);
const MAX_PRIORITY_SEARCH_DEPTH = 8;
// Priority discovery can schedule every object that sanitization could retain
// plus a similarly sized nested frontier. The shared descriptor budget can end
// inspection earlier for objects with several sampled traversal keys.
const MAX_PRIORITY_SEARCH_NODES = MAX_SANITIZED_OBJECTS * 2;
// Reserve enough descriptor work to probe and sample that larger frontier
// while retaining a quarter of the event allowance for merging and ordinary
// sanitization. Unused discovery work is returned after the search.
const MAX_PRIORITY_SCANNED_TOTAL_KEYS = Math.floor(
  (MAX_SCANNED_TOTAL_OBJECT_KEYS * 3) / 4,
);
// Sample as many ordinary traversal keys as there are direct priority probes.
// Narrow graphs can reach the node cap; wider graphs remain bounded by the
// shared descriptor allowance.
const MAX_PRIORITY_KEYS_PER_OBJECT = PRIORITY_DIAGNOSTIC_KEYS.length;
// Spend at most half of the output-entry budget while sanitizing prioritized
// sensitive details. The same limit also bounds how many sensitive root keys
// are queued, since every retained root key consumes at least one entry.
const MAX_PRIORITIZED_SENSITIVE_ENTRIES = Math.floor(MAX_SANITIZED_ENTRIES / 2);
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

type BoundedRedaction = Readonly<{
  consumedWork: number;
  sourceTruncated: boolean;
  value: string;
}>;

/** Registered secrets indexed for leftmost-longest matching; null when empty. */
type RedactionMatcher = Readonly<{
  candidatesByFirstCodeUnit: ReadonlyMap<string, readonly string[]>;
}> | null;

const createRedactionMatcher = (
  secrets: ReadonlySet<string>,
): RedactionMatcher => {
  const candidatesByFirstCodeUnit = new Map<string, string[]>();
  for (const secret of secrets) {
    const firstCodeUnit = secret.charAt(0);
    if (firstCodeUnit === '') continue;
    const candidates = candidatesByFirstCodeUnit.get(firstCodeUnit) ?? [];
    candidates.push(secret);
    candidatesByFirstCodeUnit.set(firstCodeUnit, candidates);
  }
  if (candidatesByFirstCodeUnit.size === 0) return null;
  for (const candidates of candidatesByFirstCodeUnit.values()) {
    candidates.sort((left, right) => right.length - left.length);
  }
  return {
    candidatesByFirstCodeUnit,
  };
};

/**
 * Redact only the source prefix that can contribute to the bounded output.
 *
 * A first-code-unit index locates candidate starts without iterating every
 * registered secret. `maximumWork` meters only the explicit code-unit
 * comparisons spent matching candidates, so ordinary text does not consume
 * the budget. When the work runs out mid-comparison the result stops before
 * the unresolved candidate so no secret prefix is exposed.
 */
const redactSecretsWithinLimits = (
  value: string,
  matcher: RedactionMatcher,
  maximumWork: number,
  maximumOutputLength: number,
): BoundedRedaction => {
  if (matcher === null) {
    const consumedLength = Math.min(value.length, maximumOutputLength);
    return {
      consumedWork: 0,
      sourceTruncated: value.length > consumedLength,
      value: value.slice(0, consumedLength),
    };
  }
  // Each literal output advances the source cursor once, and each matched
  // secret advances it by one more than its comparisons. The cursor therefore
  // cannot pass this prefix. Searching within it keeps a huge input from being
  // scanned past the point where anything can be retained.
  const searchLimit = maximumOutputLength * 2 + maximumWork;
  const searchable =
    value.length > searchLimit ? value.slice(0, searchLimit) : value;
  const { candidatesByFirstCodeUnit } = matcher;

  let cursor = 0;
  let consumedWork = 0;
  let sanitized = '';
  while (cursor < searchable.length && sanitized.length < maximumOutputLength) {
    // Scan candidate starts once in source order. Limiting the scan to the
    // literal text that can still fit makes this work independent of how many
    // distinct first code units are registered.
    const literalLimit = Math.min(
      searchable.length,
      cursor + maximumOutputLength - sanitized.length,
    );
    let candidateIndex = cursor;
    while (
      candidateIndex < literalLimit &&
      !candidatesByFirstCodeUnit.has(searchable.charAt(candidateIndex))
    ) {
      candidateIndex += 1;
    }
    if (candidateIndex > cursor) {
      const literalLength = Math.min(
        candidateIndex - cursor,
        maximumOutputLength - sanitized.length,
      );
      sanitized += searchable.slice(cursor, cursor + literalLength);
      cursor += literalLength;
      // Stop when the output filled or the search prefix ran out.
      if (
        sanitized.length === maximumOutputLength ||
        cursor === searchable.length
      ) {
        break;
      }
    }

    const firstCodeUnit = searchable.charAt(cursor);
    let matchedSecret = '';
    candidateSearch: for (const secret of candidatesByFirstCodeUnit.get(
      firstCodeUnit,
    ) ?? []) {
      for (let offset = 1; offset < secret.length; offset += 1) {
        if (consumedWork === maximumWork) {
          return { consumedWork, sourceTruncated: true, value: sanitized };
        }
        consumedWork += 1;
        // `searchable` is a prefix of `value`, so cursor offsets stay aligned.
        // Use the original string to keep match lookahead independent of the
        // bounded candidate-start scan above.
        if (value.charCodeAt(cursor + offset) !== secret.charCodeAt(offset)) {
          continue candidateSearch;
        }
      }
      matchedSecret = secret;
      break;
    }
    if (matchedSecret === '') {
      sanitized += firstCodeUnit;
      cursor += 1;
    } else {
      if (sanitized.length + REDACTED.length > maximumOutputLength) break;
      sanitized += REDACTED;
      cursor += matchedSecret.length;
    }
  }

  return {
    consumedWork,
    sourceTruncated: cursor < value.length,
    value: sanitized,
  };
};

const redactCorrelationId = (value: string, matcher: RedactionMatcher) => {
  const redacted = redactSecretsWithinLimits(
    value,
    matcher,
    MAX_SANITIZED_STRING_REDACTION_WORK,
    MAX_SANITIZED_STRING_LENGTH,
  );
  if (!redacted.sourceTruncated) return redacted.value;
  return `${redacted.value.slice(
    0,
    MAX_SANITIZED_STRING_LENGTH - TRUNCATED_SUFFIX.length,
  )}${TRUNCATED_SUFFIX}`;
};

type EnumeratedKeys = { incomplete: boolean; keys: string[] };
type SampledEnumerableOwnKeys = EnumeratedKeys & {
  descriptors: ReadonlyMap<string, PropertyDescriptor>;
};
type OwnKeyScanBudget = { remainingKeys: number };

type SanitizationBudget = {
  enumeratedKeysByObject: WeakMap<object, EnumeratedKeys>;
  ownKeyScanBudget: OwnKeyScanBudget;
  prioritizedKeys: WeakMap<object, Set<string>>;
  prioritizedSensitiveKeys: ReadonlySet<string>;
  remainingEntries: number;
  remainingObjects: number;
  remainingRedactionWork: number;
  remainingStringLength: number;
  sensitiveDetailsRoot: object;
  truncated: boolean;
};

const markTruncated = (budget: SanitizationBudget): VoiceDiagnosticValue => {
  budget.truncated = true;
  return TRUNCATED_VALUE;
};

function truncateSanitizedString(
  value: string,
  budget: SanitizationBudget,
  sourceTruncated?: boolean,
): string;
function truncateSanitizedString(
  value: string,
  budget: SanitizationBudget,
  sourceTruncated: boolean,
  requireCompleteSuffix: true,
): string | null;
function truncateSanitizedString(
  value: string,
  budget: SanitizationBudget,
  sourceTruncated = false,
  requireCompleteSuffix = false,
): string | null {
  const maximumLength = Math.min(
    MAX_SANITIZED_STRING_LENGTH,
    budget.remainingStringLength,
  );
  if (!sourceTruncated && value.length <= maximumLength) {
    budget.remainingStringLength -= value.length;
    return value;
  }
  budget.truncated = true;
  if (requireCompleteSuffix && maximumLength < TRUNCATED_SUFFIX.length) {
    return null;
  }
  if (maximumLength === 0) return '';
  const suffix = requireCompleteSuffix
    ? TRUNCATED_SUFFIX
    : TRUNCATED_SUFFIX.slice(0, maximumLength);
  const truncated = `${value.slice(0, maximumLength - suffix.length)}${suffix}`;
  budget.remainingStringLength -= truncated.length;
  return truncated;
}

const truncateDiagnosticString = (
  value: string,
  budget: SanitizationBudget,
  sourceTruncated = false,
) => truncateSanitizedString(value, budget, sourceTruncated);

const redactWithinBudget = (
  value: string,
  matcher: RedactionMatcher,
  budget: SanitizationBudget,
) => {
  const redacted = redactSecretsWithinLimits(
    value,
    matcher,
    Math.min(
      MAX_SANITIZED_STRING_REDACTION_WORK,
      budget.remainingRedactionWork,
    ),
    Math.min(MAX_SANITIZED_STRING_LENGTH, budget.remainingStringLength),
  );
  budget.remainingRedactionWork -= redacted.consumedWork;
  return redacted;
};

const sanitizeString = (
  value: string,
  matcher: RedactionMatcher,
  budget: SanitizationBudget,
) => {
  const redacted = redactWithinBudget(value, matcher, budget);
  return truncateDiagnosticString(
    redacted.value,
    budget,
    redacted.sourceTruncated,
  );
};

/** Returns null when no part of the key can be kept without exposing a secret. */
const sanitizeObjectKey = (
  value: string,
  matcher: RedactionMatcher,
  budget: SanitizationBudget,
): string | null => {
  const redacted = redactWithinBudget(value, matcher, budget);
  if (redacted.value === '' && redacted.sourceTruncated) {
    // Whether the string or the redaction-work budget ran out, a bare
    // truncation marker would replace the property name.
    budget.truncated = true;
    return null;
  }
  return truncateSanitizedString(
    redacted.value,
    budget,
    redacted.sourceTruncated,
    true,
  );
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
  try {
    const descriptor = getPropertyDescriptorSafely(value, 'stack');
    if (descriptor === null || descriptor === undefined) return '';
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

/** Values serialized as a single string and never enumerated as objects. */
const isTerminalDiagnosticObject = (value: object) =>
  isDateInstance(value) || isTerminalBinaryValue(value);

const getEnumerableOwnKeys = (
  value: object,
  budget: OwnKeyScanBudget,
): EnumeratedKeys => {
  if (budget.remainingKeys === 0) return { incomplete: true, keys: [] };
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return { incomplete: true, keys: [] };
  }

  const keys: string[] = [];
  let scannedKeys = 0;
  let incomplete = false;
  for (const key of ownKeys) {
    if (scannedKeys === MAX_SCANNED_OBJECT_KEYS || budget.remainingKeys === 0) {
      incomplete = true;
      break;
    }
    scannedKeys += 1;
    budget.remainingKeys -= 1;
    if (typeof key !== 'string') continue;
    const descriptor = getOwnPropertyDescriptorSafely(value, key);
    if (descriptor === null || descriptor === undefined) {
      // One unavailable key must not discard siblings that can still be read.
      incomplete = true;
      continue;
    }
    if (descriptor.enumerable !== true) continue;
    if (keys.length === MAX_ENUMERATED_OBJECT_KEYS) {
      incomplete = true;
      break;
    }
    keys.push(key);
  }
  return { incomplete, keys };
};

const getLeadingAndTrailingIndexes = (length: number, count: number) => {
  const leadingCount = Math.ceil(count / 2);
  const trailingCount = count - leadingCount;
  const indexes: number[] = [];
  for (let offset = 0; offset < leadingCount; offset += 1) {
    indexes.push(offset);
    if (offset < trailingCount) {
      indexes.push(length - 1 - offset);
    }
  }
  return indexes;
};

const getBalancedScanAllowances = (
  requestedKeys: readonly number[],
  availableKeys: number,
) => {
  const allowances = requestedKeys.map(() => 0);
  let remainingKeys = availableKeys;
  let pendingIndexes = requestedKeys.map((_, index) => index);

  while (pendingIndexes.length > 0) {
    const equalShare = Math.floor(remainingKeys / pendingIndexes.length);
    const satisfiedIndexes = pendingIndexes.filter(
      (index) => (requestedKeys[index] ?? 0) <= equalShare,
    );
    if (satisfiedIndexes.length === 0) {
      const remainder = remainingKeys % pendingIndexes.length;
      pendingIndexes.forEach((index, position) => {
        allowances[index] = equalShare + (position < remainder ? 1 : 0);
      });
      break;
    }

    const satisfied = new Set(satisfiedIndexes);
    for (const index of satisfiedIndexes) {
      const requested = requestedKeys[index] ?? 0;
      allowances[index] = requested;
      remainingKeys -= requested;
    }
    pendingIndexes = pendingIndexes.filter((index) => !satisfied.has(index));
  }

  return allowances;
};

type SampledEnumerableOwnKeyOptions = Readonly<{
  captureDescriptors?: boolean;
  ownKeysSnapshot?: readonly PropertyKey[];
}>;

function getSampledEnumerableOwnKeys(
  value: object,
  budget: OwnKeyScanBudget,
  maximumScannedKeys: number,
  options: SampledEnumerableOwnKeyOptions &
    Readonly<{ captureDescriptors: true }>,
): SampledEnumerableOwnKeys;
function getSampledEnumerableOwnKeys(
  value: object,
  budget: OwnKeyScanBudget,
  maximumScannedKeys: number,
  options?: SampledEnumerableOwnKeyOptions &
    Readonly<{ captureDescriptors?: false }>,
): EnumeratedKeys;
function getSampledEnumerableOwnKeys(
  value: object,
  budget: OwnKeyScanBudget,
  maximumScannedKeys: number,
  options?: SampledEnumerableOwnKeyOptions,
): EnumeratedKeys | SampledEnumerableOwnKeys {
  const captureDescriptors = options?.captureDescriptors ?? false;
  if (budget.remainingKeys === 0) {
    return captureDescriptors
      ? { descriptors: new Map(), incomplete: true, keys: [] }
      : { incomplete: true, keys: [] };
  }
  let ownKeys: readonly PropertyKey[];
  if (options?.ownKeysSnapshot === undefined) {
    try {
      ownKeys = Reflect.ownKeys(value);
    } catch {
      return captureDescriptors
        ? { descriptors: new Map(), incomplete: true, keys: [] }
        : { incomplete: true, keys: [] };
    }
  } else {
    ownKeys = options.ownKeysSnapshot;
  }

  const count = Math.min(
    ownKeys.length,
    maximumScannedKeys,
    budget.remainingKeys,
  );
  const entries: Array<{ index: number; key: string }> = [];
  const descriptors = captureDescriptors
    ? new Map<string, PropertyDescriptor>()
    : undefined;
  let inspectedKeys = 0;
  let incomplete = ownKeys.length > count;
  for (const index of getLeadingAndTrailingIndexes(ownKeys.length, count)) {
    if (entries.length === MAX_ENUMERATED_OBJECT_KEYS) {
      incomplete = true;
      break;
    }
    inspectedKeys += 1;
    budget.remainingKeys -= 1;
    const key = ownKeys[index];
    if (typeof key !== 'string') continue;
    const descriptor = getOwnPropertyDescriptorSafely(value, key);
    if (descriptor === null || descriptor === undefined) {
      incomplete = true;
      continue;
    }
    if (descriptor.enumerable !== true) continue;
    entries.push({ index, key });
    descriptors?.set(key, descriptor);
  }
  incomplete ||= inspectedKeys < count;
  entries.sort((left, right) => left.index - right.index);
  const keys = entries.map(({ key }) => key);
  return descriptors === undefined
    ? { incomplete, keys }
    : { descriptors, incomplete, keys };
}

const getEnumerableArrayIndexKeys = (
  value: unknown[],
  budget: OwnKeyScanBudget,
): EnumeratedKeys => {
  if (budget.remainingKeys === 0) return { incomplete: true, keys: [] };
  const length = getOwnDataProperty(value, 'length')?.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    return { incomplete: true, keys: [] };
  }
  const count = Math.min(
    length,
    MAX_ENUMERATED_OBJECT_KEYS,
    MAX_PRIORITY_KEYS_PER_OBJECT,
    budget.remainingKeys,
  );
  budget.remainingKeys -= count;
  const keys = getLeadingAndTrailingIndexes(length, count)
    .sort((left, right) => left - right)
    .map(String);
  return { incomplete: length > count, keys };
};

const getEnumerablePriorityObjectKeys = (
  value: object,
  budget: OwnKeyScanBudget,
) => getSampledEnumerableOwnKeys(value, budget, MAX_PRIORITY_KEYS_PER_OBJECT);

const isPriorityDiagnosticObject = (value: object) =>
  getAggregateErrorDetails(value) !== null ||
  isErrorInstance(value) ||
  isNativeDomException(value);

type PriorityPath = Readonly<{
  key: string;
  object: object;
  parent: PriorityPath | null;
}>;

const getPrioritizedKeysByObject = (
  root: object,
  priorityScanBudget: OwnKeyScanBudget,
  rootEnumeratedKeys: EnumeratedKeys,
) => {
  const prioritizedKeys = new WeakMap<object, Set<string>>();
  const enumeratedKeysByObject = new WeakMap<object, EnumeratedKeys>();
  enumeratedKeysByObject.set(root, rootEnumeratedKeys);
  const markPath = (path: PriorityPath) => {
    let current: PriorityPath | null = path;
    while (current !== null) {
      const { key, object } = current;
      const keys = prioritizedKeys.get(object) ?? new Set<string>();
      keys.add(key);
      prioritizedKeys.set(object, keys);
      current = current.parent;
    }
  };
  const queue: Array<
    Readonly<{
      depth: number;
      path: PriorityPath | null;
      value: object;
    }>
  > = [{ depth: 0, path: null, value: root }];
  // Explore a shared object through its first breadth-first path only. Walking
  // every alias would make the bounded search exponential on ordinary DAGs.
  const scheduled = new WeakSet();
  scheduled.add(root);
  let cursor = 0;
  let scheduledNodes = 1;

  const schedule = (value: object, depth: number, path: PriorityPath) => {
    if (
      depth > MAX_PRIORITY_SEARCH_DEPTH ||
      scheduledNodes === MAX_PRIORITY_SEARCH_NODES ||
      scheduled.has(value)
    ) {
      return;
    }
    scheduled.add(value);
    queue.push({ depth, path, value });
    scheduledNodes += 1;
  };
  const visitChild = (child: unknown, depth: number, path: PriorityPath) => {
    if (
      typeof child !== 'object' ||
      child === null ||
      isTerminalDiagnosticObject(child)
    ) {
      return;
    }
    if (isPriorityDiagnosticObject(child)) {
      markPath(path);
    } else {
      schedule(child, depth, path);
    }
  };

  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) continue;
    const { depth, path: parent, value } = current;

    for (const key of PRIORITY_DIAGNOSTIC_KEYS) {
      if (priorityScanBudget.remainingKeys === 0) break;
      priorityScanBudget.remainingKeys -= 1;
      const property = getOwnEnumerableDataProperty(value, key);
      if (property === null || property.value === undefined) continue;
      const path: PriorityPath = { key, object: value, parent };
      markPath(path);
      visitChild(property.value, depth + 1, path);
    }

    const isArray = isArrayValue(value);
    let enumerated: EnumeratedKeys;
    if (value === root) {
      enumerated = rootEnumeratedKeys;
    } else if (isArray) {
      enumerated = getEnumerableArrayIndexKeys(value, priorityScanBudget);
    } else {
      enumerated = getEnumerablePriorityObjectKeys(value, priorityScanBudget);
    }
    if (!isArray && value !== root && !enumerated.incomplete) {
      enumeratedKeysByObject.set(value, enumerated);
    }
    for (const key of enumerated.keys) {
      if (PRIORITY_DIAGNOSTIC_KEY_SET.has(key)) continue;
      const property = getOwnEnumerableDataProperty(value, key);
      if (property === null) {
        // A snapshotted own key changed or became unavailable before it was
        // read. Array holes are ordinary.
        if (!isArray) enumerated.incomplete = true;
        continue;
      }
      visitChild(property.value, depth + 1, { key, object: value, parent });
    }
  }

  return { enumeratedKeysByObject, prioritizedKeys };
};

const getCollisionFreeKey = (
  result: Record<string, VoiceDiagnosticValue>,
  sanitizedKey: string,
  nextCollisionByKey: Map<string, number>,
) => {
  for (
    let collision = nextCollisionByKey.get(sanitizedKey) ?? 2;
    ;
    collision += 1
  ) {
    const suffix = `#${collision}`;
    const candidate = `${sanitizedKey.slice(
      0,
      MAX_SANITIZED_STRING_LENGTH - suffix.length,
    )}${suffix}`;
    if (candidate !== TRUNCATED_PROPERTY && !Object.hasOwn(result, candidate)) {
      nextCollisionByKey.set(sanitizedKey, collision + 1);
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
  sources: readonly (Record<string, unknown> | undefined)[],
  ownKeyScanBudget: OwnKeyScanBudget,
) => {
  let incomplete = false;
  const sourceMerges: Array<{
    missingPriorityKeys: Set<string>;
    prioritize: boolean;
    properties: Record<string, unknown>;
    source: Record<string, unknown>;
  }> = sources.flatMap((source, sourceIndex) =>
    source === undefined
      ? []
      : [
          {
            missingPriorityKeys: new Set<string>(),
            prioritize: sourceIndex > 0,
            properties: {},
            source,
          },
        ],
  );
  const mergeProperty = (
    sourceMerge: (typeof sourceMerges)[number],
    key: string,
    expected: boolean,
    knownDescriptor?: PropertyDescriptor,
  ) => {
    const descriptor =
      knownDescriptor ??
      getOwnPropertyDescriptorSafely(sourceMerge.source, key);
    if (descriptor === null) {
      incomplete = true;
      return false;
    } else if (descriptor === undefined || descriptor.enumerable !== true) {
      // A snapshotted own key vanished or stopped being enumerable before it
      // was read; probed priority keys are simply absent.
      if (expected) incomplete = true;
      return false;
    } else if ('value' in descriptor) {
      Object.defineProperty(sourceMerge.properties, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    } else {
      incomplete = true;
      return false;
    }
    return true;
  };

  // Probe priority keys on every source before a wide source can consume the
  // merge allowance. Per-source staging preserves sensitive-detail overrides.
  for (const sourceMerge of sourceMerges) {
    for (const key of PRIORITY_DIAGNOSTIC_KEYS) {
      if (ownKeyScanBudget.remainingKeys === 0) {
        incomplete = true;
        break;
      }
      ownKeyScanBudget.remainingKeys -= 1;
      if (!mergeProperty(sourceMerge, key, false)) {
        sourceMerge.missingPriorityKeys.add(key);
      }
    }
  }

  const ownKeysBySource = sourceMerges.map((sourceMerge) => {
    try {
      return Reflect.ownKeys(sourceMerge.source);
    } catch {
      incomplete = true;
      return null;
    }
  });
  const sourceAllowances = getBalancedScanAllowances(
    ownKeysBySource.map((ownKeys) => ownKeys?.length ?? 0),
    ownKeyScanBudget.remainingKeys,
  );
  for (const [index, sourceMerge] of sourceMerges.entries()) {
    const ownKeys = ownKeysBySource[index];
    if (ownKeys === null || ownKeys === undefined) continue;
    const enumerated = getSampledEnumerableOwnKeys(
      sourceMerge.source,
      ownKeyScanBudget,
      sourceAllowances[index] ?? 0,
      { captureDescriptors: true, ownKeysSnapshot: ownKeys },
    );
    incomplete ||= enumerated.incomplete;
    for (const key of enumerated.keys) {
      if (
        !PRIORITY_DIAGNOSTIC_KEY_SET.has(key) ||
        sourceMerge.missingPriorityKeys.has(key)
      ) {
        mergeProperty(sourceMerge, key, true, enumerated.descriptors.get(key));
      }
    }
  }

  const prioritizedMergedKeys = new Set<string>();
  for (const sourceMerge of sourceMerges) {
    for (const [key, value] of Object.entries(sourceMerge.properties)) {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      if (
        sourceMerge.prioritize &&
        !PRIORITY_DIAGNOSTIC_KEY_SET.has(key) &&
        prioritizedMergedKeys.size < MAX_PRIORITIZED_SENSITIVE_ENTRIES
      ) {
        prioritizedMergedKeys.add(key);
      }
    }
  }

  return { incomplete, prioritizedMergedKeys };
};

const sanitizeValue = (
  value: unknown,
  matcher: RedactionMatcher,
  seen: WeakSet<object>,
  budget: SanitizationBudget,
): VoiceDiagnosticValue | undefined => {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'string') {
    return sanitizeString(value, matcher, budget);
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
        ? sanitizeValue(aggregate.failures, matcher, seen, budget)
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
          : sanitizeValue(causeProperty.value, matcher, seen, budget);
      const stack = getErrorStack(aggregate.error);
      return {
        name: sanitizeString(
          getStringDataProperty(aggregate.error, 'name', 'AggregateError'),
          matcher,
          budget,
        ),
        message: sanitizeString(
          getStringDataProperty(aggregate.error, 'message', ''),
          matcher,
          budget,
        ),
        ...(stack === ''
          ? undefined
          : { stack: sanitizeString(stack, matcher, budget) }),
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
          : sanitizeValue(causeProperty.value, matcher, seen, budget);
      const stack = getErrorStack(value);
      return {
        name: sanitizeString(
          getBrowserErrorString(value, 'name') ?? 'DOMException',
          matcher,
          budget,
        ),
        message: sanitizeString(
          getBrowserErrorString(value, 'message') ?? '',
          matcher,
          budget,
        ),
        ...(stack !== ''
          ? { stack: sanitizeString(stack, matcher, budget) }
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
          : sanitizeValue(causeProperty.value, matcher, seen, budget);
      const stack = getErrorStack(value);
      return {
        name: sanitizeString(
          getStringDataProperty(value, 'name', 'Error'),
          matcher,
          budget,
        ),
        message: sanitizeString(
          getStringDataProperty(value, 'message', ''),
          matcher,
          budget,
        ),
        ...(stack === ''
          ? undefined
          : { stack: sanitizeString(stack, matcher, budget) }),
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

      const priorityIndexes: number[] = [];
      const priorityKeys = budget.prioritizedKeys.get(value);
      if (priorityKeys !== undefined) {
        for (const key of priorityKeys) {
          const index = Number(key);
          if (
            Number.isSafeInteger(index) &&
            index >= 0 &&
            index < length &&
            String(index) === key
          ) {
            priorityIndexes.push(index);
          }
        }
        priorityIndexes.sort((left, right) => left - right);
      }

      const sanitizedPriorityEntries = new Map<number, VoiceDiagnosticValue>();
      for (const index of priorityIndexes) {
        if (budget.remainingEntries === 0) {
          markTruncated(budget);
          break;
        }
        budget.remainingEntries -= 1;
        const descriptor = getOwnPropertyDescriptorSafely(value, index);
        if (descriptor === null) {
          sanitizedPriorityEntries.set(index, markTruncated(budget));
        } else if (descriptor?.enumerable === true && 'value' in descriptor) {
          try {
            sanitizedPriorityEntries.set(
              index,
              sanitizeValue(descriptor.value, matcher, seen, budget) ?? null,
            );
          } catch {
            sanitizedPriorityEntries.set(index, markTruncated(budget));
          }
        } else {
          markTruncated(budget);
          sanitizedPriorityEntries.set(index, null);
        }
      }

      let index = 0;
      for (; index < length; index += 1) {
        const prioritized = sanitizedPriorityEntries.get(index);
        if (prioritized !== undefined) {
          result.push(prioritized);
          sanitizedPriorityEntries.delete(index);
          continue;
        }
        if (budget.remainingEntries === 0) break;

        budget.remainingEntries -= 1;
        const descriptor = getOwnPropertyDescriptorSafely(value, index);
        if (descriptor === null) {
          result.push(markTruncated(budget));
        } else if (descriptor?.enumerable === true && 'value' in descriptor) {
          try {
            result.push(
              sanitizeValue(descriptor.value, matcher, seen, budget) ?? null,
            );
          } catch {
            result.push(markTruncated(budget));
          }
        } else {
          if (descriptor?.enumerable === true) budget.truncated = true;
          result.push(null);
        }
      }
      if (index < length) result.push(markTruncated(budget));
      for (const prioritized of sanitizedPriorityEntries.values()) {
        result.push(prioritized);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  seen.add(value);
  try {
    const enumerated =
      budget.enumeratedKeysByObject.get(value) ??
      getEnumerableOwnKeys(value, budget.ownKeyScanBudget);
    const result: Record<string, VoiceDiagnosticValue> = {};
    let nextCollisionByKey: Map<string, number> | undefined;
    const sanitizeEntry = (
      key: string,
      expected: boolean,
    ): 'complete' | 'retry' | 'stop' => {
      const descriptor = getOwnPropertyDescriptorSafely(value, key);
      if (descriptor === null) {
        markSanitizedObjectTruncated(result, budget);
        return expected ? 'retry' : 'complete';
      }
      if (descriptor === undefined || descriptor.enumerable !== true) {
        // A snapshotted own key vanished or stopped being enumerable before
        // it was read; probed priority keys are simply absent.
        if (expected) markSanitizedObjectTruncated(result, budget);
        return expected ? 'retry' : 'complete';
      }
      if (!('value' in descriptor)) {
        markSanitizedObjectTruncated(result, budget);
        return expected ? 'retry' : 'complete';
      }
      if (budget.remainingEntries === 0) {
        markSanitizedObjectTruncated(result, budget);
        return 'stop';
      }
      budget.remainingEntries -= 1;
      const sanitizedKey = sanitizeObjectKey(key, matcher, budget);
      if (sanitizedKey === null) {
        // This name cannot be kept, but a later name may still fit.
        markSanitizedObjectTruncated(result, budget);
        return 'complete';
      }
      const resultKey =
        sanitizedKey !== TRUNCATED_PROPERTY &&
        !Object.hasOwn(result, sanitizedKey)
          ? sanitizedKey
          : getCollisionFreeKey(
              result,
              sanitizedKey,
              (nextCollisionByKey ??= new Map<string, number>()),
            );
      if (REDACTED_KEYS.has(normalizeKey(key))) {
        setSanitizedProperty(result, resultKey, REDACTED);
        return 'complete';
      }
      let sanitized: VoiceDiagnosticValue | undefined;
      try {
        sanitized = sanitizeValue(descriptor.value, matcher, seen, budget);
      } catch {
        sanitized = markTruncated(budget);
        markSanitizedObjectTruncated(result, budget);
      }
      if (sanitized !== undefined) {
        setSanitizedProperty(result, resultKey, sanitized);
      }
      return 'complete';
    };

    for (const key of PRIORITY_DIAGNOSTIC_KEYS) {
      const expected = enumerated.keys.includes(key);
      const outcome = sanitizeEntry(key, expected);
      if (outcome === 'stop') return result;
      if (outcome === 'retry' && sanitizeEntry(key, true) === 'stop') {
        return result;
      }
    }
    if (enumerated.incomplete) markSanitizedObjectTruncated(result, budget);
    const priorityKeys = budget.prioritizedKeys.get(value);
    if (priorityKeys !== undefined) {
      const sensitivePriorityKeys =
        value === budget.sensitiveDetailsRoot
          ? budget.prioritizedSensitiveKeys
          : undefined;
      for (const key of priorityKeys) {
        if (PRIORITY_DIAGNOSTIC_KEY_SET.has(key)) continue;
        if (sensitivePriorityKeys?.has(key) === true) continue;
        if (sanitizeEntry(key, true) === 'stop') return result;
      }
    }
    const sensitivePriorityKeys =
      value === budget.sensitiveDetailsRoot
        ? budget.prioritizedSensitiveKeys
        : undefined;
    if (sensitivePriorityKeys !== undefined) {
      const remainingEntriesBeforeSensitiveDetails = budget.remainingEntries;
      const sensitiveEntryAllowance = Math.min(
        remainingEntriesBeforeSensitiveDetails,
        MAX_PRIORITIZED_SENSITIVE_ENTRIES,
      );
      budget.remainingEntries = sensitiveEntryAllowance;
      try {
        for (const key of sensitivePriorityKeys) {
          if (PRIORITY_DIAGNOSTIC_KEY_SET.has(key)) continue;
          if (sanitizeEntry(key, true) === 'stop') break;
        }
      } finally {
        const consumedSensitiveEntries =
          sensitiveEntryAllowance - budget.remainingEntries;
        budget.remainingEntries =
          remainingEntriesBeforeSensitiveDetails - consumedSensitiveEntries;
      }
    }
    for (const key of enumerated.keys) {
      if (PRIORITY_DIAGNOSTIC_KEY_SET.has(key)) continue;
      if (priorityKeys?.has(key) === true) continue;
      if (sensitivePriorityKeys?.has(key) === true) continue;
      if (sanitizeEntry(key, true) === 'stop') break;
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

const isSanitizedRecord = (
  value: VoiceDiagnosticValue | undefined,
): value is Record<string, VoiceDiagnosticValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sanitizeDetails = (
  details: Record<string, unknown>,
  matcher: RedactionMatcher,
  ownKeyScanBudget: OwnKeyScanBudget,
  priorityScanBudget: OwnKeyScanBudget,
  rootEnumeratedKeys: EnumeratedKeys,
  initiallyPrioritizedKeys: ReadonlySet<string>,
  initiallyTruncated = false,
): Readonly<{ details: VoiceDiagnosticDetails; truncated: boolean }> => {
  const priorityDiscovery = getPrioritizedKeysByObject(
    details,
    priorityScanBudget,
    rootEnumeratedKeys,
  );
  // Discovery and sanitization remain independently useful without exceeding
  // the shared per-event own-key scan allowance.
  ownKeyScanBudget.remainingKeys += priorityScanBudget.remainingKeys;
  const budget: SanitizationBudget = {
    enumeratedKeysByObject: priorityDiscovery.enumeratedKeysByObject,
    ownKeyScanBudget,
    prioritizedKeys: priorityDiscovery.prioritizedKeys,
    prioritizedSensitiveKeys: initiallyPrioritizedKeys,
    remainingEntries: MAX_SANITIZED_ENTRIES,
    remainingObjects: MAX_SANITIZED_OBJECTS,
    remainingRedactionWork: MAX_SANITIZED_TOTAL_REDACTION_WORK,
    remainingStringLength: MAX_SANITIZED_TOTAL_STRING_LENGTH,
    sensitiveDetailsRoot: details,
    truncated: initiallyTruncated,
  };
  const sanitized = sanitizeValue(details, matcher, new WeakSet(), budget);
  if (isSanitizedRecord(sanitized)) {
    if (initiallyTruncated) {
      setSanitizedProperty(sanitized, TRUNCATED_PROPERTY, true);
    }
    return {
      details: freezeDiagnosticValue(sanitized),
      truncated: budget.truncated,
    };
  }
  return {
    details: freezeDiagnosticValue({ value: sanitized ?? null }),
    truncated: budget.truncated,
  };
};

const getConfiguration = (
  configuration: false | VoiceDiagnosticsOptions | undefined,
) => {
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
  getOptions: () => false | VoiceDiagnosticsOptions | undefined,
): VoiceDiagnosticsReporter => {
  const instanceId = createId('instance');
  const secrets = new Set<string>();
  // Rebuilt lazily after the secret set changes; null means no secrets.
  let matcher: RedactionMatcher | undefined;
  let chatId: string | undefined;
  let connectionId: string | undefined;
  let sequence = 0;

  const getMatcher = () => {
    if (matcher === undefined) matcher = createRedactionMatcher(secrets);
    return matcher;
  };
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
        matcher = undefined;
      }
    },
    beginConnection(secret) {
      secrets.clear();
      if (secret !== undefined && secret !== '') {
        secrets.add(secret);
      }
      matcher = undefined;
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
        const priorityScanBudget: OwnKeyScanBudget = {
          remainingKeys: MAX_PRIORITY_SCANNED_TOTAL_KEYS,
        };
        const ownKeyScanBudget: OwnKeyScanBudget = {
          remainingKeys:
            MAX_SCANNED_TOTAL_OBJECT_KEYS - MAX_PRIORITY_SCANNED_TOTAL_KEYS,
        };
        const merged = mergeOwnDataProperties(
          combinedDetails,
          [
            input.details,
            configuration.includeContent ? input.sensitiveDetails : undefined,
          ],
          ownKeyScanBudget,
        );
        const combinedKeys = Object.keys(combinedDetails);
        const rootEnumeratedKeys: EnumeratedKeys = {
          incomplete: combinedKeys.length > MAX_ENUMERATED_OBJECT_KEYS,
          keys: combinedKeys.slice(0, MAX_ENUMERATED_OBJECT_KEYS),
        };
        const sanitized = sanitizeDetails(
          combinedDetails,
          getMatcher(),
          ownKeyScanBudget,
          priorityScanBudget,
          rootEnumeratedKeys,
          merged.prioritizedMergedKeys,
          merged.incomplete,
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
          ? redactCorrelationId(nextChatId, getMatcher())
          : undefined;
    },
  };
};
