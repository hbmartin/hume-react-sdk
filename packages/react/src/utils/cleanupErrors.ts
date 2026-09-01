import { getBrowserErrorMessage } from './browserErrors';

type CleanupErrorOptions = {
  cause?: unknown;
};

/** Append leaf failures while avoiding nested AggregateError wrappers. */
export const appendCleanupFailures = (
  failures: unknown[],
  error: unknown,
): void => {
  const aggregateAncestors = new WeakSet<AggregateError>();

  const appendFailure = (failure: unknown): void => {
    if (
      !(failure instanceof AggregateError) ||
      failure.errors.length === 0 ||
      aggregateAncestors.has(failure)
    ) {
      failures.push(failure);
      return;
    }

    aggregateAncestors.add(failure);
    try {
      for (const nestedFailure of failure.errors as unknown[]) {
        appendFailure(nestedFailure);
      }
    } finally {
      aggregateAncestors.delete(failure);
    }
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
  return new AggregateError([...failures], `${summary} ${details}`, {
    cause: 'cause' in options ? options.cause : failures[0],
  });
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
