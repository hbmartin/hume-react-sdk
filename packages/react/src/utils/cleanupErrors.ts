import { getBrowserErrorMessage } from './browserErrors';

type CleanupErrorOptions = {
  /** Cause attached when multiple failures require an aggregate wrapper. */
  cause?: unknown;
};

const MAX_CLEANUP_FAILURE_NODES = 1_000;
const CLEANUP_FAILURES_TRUNCATED_MESSAGE =
  'Cleanup failure traversal was truncated.';

class FallbackAggregateError extends Error {
  readonly errors: readonly unknown[];

  constructor(errors: readonly unknown[], message: string, cause: unknown) {
    super(message);
    this.name = 'AggregateError';
    this.errors = errors;
    Object.defineProperty(this, 'cause', {
      configurable: true,
      value: cause,
      writable: true,
    });
  }
}

const getAggregateFailures = (failure: unknown): readonly unknown[] | null => {
  if (
    typeof AggregateError !== 'undefined' &&
    failure instanceof AggregateError
  ) {
    return failure.errors as unknown[];
  }
  return failure instanceof FallbackAggregateError ? failure.errors : null;
};

/** Append leaf failures while avoiding nested AggregateError wrappers. */
export const appendCleanupFailures = (
  failures: unknown[],
  error: unknown,
): void => {
  const aggregateAncestors = new WeakSet<object>();
  let visitedNodes = 0;
  let reportedTruncation = false;

  const appendFailure = (failure: unknown): boolean => {
    if (visitedNodes === MAX_CLEANUP_FAILURE_NODES) {
      if (!reportedTruncation) {
        failures.push(new Error(CLEANUP_FAILURES_TRUNCATED_MESSAGE));
        reportedTruncation = true;
      }
      return false;
    }
    visitedNodes += 1;
    const nestedFailures = getAggregateFailures(failure);
    if (
      nestedFailures === null ||
      nestedFailures.length === 0 ||
      (typeof failure === 'object' &&
        failure !== null &&
        aggregateAncestors.has(failure))
    ) {
      failures.push(failure);
      return true;
    }

    // Native and fallback aggregate failures are both objects here.
    if (typeof failure !== 'object' || failure === null) return true;
    aggregateAncestors.add(failure);
    try {
      for (const nestedFailure of nestedFailures) {
        if (!appendFailure(nestedFailure)) return false;
      }
    } finally {
      aggregateAncestors.delete(failure);
    }
    return true;
  };

  appendFailure(error);
};

const describeCleanupFailure = (failure: unknown): string => {
  const browserMessage = getBrowserErrorMessage(failure);
  if (browserMessage !== null) return browserMessage;
  if (typeof failure === 'string' && failure.trim() !== '') return failure;
  return 'Unknown error';
};

/** Preserve a single failure's identity or combine multiple failures verbosely. */
export const createCleanupError = (
  failures: readonly unknown[],
  summary: string,
  options: CleanupErrorOptions = {},
): unknown => {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];

  const details = failures
    .map(
      (failure, index) => `[${index + 1}] ${describeCleanupFailure(failure)}`,
    )
    .join('; ');
  const cause = 'cause' in options ? options.cause : failures[0];
  const message = `${summary} ${details}`;
  return typeof AggregateError === 'undefined'
    ? new FallbackAggregateError([...failures], message, cause)
    : new AggregateError([...failures], message, { cause });
};

/** Throw collected cleanup failures after every cleanup attempt has run. */
export const throwCleanupFailures = (
  failures: readonly unknown[],
  summary: string,
  options: CleanupErrorOptions = {},
): void => {
  if (failures.length === 0) return;
  throw createCleanupError(failures, summary, options);
};
