import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createVoiceDiagnosticsReporter,
  invokeIsolatedConsumerCallback,
  type VoiceDiagnosticEvent,
  type VoiceDiagnosticValue,
  type VoiceDiagnosticsOptions,
  type VoiceDiagnosticsReporter,
  type VoiceLogger,
} from './diagnostics';

const isDiagnosticObject = (
  value: VoiceDiagnosticValue | undefined,
): value is Readonly<Record<string, VoiceDiagnosticValue>> =>
  value !== undefined &&
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value);

const input = {
  category: 'connection' as const,
  details: { phase: 'socket' },
  level: 'warn' as const,
  name: 'connection.attempt_cancelled' as const,
};

const createLogger = () =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) satisfies VoiceLogger;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('voice diagnostics reporter', () => {
  it('logs warnings and errors to console by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const reporter = createVoiceDiagnosticsReporter(() => undefined);

    reporter.emit({ ...input, level: 'info' });
    reporter.emit(input);

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[Hume Voice][connection] connection.attempt_cancelled',
    );
  });

  it('supports custom loggers, callbacks, and level filtering', () => {
    const logger = createLogger();
    const onEvent = vi.fn();
    const options: VoiceDiagnosticsOptions = {
      level: 'info',
      logger,
      onEvent,
    };
    const reporter = createVoiceDiagnosticsReporter(() => options);

    reporter.emit({ ...input, level: 'debug' });
    reporter.emit({ ...input, level: 'info' });

    expect(onEvent).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('supports callback-only and fully disabled diagnostics', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onEvent = vi.fn();
    let options: false | VoiceDiagnosticsOptions = {
      logger: false,
      onEvent,
    };
    const reporter = createVoiceDiagnosticsReporter(() => options);

    reporter.emit(input);
    options = false;
    reporter.emit(input);

    expect(onEvent).toHaveBeenCalledOnce();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('isolates callback and logger failures', () => {
    const logger = createLogger();
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger failed');
    });
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger,
      onEvent: () => {
        throw new Error('callback failed');
      },
    }));

    expect(() => reporter.emit(input)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('adds immutable correlation, ordering, timestamps, and durations', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      level: 'debug',
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    const connectionId = reporter.beginConnection();
    reporter.setChatId('chat-123');
    reporter.emit({
      ...input,
      durationMs: -1,
      details: { resource: { state: 'connected' }, states: ['connected'] },
    });
    reporter.emit(input);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      sequence: 1,
      connectionId,
      chatId: 'chat-123',
      durationMs: 0,
    });
    expect(events[1]?.sequence).toBe(2);
    expect(events[1]?.instanceId).toBe(events[0]?.instanceId);
    expect(Date.parse(events[0]?.timestamp ?? '')).not.toBeNaN();
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0]?.details)).toBe(true);
    expect(Object.isFrozen(events[0]?.details['resource'])).toBe(true);
    expect(Object.isFrozen(events[0]?.details['states'])).toBe(true);
  });

  it('supports explicit correlation for events emitted after cleanup', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      level: 'debug',
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const originalConnectionId = reporter.beginConnection();
    reporter.setChatId('original-chat');
    const originalCorrelation = reporter.getCorrelation();
    expect(originalCorrelation).toEqual({
      connectionId: originalConnectionId,
      chatId: 'original-chat',
    });
    expect(Object.isFrozen(originalCorrelation)).toBe(true);
    reporter.clearConnection();

    const newConnectionId = reporter.beginConnection();
    reporter.setChatId('new-chat');
    reporter.emit({ ...input, ...originalCorrelation });
    reporter.emit({ ...input, connectionId: newConnectionId });
    reporter.emit({ ...input, connectionId: originalConnectionId });
    reporter.emit({ ...input, connectionId: null });

    expect(events[0]?.connectionId).toBe(originalConnectionId);
    expect(events[0]?.chatId).toBe('original-chat');
    expect(events[1]?.connectionId).toBe(newConnectionId);
    expect(events[1]?.chatId).toBe('new-chat');
    expect(events[2]?.connectionId).toBe(originalConnectionId);
    expect(events[2]?.chatId).toBeUndefined();
    expect(events[3]?.connectionId).toBeUndefined();
    expect(events[3]?.chatId).toBeUndefined();
  });

  it('snapshots correlation for delayed isolated callback failures', async () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const originalConnectionId = reporter.beginConnection();
    reporter.setChatId('original-chat');
    let rejectCallback: ((error: unknown) => void) | undefined;
    const callbackResult = new Promise<void>((_resolve, reject) => {
      rejectCallback = reject;
    });

    invokeIsolatedConsumerCallback(
      reporter,
      'onStopRecording',
      () => callbackResult,
    );
    reporter.clearConnection();
    reporter.beginConnection();
    reporter.setChatId('replacement-chat');
    rejectCallback?.(new Error('consumer callback failed'));
    await callbackResult.catch(() => undefined);
    await Promise.resolve();

    expect(events[0]).toMatchObject({
      connectionId: originalConnectionId,
      chatId: 'original-chat',
      name: 'consumer.callback_failed',
    });
  });

  it('reports a delayed callback failure after diagnostics are enabled', async () => {
    const events: VoiceDiagnosticEvent[] = [];
    let options: false | VoiceDiagnosticsOptions = false;
    const reporter = createVoiceDiagnosticsReporter(() => options);
    const originalConnectionId = reporter.beginConnection();
    reporter.setChatId('original-chat');
    let rejectCallback: ((error: unknown) => void) | undefined;
    const callbackResult = new Promise<void>((_resolve, reject) => {
      rejectCallback = reject;
    });

    invokeIsolatedConsumerCallback(reporter, 'onClose', () => callbackResult);
    reporter.clearConnection();
    reporter.beginConnection();
    options = {
      logger: false,
      onEvent: (event) => events.push(event),
    };
    rejectCallback?.(new Error('consumer callback failed'));
    await callbackResult.catch(() => undefined);
    await Promise.resolve();

    expect(events[0]).toMatchObject({
      connectionId: originalConnectionId,
      chatId: 'original-chat',
      name: 'consumer.callback_failed',
    });
  });

  it('does not report a disabled synchronous callback failure', () => {
    const emit = vi.fn();
    const getCorrelation = vi.fn(() => Object.freeze({}));
    const isEnabled = vi.fn(() => false);
    const reporter: VoiceDiagnosticsReporter = {
      addRedactionValue: vi.fn(),
      beginConnection: vi.fn(() => 'connection'),
      clearConnection: vi.fn(),
      emit,
      getCorrelation,
      isEnabled,
      setChatId: vi.fn(),
    };

    invokeIsolatedConsumerCallback(reporter, 'onClose', () => {
      throw new Error('consumer callback failed');
    });

    expect(isEnabled).toHaveBeenCalledWith('warn');
    expect(getCorrelation).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('redacts secrets and protected fields from default events', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    reporter.beginConnection('secret-token');
    reporter.addRedactionValue('private-device');

    reporter.emit({
      ...input,
      details: {
        message: 'request failed for secret-token',
        auth: { value: 'secret-token' },
        apiKey: 'secret-token',
        data: 'raw-audio',
        deviceId: 'private-device',
        sessionSettings: { systemPrompt: 'private-prompt' },
      },
      sensitiveDetails: {
        content: 'private transcript and secret-token',
        toolResult: 'private tool result',
      },
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('raw-audio');
    expect(serialized).not.toContain('private-device');
    expect(serialized).not.toContain('private-prompt');
    expect(serialized).not.toContain('private transcript');
    expect(serialized).not.toContain('private tool result');
    expect(serialized).toContain('[REDACTED]');
  });

  it('skips diagnostic accessors without invoking them', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const accessor = vi.fn(() => 'unsafe value');
    const nested: Record<string, unknown> = { safe: 'nested value' };
    Object.defineProperty(nested, 'unsafe', {
      enumerable: true,
      get: accessor,
    });
    const values: unknown[] = [];
    Object.defineProperty(values, 0, {
      enumerable: true,
      get: accessor,
    });
    const details: Record<string, unknown> = {
      nested,
      safe: 'top-level value',
      values,
    };
    Object.defineProperty(details, 'unsafe', {
      enumerable: true,
      get: accessor,
    });
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    expect(() => reporter.emit({ ...input, details })).not.toThrow();

    expect(accessor).not.toHaveBeenCalled();
    expect(events[0]?.details).toEqual({
      __humeDiagnosticTruncated: true,
      nested: {
        __humeDiagnosticTruncated: true,
        safe: 'nested value',
      },
      safe: 'top-level value',
      values: [null],
    });
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('marks details incomplete when top-level enumeration fails', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const details = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: () => {
          throw new Error('Failed to enumerate diagnostic details');
        },
      },
    );

    expect(() => reporter.emit({ ...input, details })).not.toThrow();

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details).toEqual({
      __humeDiagnosticTruncated: true,
    });
  });

  it('isolates nested property enumeration failures', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const hostile = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: () => {
          throw new Error('Failed to enumerate nested diagnostic details');
        },
      },
    );

    reporter.emit({
      ...input,
      details: { before: 'preserved', hostile, after: 'also preserved' },
    });

    expect(events[0]?.details).toEqual({
      before: 'preserved',
      hostile: { __humeDiagnosticTruncated: true },
      after: 'also preserved',
    });
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('keeps values whose sanitized object keys collide', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    reporter.beginConnection('secret-token');

    reporter.emit({
      ...input,
      details: {
        'secret-token-key': 'first value',
        '[REDACTED]-key': 'second value',
        __humeDiagnosticTruncated: 'consumer value',
      },
    });

    expect(events[0]?.details).toMatchObject({
      '[REDACTED]-key': 'first value',
      '[REDACTED]-key#2': 'second value',
      '__humeDiagnosticTruncated#2': 'consumer value',
    });
  });

  it('preserves and redacts individual AggregateError failures', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    reporter.beginConnection('secret-token');

    const firstFailure = new Error('First cleanup exposed secret-token');
    const secondFailure = new Error('Second cleanup failed');
    reporter.emit({
      ...input,
      details: {
        error: new AggregateError(
          [firstFailure, secondFailure],
          'Multiple cleanup operations failed for secret-token',
          { cause: firstFailure },
        ),
      },
    });

    expect(events[0]?.details['error']).toMatchObject({
      name: 'AggregateError',
      message: 'Multiple cleanup operations failed for [REDACTED]',
      errors: [
        { message: 'First cleanup exposed [REDACTED]' },
        { message: 'Second cleanup failed' },
      ],
      cause: { message: 'First cleanup exposed [REDACTED]' },
    });
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('preserves failures from a native AggregateError with a custom name', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const aggregate = new AggregateError(
      [new Error('Track cleanup failed')],
      'Microphone cleanup failed',
    );
    aggregate.name = 'MicrophoneCleanupError';

    reporter.emit({ ...input, details: { error: aggregate } });

    expect(events[0]?.details['error']).toMatchObject({
      name: 'MicrophoneCleanupError',
      errors: [{ message: 'Track cleanup failed' }],
    });
  });

  it('preserves positions for unsupported AggregateError failures', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    reporter.emit({
      ...input,
      details: {
        error: new AggregateError(
          [undefined, () => undefined, Symbol('cleanup failure')],
          'Cleanup failed',
        ),
      },
    });

    expect(events[0]?.details['error']).toMatchObject({
      errors: [null, null, null],
    });
  });

  it('preserves repeated AggregateError references outside actual cycles', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const sharedError = new AggregateError(
      [new Error('Track cleanup failed')],
      'Microphone cleanup failed',
    );

    reporter.emit({
      ...input,
      details: { first: sharedError, second: sharedError },
    });

    expect(events[0]?.details['first']).toMatchObject({
      errors: [{ message: 'Track cleanup failed' }],
    });
    expect(events[0]?.details['second']).toMatchObject({
      errors: [{ message: 'Track cleanup failed' }],
    });
  });

  it('preserves lazily exposed native Error stacks', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const error = new Error('Track cleanup failed');

    reporter.emit({ ...input, details: { error } });

    const serializedError = events[0]?.details['error'];
    if (!isDiagnosticObject(serializedError)) {
      throw new Error('Expected serialized error details.');
    }
    expect(serializedError['stack']).toContain('Track cleanup failed');
  });

  it('preserves trusted Error stacks exposed by a prototype accessor', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const error = new Error('Prototype stack failure');
    // oxlint-disable-next-line typescript/unbound-method -- reinstalled as a getter and invoked with the original Error receiver
    const ownStackGetter = Object.getOwnPropertyDescriptor(error, 'stack')?.get;
    // oxlint-disable-next-line typescript/unbound-method -- reinstalled as a getter and invoked with the original Error receiver
    const prototypeStackGetter = Object.getOwnPropertyDescriptor(
      Error.prototype,
      'stack',
    )?.get;
    const getter = ownStackGetter ?? prototypeStackGetter;
    if (getter === undefined) return;
    Reflect.deleteProperty(error, 'stack');
    const prototype = Object.create(Error.prototype) as object;
    Object.defineProperty(prototype, 'stack', {
      configurable: true,
      get: getter,
    });
    Object.setPrototypeOf(error, prototype);

    reporter.emit({ ...input, details: { error } });

    const serializedError = events[0]?.details['error'];
    if (!isDiagnosticObject(serializedError)) {
      throw new Error('Expected serialized error details.');
    }
    expect(serializedError['stack']).toContain('Prototype stack failure');
  });

  it('serializes invalid dates without discarding sibling details', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    reporter.emit({
      ...input,
      details: { before: 'preserved', invalidDate: new Date(Number.NaN) },
    });

    expect(events[0]?.details).toMatchObject({
      before: 'preserved',
      invalidDate: 'Invalid Date',
    });
    expect(events[0]?.detailsTruncated).toBeUndefined();
  });

  it('sanitizes diagnostic objects when AggregateError is unavailable', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    vi.stubGlobal('AggregateError', undefined);

    reporter.emit({
      ...input,
      details: { cleanup: { phase: 'microphone', succeeded: false } },
    });

    expect(events[0]?.details).toEqual({
      cleanup: { phase: 'microphone', succeeded: false },
    });
  });

  it('preserves fallback aggregate failures when AggregateError is unavailable', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const fallbackAggregate = new Error('Multiple cleanup operations failed');
    fallbackAggregate.name = 'AggregateError';
    Object.defineProperty(fallbackAggregate, 'errors', {
      value: [new Error('Track cleanup failed')],
    });
    vi.stubGlobal('AggregateError', undefined);

    reporter.emit({
      ...input,
      details: { error: fallbackAggregate },
    });

    expect(events[0]?.details['error']).toMatchObject({
      name: 'AggregateError',
      message: 'Multiple cleanup operations failed',
      errors: [{ message: 'Track cleanup failed' }],
    });
  });

  it('does not invoke AggregateError errors accessors', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const errorsGetter = vi.fn(() => [new Error('Prototype data')]);
    const inheritedAccessor = new Error('Inherited errors accessor');
    inheritedAccessor.name = 'AggregateError';
    const inheritedPrototype = Object.create(Error.prototype) as object;
    Object.defineProperty(inheritedPrototype, 'errors', { get: errorsGetter });
    Object.setPrototypeOf(inheritedAccessor, inheritedPrototype);
    const ownAccessor = new Error('Own errors accessor');
    ownAccessor.name = 'AggregateError';
    Object.defineProperty(ownAccessor, 'errors', { get: errorsGetter });
    const nativeAccessor = new AggregateError([], 'Native errors accessor');
    Object.defineProperty(nativeAccessor, 'errors', { get: errorsGetter });

    reporter.emit({
      ...input,
      details: { errors: [inheritedAccessor, ownAccessor, nativeAccessor] },
    });

    expect(errorsGetter).not.toHaveBeenCalled();
    const errors = events[0]?.details['errors'];
    expect(Array.isArray(errors)).toBe(true);
    expect(
      (errors as readonly VoiceDiagnosticValue[]).every(
        (error) =>
          error !== null &&
          typeof error === 'object' &&
          !Object.hasOwn(error, 'errors'),
      ),
    ).toBe(true);
  });

  it('preserves nested Error and DOMException causes', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const deviceFailure = new Error('Device disappeared');
    const abortFailure = new DOMException(
      'Cleanup was interrupted',
      'AbortError',
    );
    Object.defineProperty(abortFailure, 'cause', { value: deviceFailure });
    const cleanupFailure = new Error('Microphone cleanup failed', {
      cause: abortFailure,
    });

    reporter.emit({
      ...input,
      details: { error: cleanupFailure },
    });

    expect(events[0]?.details['error']).toMatchObject({
      message: 'Microphone cleanup failed',
      cause: {
        name: 'AbortError',
        message: 'Cleanup was interrupted',
        cause: { message: 'Device disappeared' },
      },
    });
  });

  it('ignores inherited causes without invoking prototype getters', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const inheritedCauseGetter = vi.fn(() => new Error('Prototype data'));
    const addInheritedCause = <ErrorValue extends Error>(
      error: ErrorValue,
      basePrototype: object,
    ) => {
      const prototype = {};
      Object.setPrototypeOf(prototype, basePrototype);
      Object.defineProperty(prototype, 'cause', {
        get: inheritedCauseGetter,
      });
      Object.setPrototypeOf(error, prototype);
      return error;
    };

    reporter.emit({
      ...input,
      details: {
        errors: [
          addInheritedCause(new Error('Standard failure'), Error.prototype),
          addInheritedCause(
            new DOMException('DOM failure', 'AbortError'),
            DOMException.prototype,
          ),
          addInheritedCause(
            new AggregateError([], 'Aggregate failure'),
            AggregateError.prototype,
          ),
        ],
      },
    });

    const errors = events[0]?.details['errors'];
    expect(inheritedCauseGetter).not.toHaveBeenCalled();
    expect(Array.isArray(errors)).toBe(true);
    expect(
      (errors as readonly VoiceDiagnosticValue[]).every(
        (error) =>
          error !== null &&
          typeof error === 'object' &&
          !Object.hasOwn(error, 'cause'),
      ),
    ).toBe(true);
  });

  it('preserves non-enumerable DOMException details', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    reporter.emit({
      ...input,
      details: {
        error: new DOMException('Cleanup was interrupted', 'AbortError'),
      },
    });

    expect(events[0]?.details['error']).toMatchObject({
      name: 'AbortError',
      message: 'Cleanup was interrupted',
    });
  });

  it('does not invoke overridden DOMException accessors', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const accessor = vi.fn(() => {
      throw new Error('DOMException accessor should not run');
    });
    const error = new DOMException('Cleanup was interrupted', 'AbortError');
    for (const key of ['message', 'name', 'stack'] as const) {
      Object.defineProperty(error, key, {
        configurable: true,
        get: accessor,
      });
    }

    reporter.emit({ ...input, details: { error } });

    expect(accessor).not.toHaveBeenCalled();
    expect(events[0]?.details['error']).toMatchObject({
      name: 'AbortError',
      message: 'Cleanup was interrupted',
    });
  });

  it('keeps redaction values after correlation is cleared', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    reporter.beginConnection('secret-token');
    reporter.clearConnection();
    reporter.emit({
      ...input,
      details: { message: 'late failure containing secret-token' },
    });

    expect(events[0]?.connectionId).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('redacts the chat identifier with the same matcher as details', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    reporter.beginConnection('b');
    reporter.addRedactionValue('ab');
    reporter.setChatId('ab');

    reporter.emit({ ...input, details: { chat: 'ab' } });

    // Leftmost-longest matching must not let the shorter, earlier-registered
    // secret split the longer one and expose its prefix.
    expect(reporter.getCorrelation().chatId).toBe('[REDACTED]');
    expect(events[0]?.chatId).toBe('[REDACTED]');
    expect(events[0]?.details['chat']).toBe('[REDACTED]');
  });

  it('keeps a truncated chat identifier within the per-string limit', () => {
    const reporter = createVoiceDiagnosticsReporter(() => false);

    reporter.setChatId('x'.repeat(20_000));

    const chatId = reporter.getCorrelation().chatId;
    expect(chatId).toHaveLength(16_384);
    expect(chatId).toMatch(/\[Truncated\]$/);
  });

  it('includes opted-in content while continuing to redact credentials', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      includeContent: true,
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    reporter.beginConnection('secret-token');

    reporter.emit({
      ...input,
      sensitiveDetails: {
        content: 'hello from the user',
        toolResult: 'result containing secret-token',
      },
    });

    const serialized = JSON.stringify(events);
    expect(serialized).toContain('hello from the user');
    expect(serialized).toContain('result containing [REDACTED]');
    expect(serialized).not.toContain('secret-token');
  });

  it('keeps circular details JSON-safe', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const circular: unknown[] = [];
    circular.push(circular);
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    expect(() =>
      reporter.emit({ ...input, details: { circular } }),
    ).not.toThrow();
    expect(() => JSON.stringify(events)).not.toThrow();
    expect(events[0]?.details['circular']).toEqual(['[Circular]']);
  });

  it('bounds sanitization of deeply shared object graphs', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let shared: Record<string, unknown> = { failure: 'track cleanup failed' };
    for (let depth = 0; depth < 20; depth += 1) {
      shared = { first: shared, second: shared };
    }

    reporter.emit({ ...input, details: { shared } });

    const serialized = JSON.stringify(events[0]?.details);
    expect(events[0]?.detailsTruncated).toBe(true);
    expect(serialized).toContain('"__humeDiagnosticTruncated":true');
    expect(serialized.length).toBeLessThan(100_000);
  });

  it('prioritizes primary errors over earlier oversized siblings', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const primaryError = new Error('Primary cleanup failure');

    reporter.emit({
      ...input,
      details: {
        noise: Array.from({ length: 10_000 }, (_, index) => index),
        error: primaryError,
      },
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['error']).toMatchObject({
      name: 'Error',
      message: 'Primary cleanup failure',
    });
  });

  it('prioritizes nested errors over earlier oversized siblings', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    reporter.emit({
      ...input,
      details: {
        noise: Array.from({ length: 10_000 }, (_, index) => index),
        cleanup: {
          result: {
            error: new Error('Nested cleanup failure'),
          },
        },
      },
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['cleanup']).toMatchObject({
      result: { error: { message: 'Nested cleanup failure' } },
    });
  });

  it('does not let earlier arrays starve later priority discovery', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const details: Record<string, unknown> = {};
    for (let index = 0; index < 16; index += 1) {
      details[`noise-${index}`] = Array.from(
        { length: 1_000 },
        (_, itemIndex) => itemIndex,
      );
    }
    details['lateTarget'] = {
      result: { failure: new Error('Late nested cleanup failure') },
    };

    reporter.emit({ ...input, details });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['lateTarget']).toMatchObject({
      result: { failure: { message: 'Late nested cleanup failure' } },
    });
  });

  it('finds an appended array error beyond the leading discovery sample', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const values: unknown[] = Array.from({ length: 65 }, (_, index) => index);
    values[64] = new Error('Appended cleanup failure');

    reporter.emit({
      ...input,
      details: {
        noise: Array.from({ length: 10_000 }, (_, index) => index),
        values,
      },
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['values']).toMatchObject([
      ...Array.from({ length: 64 }, (_, index) => index),
      { message: 'Appended cleanup failure' },
    ]);
  });

  it('does not let a wide object frontier hide a later nested error', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const details: Record<string, unknown> = {
      noise: Array.from({ length: 10_000 }, (_, index) => index),
    };
    for (let index = 0; index < 256; index += 1) {
      details[`container-${index}`] = { payload: [] };
    }
    details['lateTarget'] = {
      result: { failure: new Error('Late wide-frontier failure') },
    };

    reporter.emit({ ...input, details });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['lateTarget']).toMatchObject({
      result: { failure: { message: 'Late wide-frontier failure' } },
    });
  });

  it('discovers nested errors beneath a priority key', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    reporter.emit({
      ...input,
      details: {
        error: {
          noise: Array.from({ length: 10_000 }, (_, index) => index),
          result: {
            failure: new Error('Nested primary failure'),
          },
        },
      },
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['error']).toMatchObject({
      result: { failure: { message: 'Nested primary failure' } },
    });
  });

  it('does not let repeated references starve later priority discovery', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const shared = {};
    const details: Record<string, unknown> = {};
    for (let index = 0; index < 999; index += 1) {
      details[`shared-${index}`] = shared;
    }
    details['lateTarget'] = { failure: new Error('Late cleanup failure') };

    reporter.emit({ ...input, details });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['lateTarget']).toMatchObject({
      failure: { message: 'Late cleanup failure' },
    });
  });

  it('prioritizes the first path to a shared object without expanding aliases', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const shared = {
      noise: Array.from({ length: 10_000 }, (_, index) => index),
      failure: new Error('Shared cleanup failure'),
    };

    reporter.emit({
      ...input,
      details: { first: shared, second: shared },
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['first']).toMatchObject({
      failure: { message: 'Shared cleanup failure' },
    });
  });

  it('reuses discovery enumeration during sanitization', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let enumerations = 0;
    const nested = new Proxy(
      { failure: new Error('Cleanup failure') },
      {
        ownKeys(target) {
          enumerations += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    reporter.emit({ ...input, details: { nested } });

    expect(events[0]?.details['nested']).toMatchObject({
      failure: { message: 'Cleanup failure' },
    });
    expect(enumerations).toBe(1);
  });

  it('keeps a trailing discovered failure after the front scan is exhausted', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const nested: Record<string, unknown> = Object.fromEntries(
      Array.from(
        { length: 1_001 },
        (_, index) => [`noise-${index}`, index] as const,
      ),
    );
    nested['failure'] = new Error('Trailing cleanup failure');

    reporter.emit({ ...input, details: { nested } });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['nested']).toMatchObject({
      failure: { message: 'Trailing cleanup failure' },
    });
  });

  it('keeps a trailing discovered array failure after the entry budget is exhausted', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const values: unknown[] = Array.from(
      { length: 1_001 },
      (_, index) => index,
    );
    values[1_000] = new Error('Trailing array failure');

    reporter.emit({ ...input, details: { values } });

    const sanitizedValues = events[0]?.details['values'];
    if (!Array.isArray(sanitizedValues)) {
      throw new Error('Expected diagnostic array.');
    }
    expect(events[0]?.detailsTruncated).toBe(true);
    expect(sanitizedValues).toHaveLength(1_000);
    expect(sanitizedValues.at(-2)).toEqual({
      __humeDiagnosticTruncated: true,
    });
    expect(sanitizedValues.at(-1)).toMatchObject({
      message: 'Trailing array failure',
    });
  });

  it('reserves discovery work before merging exhausts its scan budget', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const noise = Array.from({ length: 1_000 }, (_, index) => index);
    const container = { failure: new Error('Reserved discovery failure') };
    const hiddenKeys = Array.from(
      { length: 16_000 },
      (_, index) => `hidden-${index}`,
    );
    const details = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: () => ['noise', 'container', ...hiddenKeys],
        getOwnPropertyDescriptor(_target, key) {
          if (key === 'noise') {
            return {
              configurable: true,
              enumerable: true,
              value: noise,
              writable: true,
            };
          }
          if (key === 'container') {
            return {
              configurable: true,
              enumerable: true,
              value: container,
              writable: true,
            };
          }
          if (typeof key === 'string' && key.startsWith('hidden-')) {
            return {
              configurable: true,
              enumerable: false,
              value: null,
              writable: true,
            };
          }
          return undefined;
        },
      },
    );

    reporter.emit({ ...input, details });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['container']).toMatchObject({
      failure: { message: 'Reserved discovery failure' },
    });
  });

  it('preserves priority-sensitive details after ordinary merge work is exhausted', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      includeContent: true,
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const hiddenKeys = Array.from(
      { length: 16_000 },
      (_, index) => `hidden-${index}`,
    );
    const details = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: () => hiddenKeys,
        getOwnPropertyDescriptor() {
          return {
            configurable: true,
            enumerable: false,
            value: null,
            writable: true,
          };
        },
      },
    );

    reporter.emit({
      ...input,
      details,
      sensitiveDetails: { error: new Error('Preserved sensitive failure') },
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['error']).toMatchObject({
      message: 'Preserved sensitive failure',
    });
  });

  it('bounds priority discovery work across repeated object references', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let descriptorReads = 0;
    const probe = new Proxy(
      Object.fromEntries(
        Array.from({ length: 128 }, (_, index) => [`value-${index}`, index]),
      ),
      {
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const details = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`entry-${index}`, probe]),
    );

    reporter.emit({ ...input, details });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(descriptorReads).toBeLessThan(20_000);
  });

  it('bounds fixed priority probes and ordinary key scans across an event', () => {
    const reporter = createVoiceDiagnosticsReporter(() => ({ logger: false }));
    const priorityKeys = new Set(['error', 'errors', 'failures', 'cause']);
    let priorityProbeReads = 0;
    // With the root, scan consumer, and noise array, this frontier fills the
    // 1,000-node discovery allowance.
    const targets = Array.from(
      { length: 997 },
      () => ({}) as Record<string, unknown>,
    );
    const frontier = targets.map(
      (target) =>
        new Proxy(target, {
          getOwnPropertyDescriptor(target, key) {
            if (typeof key === 'string' && priorityKeys.has(key)) {
              priorityProbeReads += 1;
            }
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        }),
    );
    for (const [index, target] of targets.entries()) {
      for (let offset = 1; offset <= 4; offset += 1) {
        const child = frontier[index * 4 + offset];
        if (child === undefined) break;
        target[`child-${offset}`] = child;
      }
    }

    const hiddenKeys = Array.from(
      { length: 16_000 },
      (_, index) => `hidden-${index}`,
    );
    let hiddenKeyReads = 0;
    const scanConsumer = new Proxy(
      {},
      {
        ownKeys: () => hiddenKeys,
        getOwnPropertyDescriptor(_target, key) {
          if (typeof key === 'string' && key.startsWith('hidden-')) {
            hiddenKeyReads += 1;
            return {
              configurable: true,
              enumerable: false,
              value: null,
              writable: true,
            };
          }
          return undefined;
        },
      },
    );

    reporter.emit({
      ...input,
      details: {
        scanConsumer,
        // Spend the entry allowance before sanitization reaches the frontier,
        // leaving its counted priority probes exclusive to discovery.
        noise: Array.from({ length: 1_000 }),
        frontier: frontier[0],
      },
    });

    expect(priorityProbeReads + hiddenKeyReads).toBeLessThanOrEqual(16_000);
  });

  it('keeps AggregateError errors array-shaped when its budget is exhausted', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const aggregate = new AggregateError(
      Array.from({ length: 1_000 }, () => ({})),
      'Aggregate cleanup failure',
    );

    reporter.emit({
      ...input,
      details: { aggregate },
    });

    const serializedAggregate: unknown = events[0]?.details['aggregate'];
    expect(events[0]?.detailsTruncated).toBe(true);
    expect(serializedAggregate).toMatchObject({
      name: 'AggregateError',
    });
    const serializedErrors =
      serializedAggregate !== null &&
      typeof serializedAggregate === 'object' &&
      !Array.isArray(serializedAggregate)
        ? (serializedAggregate as Record<string, unknown>)['errors']
        : undefined;
    expect(Array.isArray(serializedErrors)).toBe(true);
    expect((serializedErrors as unknown[]).at(-1)).toEqual({
      __humeDiagnosticTruncated: true,
    });
  });

  it('prioritizes a trailing AggregateError before its parent array exhausts the object budget', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const aggregate = new AggregateError(
      [new Error('Nested cleanup failure')],
      'Aggregate cleanup failure',
    );

    reporter.emit({
      ...input,
      details: {
        values: [...Array.from({ length: 997 }, () => ({})), aggregate],
      },
    });

    const values = events[0]?.details['values'];
    if (!Array.isArray(values)) throw new Error('Expected diagnostic array.');
    expect(events[0]?.detailsTruncated).toBe(true);
    expect(values.at(-1)).toMatchObject({
      name: 'AggregateError',
      errors: [{ message: 'Nested cleanup failure' }],
    });
  });

  it('redacts terminal buffers without consuming recursive object budget', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    reporter.emit({
      ...input,
      details: {
        values: [
          ...Array.from({ length: 998 }, () => new ArrayBuffer(1)),
          new Error('Cleanup failure after buffers'),
        ],
      },
    });

    const values = events[0]?.details['values'];
    if (!Array.isArray(values)) throw new Error('Expected diagnostic array.');
    expect(events[0]?.detailsTruncated).toBeUndefined();
    expect(values.at(-1)).toMatchObject({
      message: 'Cleanup failure after buffers',
    });
  });

  it('bounds arrays and objects containing primitive entries', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const primitiveEntries = Array.from(
      { length: 10_000 },
      (_, index) => index,
    );

    reporter.emit({
      ...input,
      details: { values: primitiveEntries },
    });
    reporter.emit({
      ...input,
      details: {
        values: Object.fromEntries(
          primitiveEntries.map((value) => [`entry-${value}`, value]),
        ),
      },
    });

    for (const event of events) {
      const serialized = JSON.stringify(event.details);
      expect(event.detailsTruncated).toBe(true);
      expect(serialized).toContain('"__humeDiagnosticTruncated":true');
      expect(serialized.length).toBeLessThan(100_000);
    }
    const arrayValues = events[0]?.details['values'];
    const objectValues = events[1]?.details['values'];
    if (
      !Array.isArray(arrayValues) ||
      objectValues === null ||
      Array.isArray(objectValues) ||
      typeof objectValues !== 'object'
    ) {
      throw new Error('Expected bounded array and object diagnostic values.');
    }
    expect(arrayValues.length).toBeLessThanOrEqual(1_000);
    expect(Object.keys(objectValues).length).toBeLessThanOrEqual(1_000);
  });

  it('does not count inherited properties against the own-key limit', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const prototype = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, index) => [
        `inherited-${index}`,
        index,
      ]),
    );
    const nested = Object.assign(Object.create(prototype) as object, {
      own: 'preserved',
    });

    reporter.emit({ ...input, details: { nested } });

    expect(events[0]?.detailsTruncated).toBeUndefined();
    expect(events[0]?.details['nested']).toEqual({ own: 'preserved' });
  });

  it('does not count non-enumerable own properties against the own-key limit', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const nested: Record<string, unknown> = {};
    for (let index = 0; index < 10_001; index += 1) {
      Object.defineProperty(nested, `hidden-${index}`, { value: index });
    }
    nested['own'] = 'preserved';

    reporter.emit({ ...input, details: { nested } });

    expect(events[0]?.detailsTruncated).toBeUndefined();
    expect(events[0]?.details['nested']).toEqual({ own: 'preserved' });
  });

  it('bounds descriptor checks for proxies with many non-enumerable keys', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const reportedKeyCount = 25_000;
    const reportedKeys = Array.from(
      { length: reportedKeyCount },
      (_, index) => `hidden-${index}`,
    );
    let descriptorReads = 0;
    const nested = new Proxy(
      {},
      {
        ownKeys: () => reportedKeys,
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          if (typeof key === 'string' && key.startsWith('hidden-')) {
            return { configurable: true, enumerable: false, value: 1 };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details: { nested } });

    expect(descriptorReads).toBeGreaterThan(0);
    expect(descriptorReads).toBeLessThan(reportedKeyCount);
    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['nested']).toEqual({
      __humeDiagnosticTruncated: true,
    });
  });

  it('bounds own-key and priority scans across every object in one emit', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const reportedKeys = Array.from(
      { length: 16_000 },
      (_, index) => `hidden-${index}`,
    );
    let descriptorReads = 0;
    const createNested = (ownKeys: () => string[]) =>
      new Proxy(
        {},
        {
          ownKeys,
          getOwnPropertyDescriptor(_target, key) {
            if (typeof key === 'string' && key.startsWith('hidden-')) {
              descriptorReads += 1;
            }
            return { configurable: true, enumerable: false, value: 1 };
          },
        },
      );
    const firstOwnKeys = vi.fn(() => reportedKeys);
    const secondOwnKeys = vi.fn(() => reportedKeys);

    reporter.emit({
      ...input,
      details: {
        first: createNested(firstOwnKeys),
        second: createNested(secondOwnKeys),
      },
    });

    expect(firstOwnKeys).toHaveBeenCalledTimes(2);
    expect(secondOwnKeys).toHaveBeenCalledOnce();
    expect(descriptorReads).toBeLessThanOrEqual(16_000);
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('preserves merged keys after the source exhausts the scan budget', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const hiddenKeys = Array.from(
      { length: 15_995 },
      (_, index) => `hidden-${index}`,
    );
    const details = new Proxy(
      {},
      {
        ownKeys: () => [...hiddenKeys, 'kept', 'after-limit'],
        getOwnPropertyDescriptor(_target, key) {
          return key === 'kept'
            ? { configurable: true, enumerable: true, value: 'safe' }
            : { configurable: true, enumerable: false, value: null };
        },
      },
    );

    reporter.emit({ ...input, details });

    expect(events[0]?.details).toEqual({
      __humeDiagnosticTruncated: true,
      kept: 'safe',
    });
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('bounds symbol-key work across discovery and sanitization', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const trailingKey = 'after-symbol-limit';
    const reportedKeys: (string | symbol)[] = [
      ...Array.from({ length: 16_000 }, (_, index) => Symbol(index)),
      trailingKey,
    ];
    const descriptorReads: PropertyKey[] = [];
    const nested = new Proxy(
      {},
      {
        ownKeys: () => reportedKeys,
        getOwnPropertyDescriptor(target, key) {
          descriptorReads.push(key);
          if (key === trailingKey) {
            return { configurable: true, enumerable: true, value: 'omitted' };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details: { nested } });

    expect(descriptorReads).toContain(trailingKey);
    expect(descriptorReads.length).toBeLessThanOrEqual(16_000);
    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['nested']).toEqual({
      __humeDiagnosticTruncated: true,
    });
  });

  it('does not enumerate terminal Date and binary values during discovery', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const dateOwnKeys = vi.fn(() => Reflect.ownKeys(new Date(0)));
    const binaryOwnKeys = vi.fn(() => Reflect.ownKeys(new ArrayBuffer(8)));
    const date = new Proxy(new Date(0), { ownKeys: dateOwnKeys });
    const binary = new Proxy(new ArrayBuffer(8), { ownKeys: binaryOwnKeys });

    reporter.emit({
      ...input,
      details: { binary, date, when: new Date(0) },
    });

    expect(dateOwnKeys).not.toHaveBeenCalled();
    expect(binaryOwnKeys).not.toHaveBeenCalled();
    expect(events[0]?.details).toMatchObject({
      binary: '[REDACTED]',
      date: 'Invalid Date',
      when: '1970-01-01T00:00:00.000Z',
    });
  });

  it('does not enumerate array keys during discovery', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const ownKeys = vi.fn((target: object) => Reflect.ownKeys(target));
    const values = new Proxy([1, 2, new Error('Inside array')], { ownKeys });

    reporter.emit({ ...input, details: { values } });

    expect(ownKeys).not.toHaveBeenCalled();
    expect(events[0]?.detailsTruncated).toBeUndefined();
    expect(events[0]?.details['values']).toMatchObject([
      1,
      2,
      { message: 'Inside array' },
    ]);
  });

  it('bounds array index descriptor checks across one emit', () => {
    const reporter = createVoiceDiagnosticsReporter(() => ({ logger: false }));
    const details: Record<string, unknown> = {};
    let indexDescriptorReads = 0;
    for (let outer = 0; outer < 127; outer += 1) {
      details[`array-${outer}`] = new Proxy(Array.from({ length: 1_000 }), {
        getOwnPropertyDescriptor(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            indexDescriptorReads += 1;
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    }

    reporter.emit({ ...input, details });

    // Discovery spends at most its reserved 8,000-key budget. Sanitization can
    // inspect at most another 1,000 entries under its separate output budget.
    expect(indexDescriptorReads).toBeLessThanOrEqual(9_000);
  });

  it('keeps enumerating after an own key disappears', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let unstableDescriptorReads = 0;
    const nested = new Proxy(
      { first: 1, unstable: 2, later: 3 },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'unstable') {
            unstableDescriptorReads += 1;
            if (unstableDescriptorReads === 2) return undefined;
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details: { nested } });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['nested']).toMatchObject({
      __humeDiagnosticTruncated: true,
      first: 1,
      later: 3,
    });
  });

  it('marks details incomplete when a top-level key disappears during merge', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let unstableDescriptorReads = 0;
    const details = new Proxy(
      { first: 1, unstable: 2, later: 3 },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'unstable') {
            unstableDescriptorReads += 1;
            if (unstableDescriptorReads === 2) return undefined;
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details).toEqual({
      __humeDiagnosticTruncated: true,
      first: 1,
      later: 3,
    });
  });

  it('keeps a priority key that appears after its initial merge probe', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let errorDescriptorReads = 0;
    const details = new Proxy(
      { error: 'appeared during enumeration' },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'error' && ++errorDescriptorReads === 1) return undefined;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details });

    expect(events[0]?.details).toEqual({
      error: 'appeared during enumeration',
    });
    expect(events[0]?.detailsTruncated).toBeUndefined();
  });

  it('retries a priority key after its initial merge probe throws', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let errorDescriptorReads = 0;
    const details = new Proxy(
      { error: 'recovered after throw' },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'error' && ++errorDescriptorReads === 1) {
            throw new Error('priority descriptor unavailable');
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details });

    expect(events[0]?.details).toEqual({
      __humeDiagnosticTruncated: true,
      error: 'recovered after throw',
    });
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('retries a priority key after an initial accessor descriptor', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let errorDescriptorReads = 0;
    const details = new Proxy(
      { error: 'recovered after accessor' },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'error' && ++errorDescriptorReads === 1) {
            return { configurable: true, enumerable: true, get: () => 'skip' };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details });

    expect(events[0]?.details).toEqual({
      __humeDiagnosticTruncated: true,
      error: 'recovered after accessor',
    });
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('marks a vanished snapshotted priority key incomplete', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let errorDescriptorReads = 0;
    const nested = new Proxy(
      { error: 'present only during enumeration' },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'error') {
            errorDescriptorReads += 1;
            if (errorDescriptorReads !== 2) return undefined;
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details: { nested } });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['nested']).toEqual({
      __humeDiagnosticTruncated: true,
    });
  });

  it('retries a nested priority key after a descriptor check throws', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let errorDescriptorReads = 0;
    const nested = new Proxy(
      { error: 'recovered during sanitization' },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'error' && ++errorDescriptorReads === 3) {
            throw new Error('priority descriptor temporarily unavailable');
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details: { nested } });

    expect(events[0]?.details['nested']).toEqual({
      __humeDiagnosticTruncated: true,
      error: 'recovered during sanitization',
    });
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('keeps top-level siblings when a descriptor check throws during enumeration', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const details = new Proxy(
      { first: 1, unstable: 2, later: 3 },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'unstable') {
            throw new Error('own-property check failed');
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details).toEqual({
      __humeDiagnosticTruncated: true,
      first: 1,
      later: 3,
    });
  });

  it('marks a disappeared own key incomplete when its prototype shadows it', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const target = Object.assign(
      Object.create({ unstable: 'inherited' }) as Record<string, unknown>,
      { first: 1, unstable: 2, later: 3 },
    );
    let unstableDescriptorReads = 0;
    const nested = new Proxy(target, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'unstable') {
          unstableDescriptorReads += 1;
          if (unstableDescriptorReads === 2) {
            Reflect.deleteProperty(target, key);
            return undefined;
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    reporter.emit({ ...input, details: { nested } });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['nested']).toEqual({
      __humeDiagnosticTruncated: true,
      first: 1,
      later: 3,
    });
  });

  it('keeps enumerating after an own-property check throws', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    let unstableDescriptorReads = 0;
    const nested = new Proxy(
      { first: 1, unstable: 2, later: 3 },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'unstable') {
            unstableDescriptorReads += 1;
            if (unstableDescriptorReads === 2) {
              throw new Error('own-property check failed');
            }
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    reporter.emit({ ...input, details: { nested } });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['nested']).toMatchObject({
      __humeDiagnosticTruncated: true,
      first: 1,
      later: 3,
    });
  });

  it('bounds individual diagnostic strings after redaction', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    reporter.beginConnection('secret-token');
    const oversizedKey = `secret-token:${'k'.repeat(20_000)}`;

    reporter.emit({
      ...input,
      details: {
        [oversizedKey]: 'value',
        message: `secret-token:${'x'.repeat(20_000)}`,
      },
    });

    const message = events[0]?.details['message'];
    expect(typeof message).toBe('string');
    expect(message).not.toContain('secret-token');
    expect(message).toHaveLength(16_384);
    expect(message).toMatch(/\[Truncated\]$/);
    expect(events[0]?.detailsTruncated).toBe(true);
    const sanitizedKey = Object.keys(events[0]?.details ?? {}).find(
      (key) => key !== 'message',
    );
    expect(sanitizedKey).not.toContain('secret-token');
    expect(sanitizedKey).toHaveLength(16_384);
    expect(sanitizedKey).toMatch(/\[Truncated\]$/);
  });

  it('keeps a fully redacted value that fits the output limit', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const secret = 's'.repeat(128);
    reporter.beginConnection(secret);

    reporter.emit({
      ...input,
      details: {
        message: `${'x'.repeat(8_000)}${secret.repeat(700)}unbounded-tail`,
      },
    });

    const message = events[0]?.details['message'];
    expect(message).toContain('unbounded-tail');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('[Truncated]');
    expect(events[0]?.detailsTruncated).toBeUndefined();
  });

  it('keeps a redaction that crosses the plain-output cutoff', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const secret = 'private-token-value';
    const cutoffPrefix = 'x'.repeat(16_384 - '[Truncated]'.length - 4);
    const oversizedValue = `${cutoffPrefix}${secret}tail`;
    reporter.beginConnection(secret);

    reporter.emit({
      ...input,
      details: { [oversizedValue]: 'value', message: oversizedValue },
    });

    const message = events[0]?.details['message'];
    const sanitizedKey = Object.keys(events[0]?.details ?? {}).find(
      (key) => key !== 'message',
    );
    expect(message).not.toContain(secret.slice(0, 4));
    expect(message).toMatch(/\[REDACTED\]tail$/);
    expect(sanitizedKey).not.toContain(secret.slice(0, 4));
    expect(sanitizedKey).toMatch(/\[REDACTED\]tail$/);
    expect(events[0]?.detailsTruncated).toBeUndefined();
  });

  it('bounds total redaction work for highly compressible strings', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const secret = 's'.repeat(1_024);
    reporter.beginConnection(secret);

    reporter.emit({
      ...input,
      details: { message: `${secret.repeat(300)}bounded-tail` },
    });

    const message = events[0]?.details['message'];
    expect(message).not.toContain(secret);
    expect(message).not.toContain('bounded-tail');
    expect(message).toMatch(/\[Truncated\]$/);
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('truncates when a registered secret exceeds the redaction-work budget', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const oversizedSecret = 's'.repeat(300_000);
    reporter.beginConnection(oversizedSecret);

    reporter.emit({
      ...input,
      details: { message: oversizedSecret },
    });

    expect(events[0]?.details['message']).toBe('[Truncated]');
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('does not charge unexamined source after redacted output fills', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    reporter.beginConnection('x');

    reporter.emit({
      ...input,
      details: {
        message: 'x'.repeat(300_000),
        later: 'preserved after bounded redaction',
      },
    });

    expect(events[0]?.details['message']).toMatch(/\[Truncated\]$/);
    expect(events[0]?.details['later']).toBe(
      'preserved after bounded redaction',
    );
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('does not inspect a candidate after literal output fills', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const oversizedSecret = 's'.repeat(300_000);
    const outputThenSecret = `${'x'.repeat(16_384)}${oversizedSecret}`;
    reporter.beginConnection(oversizedSecret);

    reporter.emit({
      ...input,
      details: {
        one: outputThenSecret,
        two: outputThenSecret,
        three: outputThenSecret,
        four: outputThenSecret,
        status: 'preserved',
      },
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['status']).toBe('preserved');
  });

  it('keeps later properties when one string exhausts its redaction work', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const secret = 's'.repeat(1_024);
    reporter.beginConnection(secret);

    reporter.emit({
      ...input,
      details: {
        message: secret.repeat(300),
        laterOne: 'kept',
        laterTwo: 'kept',
      },
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details['message']).not.toContain(secret);
    expect(events[0]?.details['message']).toMatch(/\[Truncated\]$/);
    expect(events[0]?.details).toMatchObject({
      laterOne: 'kept',
      laterTwo: 'kept',
    });
  });

  it('skips names it cannot redact once total redaction work is exhausted', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const secret = 's'.repeat(1_024);
    const dense = secret.repeat(300);
    reporter.beginConnection(secret);

    reporter.emit({
      ...input,
      details: {
        one: dense,
        two: dense,
        three: dense,
        four: dense,
        status: 'omitted',
        later: 'kept',
      },
    });

    const details = events[0]?.details ?? {};
    expect(events[0]?.detailsTruncated).toBe(true);
    expect(details).toMatchObject({
      __humeDiagnosticTruncated: true,
      later: 'kept',
    });
    expect(Object.hasOwn(details, 'status')).toBe(false);
    expect(
      Object.keys(details).filter((key) => key.includes('[Truncated]')),
    ).toEqual([]);
    expect(JSON.stringify(details)).not.toContain(secret);
  });

  it('keeps later properties after an oversized key when no secrets are registered', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));

    reporter.emit({
      ...input,
      details: { ['k'.repeat(20_000)]: 1, later: 'kept' },
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    const oversizedKey = Object.keys(events[0]?.details ?? {}).find((key) =>
      key.startsWith('k'),
    );
    expect(oversizedKey).toHaveLength(16_384);
    expect(oversizedKey).toMatch(/\[Truncated\]$/);
    expect(events[0]?.details['later']).toBe('kept');
  });

  it('does not let ordinary text exhaust the redaction budget', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    // A JWT-style token starts with the most common English letter, so every
    // `e` in ordinary prose is a candidate that must be compared and rejected.
    reporter.beginConnection('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig');
    const prose = 'the quick brown fox jumps over the lazy dog '
      .repeat(400)
      .slice(0, 16_384);
    const details: Record<string, unknown> = {};
    for (let index = 0; index < 14; index += 1) {
      details[`chunk-${index}`] = prose;
    }
    details['code'] = 1006;
    details['wasClean'] = false;
    details['reason'] = 'abnormal closure';

    reporter.emit({ ...input, details });

    expect(events[0]?.detailsTruncated).toBeUndefined();
    expect(events[0]?.details).toMatchObject({
      'chunk-13': prose,
      code: 1006,
      wasClean: false,
      reason: 'abnormal closure',
    });
  });

  it('bounds candidate-start lookup with many distinct secret prefixes', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const firstCodeUnits = Array.from({ length: 16_384 }, (_, index) =>
      String.fromCharCode(0x1000 + index),
    );
    for (const firstCodeUnit of firstCodeUnits) {
      reporter.addRedactionValue(`${firstCodeUnit}\uffff`);
    }
    const message = firstCodeUnits.join('');

    reporter.emit({ ...input, details: { message } });

    expect(events[0]?.detailsTruncated).toBeUndefined();
    expect(events[0]?.details['message']).toBe(message);
  });

  it('bounds aggregate diagnostic string content', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const longValue = 'x'.repeat(16_384);

    reporter.emit({
      ...input,
      details: Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [
          `entry-${index}`,
          longValue,
        ]),
      ),
    });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(JSON.stringify(events[0]?.details).length).toBeLessThan(350_000);
  });

  it('stops before exhausted string budget erases later property names', () => {
    const events: VoiceDiagnosticEvent[] = [];
    const reporter = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const details: Record<string, unknown> = {};
    for (let index = 0; index < 8; index += 1) {
      details[String(index).padEnd(16_384, 'k')] = 'v'.repeat(16_384);
    }
    details['later'] = 'must not lose its name';

    reporter.emit({ ...input, details });

    expect(events[0]?.detailsTruncated).toBe(true);
    expect(events[0]?.details).toMatchObject({
      __humeDiagnosticTruncated: true,
    });
    expect(Object.hasOwn(events[0]?.details ?? {}, '')).toBe(false);
    expect(Object.hasOwn(events[0]?.details ?? {}, '#2')).toBe(false);
    expect(Object.hasOwn(events[0]?.details ?? {}, 'later')).toBe(false);
  });
});
