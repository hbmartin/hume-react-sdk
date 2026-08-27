import packageJson from '../../package.json';

export type VoiceDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export type VoiceDiagnosticCategory =
  | 'connection'
  | 'socket'
  | 'microphone'
  | 'audio_player'
  | 'audio_device'
  | 'message'
  | 'tool'
  | 'consumer';

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

export type VoiceDiagnosticPrimitive = string | number | boolean | null;

export type VoiceDiagnosticValue =
  | VoiceDiagnosticPrimitive
  | readonly VoiceDiagnosticValue[]
  | { readonly [key: string]: VoiceDiagnosticValue };

export type VoiceDiagnosticDetails = Readonly<
  Record<string, VoiceDiagnosticValue>
>;

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
  details: VoiceDiagnosticDetails;
}>;

export interface VoiceLogger {
  debug(message: string, event: VoiceDiagnosticEvent): void;
  info(message: string, event: VoiceDiagnosticEvent): void;
  warn(message: string, event: VoiceDiagnosticEvent): void;
  error(message: string, event: VoiceDiagnosticEvent): void;
}

export interface VoiceDiagnosticsOptions {
  level?: VoiceDiagnosticLevel;
  logger?: VoiceLogger | false;
  onEvent?: (event: VoiceDiagnosticEvent) => void;
  includeContent?: boolean;
}

type DiagnosticConfiguration = false | VoiceDiagnosticsOptions | undefined;

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

export interface VoiceDiagnosticsReporter {
  addRedactionValue(value?: string): void;
  beginConnection(secret?: string): string;
  clearConnection(): void;
  emit(input: VoiceDiagnosticInput): void;
  getCorrelation(): Readonly<{
    connectionId?: string;
    chatId?: string;
  }>;
  isEnabled(level: VoiceDiagnosticLevel): boolean;
  setChatId(chatId?: string): void;
}

const LEVEL_PRIORITY: Record<VoiceDiagnosticLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = '[REDACTED]';
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

const sanitizeValue = (
  value: unknown,
  secrets: ReadonlySet<string>,
  seen: WeakSet<object>,
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
    return redactSecrets(value, secrets);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: redactSecrets(value.name, secrets),
      message: redactSecrets(value.message, secrets),
      ...(value.stack
        ? { stack: redactSecrets(value.stack, secrets) }
        : undefined),
    };
  }
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== 'undefined' && value instanceof Blob)
  ) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    return value
      .map((item) => sanitizeValue(item, secrets, seen))
      .filter((item): item is VoiceDiagnosticValue => item !== undefined);
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const result: Record<string, VoiceDiagnosticValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (REDACTED_KEYS.has(normalizeKey(key))) {
        result[key] = REDACTED;
        continue;
      }
      const sanitized = sanitizeValue(entry, secrets, seen);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    return result;
  }
  return String(value);
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
): VoiceDiagnosticDetails => {
  const sanitized = sanitizeValue(details, secrets, new WeakSet());
  if (sanitized && !Array.isArray(sanitized) && typeof sanitized === 'object') {
    return freezeDiagnosticValue(
      sanitized as Record<string, VoiceDiagnosticValue>,
    );
  }
  return freezeDiagnosticValue({ value: sanitized ?? null });
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
      if (value) {
        secrets.add(value);
      }
    },
    beginConnection(secret) {
      secrets.clear();
      if (secret) {
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

      const combinedDetails = {
        ...(input.details ?? {}),
        ...(configuration.includeContent ? (input.sensitiveDetails ?? {}) : {}),
      };
      let details: VoiceDiagnosticDetails;
      try {
        details = sanitizeDetails(combinedDetails, secrets);
      } catch {
        details = Object.freeze({ sanitizationFailed: true });
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
        ...(eventConnectionId
          ? { connectionId: eventConnectionId }
          : undefined),
        ...(eventChatId ? { chatId: eventChatId } : undefined),
        level: input.level,
        category: input.category,
        name: input.name,
        ...(input.durationMs === undefined
          ? undefined
          : { durationMs: Math.max(0, input.durationMs) }),
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
        ...(connectionId ? { connectionId } : undefined),
        ...(chatId ? { chatId } : undefined),
      });
    },
    isEnabled,
    setChatId(nextChatId) {
      chatId = nextChatId ? redactSecrets(nextChatId, secrets) : undefined;
    },
  };
};
