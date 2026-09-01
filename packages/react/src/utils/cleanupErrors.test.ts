import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendCleanupFailures,
  createCleanupError,
  throwCleanupFailures,
} from './cleanupErrors';

describe('cleanup error helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the identity of one failure', () => {
    const failure = new Error('Track failed');

    expect(createCleanupError([failure], 'Cleanup failed.')).toBe(failure);
    expect(() => throwCleanupFailures([failure], 'Cleanup failed.')).toThrow(
      failure,
    );
  });

  it('includes every failure in an aggregate message and errors array', () => {
    const firstFailure = new Error('First track failed');
    const secondFailure = new Error('Second track failed');
    const error = createCleanupError(
      [firstFailure, secondFailure],
      'Two tracks failed.',
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      firstFailure,
      secondFailure,
    ]);
    expect((error as AggregateError).message).toBe(
      'Two tracks failed. [1] First track failed; [2] Second track failed',
    );
    expect((error as AggregateError).cause).toBe(firstFailure);
  });

  it('preserves an explicit cause when reporting flattened failures', () => {
    const firstFailure = new Error('First track failed');
    const secondFailure = new Error('Second track failed');
    const firstAttempt = new AggregateError(
      [firstFailure],
      'First cleanup attempt failed',
    );
    const error = createCleanupError(
      [firstFailure, secondFailure],
      'Cleanup failed after retry.',
      { cause: firstAttempt },
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).cause).toBe(firstAttempt);
  });

  it('does not drop a thrown undefined failure', () => {
    let caught = false;

    try {
      throwCleanupFailures([undefined], 'Cleanup failed.');
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }

    expect(caught).toBe(true);
  });

  it('flattens aggregate failures for later cleanup reporting', () => {
    const failures: unknown[] = [];
    const firstFailure = new Error('First track failed');
    const secondFailure = new Error('Second track failed');

    appendCleanupFailures(
      failures,
      new AggregateError([firstFailure, secondFailure], 'Tracks failed'),
    );

    expect(failures).toEqual([firstFailure, secondFailure]);
  });

  it('recursively flattens nested aggregate failures to their leaves', () => {
    const failures: unknown[] = [];
    const firstFailure = new Error('First track failed');
    const secondFailure = new Error('Second track failed');
    const emptyFailure = new AggregateError(
      [],
      'Cleanup failed without details',
    );
    const deeplyNestedFailure = new AggregateError(
      [secondFailure, emptyFailure],
      'Deep cleanup failed',
    );
    const nestedFailure = new AggregateError(
      [firstFailure, deeplyNestedFailure],
      'Nested cleanup failed',
    );

    appendCleanupFailures(
      failures,
      new AggregateError([nestedFailure], 'Outer cleanup failed'),
    );

    expect(failures).toEqual([firstFailure, secondFailure, emptyFailure]);
  });

  it('retains a cyclic aggregate instead of recursing forever', () => {
    const failures: unknown[] = [];
    const failure = new AggregateError([], 'Cyclic cleanup failure');
    failure.errors.push(failure);

    appendCleanupFailures(failures, failure);

    expect(failures).toEqual([failure]);
  });

  it('retains an empty AggregateError instead of dropping a thrown failure', () => {
    const failures: unknown[] = [];
    const failure = new AggregateError([], 'Cleanup failed without details');

    appendCleanupFailures(failures, failure);

    expect(failures).toEqual([failure]);
  });

  it('combines and flattens failures when AggregateError is unavailable', () => {
    const firstFailure = new Error('First track failed');
    const secondFailure = new Error('Second track failed');
    vi.stubGlobal('AggregateError', undefined);

    const error = createCleanupError(
      [firstFailure, secondFailure],
      'Two tracks failed.',
    ) as Error & { cause: unknown; errors: readonly unknown[] };
    const flattened: unknown[] = [];
    appendCleanupFailures(flattened, error);

    expect(error).toMatchObject({
      name: 'AggregateError',
      cause: firstFailure,
      errors: [firstFailure, secondFailure],
    });
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).toBe('{}');
    expect(Object.hasOwn(error, 'name')).toBe(false);
    expect(Object.getOwnPropertyDescriptor(error, 'errors')).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: true,
    });
    expect(flattened).toEqual([firstFailure, secondFailure]);
  });

  it('bounds flattening of deeply shared aggregate graphs', () => {
    const leaf = new Error('Track cleanup failed');
    let shared = new AggregateError([leaf], 'Initial cleanup failed');
    for (let depth = 0; depth < 20; depth += 1) {
      shared = new AggregateError(
        [shared, shared],
        `Cleanup layer ${depth + 1} failed`,
      );
    }
    const failures: unknown[] = [];

    appendCleanupFailures(failures, shared);

    expect(failures.length).toBeLessThan(1_000);
    expect(failures.at(-1)).toMatchObject({
      message: 'Cleanup failure traversal was truncated.',
    });
  });
});
