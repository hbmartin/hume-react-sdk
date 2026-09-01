import { describe, expect, it } from 'vitest';

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

  it('retains an empty AggregateError instead of dropping a thrown failure', () => {
    const failures: unknown[] = [];
    const failure = new AggregateError([], 'Cleanup failed without details');

    appendCleanupFailures(failures, failure);

    expect(failures).toEqual([failure]);
  });
});
