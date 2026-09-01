import { getBrowserErrorMessage } from './browserErrors';

/** Append leaf failures while avoiding nested AggregateError wrappers. */
export const appendCleanupFailures = (
  failures: unknown[],
  error: unknown,
): void => {
  if (error instanceof AggregateError && error.errors.length > 0) {
    failures.push(...(error.errors as unknown[]));
  } else {
    failures.push(error);
  }
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
): unknown => {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];

  const details = failures
    .map(
      (failure, index) => `[${index + 1}] ${describeCleanupFailure(failure)}`,
    )
    .join('; ');
  return new AggregateError([...failures], `${summary} ${details}`, {
    cause: failures[0],
  });
};

/** Throw collected cleanup failures after every cleanup attempt has run. */
export const throwCleanupFailures = (
  failures: readonly unknown[],
  summary: string,
): void => {
  const error = createCleanupError(failures, summary);
  if (error !== undefined) throw error;
};
