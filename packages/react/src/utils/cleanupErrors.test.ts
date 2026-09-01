import { describe, expect, it, vi } from 'vitest';

import {
  appendCleanupFailures,
  createCleanupError,
  throwCleanupFailures,
} from './cleanupErrors';

describe('cleanup error helpers', () => {
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

  it('flattens aggregate-shaped failures across constructor boundaries', () => {
    const failure = new Error('Track failed');
    const aggregate = Object.create({ name: 'AggregateError' }) as object;
    Object.defineProperty(aggregate, 'errors', { value: [failure] });
    const flattened: unknown[] = [];

    appendCleanupFailures(flattened, aggregate);

    expect(flattened).toEqual([failure]);
  });

  it('does not invoke aggregate-shaped errors accessors', () => {
    const errorsGetter = vi.fn(() => [new Error('Prototype data')]);
    const aggregate = Object.create({ name: 'AggregateError' }) as object;
    Object.defineProperty(aggregate, 'errors', { get: errorsGetter });
    const failures: unknown[] = [];

    appendCleanupFailures(failures, aggregate);

    expect(errorsGetter).not.toHaveBeenCalled();
    expect(failures).toEqual([aggregate]);
  });

  it('expands each aggregate object once in deeply shared graphs', () => {
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

    expect(failures).toEqual([leaf]);
  });

  it('bounds distinct failures and retains the first omitted failure as cause', () => {
    const nestedFailures = Array.from(
      { length: 1_100 },
      (_, index) => new Error(`Track ${index + 1} failed`),
    );
    const failures: unknown[] = [];

    appendCleanupFailures(
      failures,
      new AggregateError(nestedFailures, 'All tracks failed'),
    );

    expect(failures).toHaveLength(1_000);
    expect(failures.at(-1)).toMatchObject({
      message: 'Cleanup failure traversal was truncated after 1000 nodes.',
      cause: nestedFailures[999],
    });
  });
});
