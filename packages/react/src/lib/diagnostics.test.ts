import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createVoiceDiagnosticsReporter,
  invokeIsolatedConsumerCallback,
  type VoiceDiagnosticEvent,
  type VoiceDiagnosticValue,
  type VoiceDiagnosticsOptions,
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

  it('keeps AggregateError errors array-shaped when its budget is exhausted', () => {
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
    const serializedAggregate: unknown = values.at(-1);
    expect(events[0]?.detailsTruncated).toBe(true);
    expect(serializedAggregate).toMatchObject({
      name: 'AggregateError',
      errors: [{ __humeDiagnosticTruncated: true }],
    });
    const serializedErrors =
      serializedAggregate !== null &&
      typeof serializedAggregate === 'object' &&
      !Array.isArray(serializedAggregate)
        ? (serializedAggregate as Record<string, unknown>)['errors']
        : undefined;
    expect(Array.isArray(serializedErrors)).toBe(true);
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
      Array.from({ length: 2_000 }, (_, index) => [
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

  it('bounds source processing before repeated redactions shrink the output', () => {
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
    expect(message).not.toContain('unbounded-tail');
    expect(message).toMatch(/\[Truncated\]$/);
    expect(events[0]?.detailsTruncated).toBe(true);
  });

  it('redacts a secret that crosses the bounded source cutoff', () => {
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
    expect(message).toMatch(/\[Truncated\]$/);
    expect(sanitizedKey).not.toContain(secret.slice(0, 4));
    expect(sanitizedKey).toMatch(/\[Truncated\]$/);
    expect(events[0]?.detailsTruncated).toBe(true);
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
