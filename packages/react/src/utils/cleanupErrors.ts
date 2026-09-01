import { getAggregateErrorDetails } from './aggregateErrors';
import { getBrowserErrorMessage } from './browserErrors';

type CleanupErrorOptions = {
  /** Cause attached when failures require a contextual aggregate wrapper. */
  cause?: unknown;
};

const MAX_CLEANUP_FAILURE_NODES = 1_000;
const CLEANUP_FAILURES_TRUNCATED_MESSAGE = `Cleanup failure traversal was truncated after ${MAX_CLEANUP_FAILURE_NODES} nodes.`;

/** Append leaf failures while avoiding nested AggregateError wrappers. */
export const appendCleanupFailures = (
  failures: unknown[],
  error: unknown,
): void => {
  const aggregateAncestors = new WeakSet<object>();
  const expandedAggregates = new WeakSet<object>();
  let visitedNodes = 0;
  let reportedTruncation = false;

  const appendFailure = (failure: unknown): boolean => {
    if (visitedNodes === MAX_CLEANUP_FAILURE_NODES) {
      if (!reportedTruncation) {
        failures.push(
          new Error(CLEANUP_FAILURES_TRUNCATED_MESSAGE, { cause: failure }),
        );
        reportedTruncation = true;
      }
      return false;
    }
    visitedNodes += 1;
    const aggregate = getAggregateErrorDetails(failure);
    if (aggregate === null || aggregate.failures.length === 0) {
      failures.push(failure);
      return true;
    }
    if (aggregateAncestors.has(aggregate.error)) {
      failures.push(failure);
      return true;
    }
    if (expandedAggregates.has(aggregate.error)) return true;

    expandedAggregates.add(aggregate.error);
    aggregateAncestors.add(aggregate.error);
    try {
      for (const nestedFailure of aggregate.failures) {
        if (!appendFailure(nestedFailure)) return false;
      }
    } finally {
      aggregateAncestors.delete(aggregate.error);
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
  if (failures.length === 1 && !('cause' in options)) return failures[0];

  const details = failures
    .map(
      (failure, index) => `[${index + 1}] ${describeCleanupFailure(failure)}`,
    )
    .join('; ');
  const cause = 'cause' in options ? options.cause : failures[0];
  const message = `${summary} ${details}`;
  return new AggregateError([...failures], message, { cause });
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
