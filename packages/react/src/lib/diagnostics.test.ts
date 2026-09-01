import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createVoiceDiagnosticsReporter,
  type VoiceDiagnosticEvent,
  type VoiceDiagnosticsOptions,
  type VoiceLogger,
} from './diagnostics';

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
});
