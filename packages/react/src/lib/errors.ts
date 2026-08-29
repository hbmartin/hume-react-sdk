import type { AudioDeviceKind } from '../models/connect-options';

/** Why an audio device switch failed. */
export type AudioDeviceSwitchErrorReason =
  | 'not_connected'
  | 'unsupported'
  | 'permission_denied'
  | 'device_not_found'
  | 'switch_failed'
  | 'interrupted';

/**
 * A live microphone or speaker switch failed.
 *
 * The call and the previously working device are left intact, so a failed
 * switch never interrupts an active conversation.
 */
export class AudioDeviceSwitchError extends Error {
  /** Whether the failing device was a microphone or a speaker. */
  readonly kind: AudioDeviceKind;

  /** Why the switch failed. */
  readonly reason: AudioDeviceSwitchErrorReason;

  /** The underlying browser error, when one caused the failure. */
  override readonly cause: unknown;

  constructor(
    kind: AudioDeviceKind,
    reason: AudioDeviceSwitchErrorReason,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'AudioDeviceSwitchError';
    this.kind = kind;
    this.reason = reason;
    this.cause = cause;
  }
}

/** Check whether an unknown value is an audio device switch error. */
export const isAudioDeviceSwitchError = (
  error: unknown,
): error is AudioDeviceSwitchError => error instanceof AudioDeviceSwitchError;

/** @internal */
export type ConnectionGenerationErrorReason =
  | 'invalid'
  | 'not_strictly_increasing';

/** @internal */
export class ConnectionGenerationError extends Error {
  readonly reason: ConnectionGenerationErrorReason;

  readonly connectionGeneration: number;

  constructor(
    connectionGeneration: number,
    reason: ConnectionGenerationErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionGenerationError';
    this.connectionGeneration = connectionGeneration;
    this.reason = reason;
  }
}

/** Check whether an unknown value is a connection-generation validation error. */
/** @internal */
export const isConnectionGenerationError = (
  error: unknown,
): error is ConnectionGenerationError =>
  error instanceof ConnectionGenerationError;

/**
 * A concurrent connection request supplied credentials that differ from the
 * active attempt. The request is rejected so refreshed credentials are never
 * silently discarded.
 */
export class ConcurrentConnectAuthError extends Error {
  /** Always `'auth_conflict'`, for parity with the other error classes. */
  readonly reason = 'auth_conflict' as const;

  constructor() {
    super(
      'A voice connection attempt is already in progress with different authentication credentials.',
    );
    this.name = 'ConcurrentConnectAuthError';
  }
}

/** Check whether an unknown value is a concurrent-connect auth conflict. */
export const isConcurrentConnectAuthError = (
  error: unknown,
): error is ConcurrentConnectAuthError =>
  error instanceof ConcurrentConnectAuthError;

/** A socket message did not match any known EVI message type. */
export class SocketUnknownMessageError extends Error {
  constructor(message?: string) {
    super(
      `Unknown message type.${message !== undefined && message !== '' ? ' ' + message : ''}`,
    );
    this.name = 'SocketUnknownMessageError';
  }
}

/**
 * Check if an error is a SocketUnknownMessageError.
 * @param err - The error to check.
 * @returns
 * `true` if the error is a SocketUnknownMessageError.
 * @example
 * ```ts
 * if (isSocketUnknownMessageError(err)) {
 * console.error('Unknown message type');
 * }
 * ```
 */
export const isSocketUnknownMessageError = (
  err: unknown,
): err is SocketUnknownMessageError => {
  return err instanceof SocketUnknownMessageError;
};

/** A socket message could not be parsed as EVI JSON or audio. */
export class SocketFailedToParseMessageError extends Error {
  constructor(message?: string) {
    super(
      `Failed to parse message from socket.${message !== undefined && message !== '' ? ' ' + message : ''}`,
    );
    this.name = 'SocketFailedToParseMessageError';
  }
}

/**
 * Check if an error is a SocketFailedToParseMessageError.
 * @param err - The error to check.
 * @returns
 * `true` if the error is a SocketFailedToParseMessageError.
 * @example
 * ```ts
 * if (isSocketFailedToParseMessageError(err)) {
 * console.error('Failed to parse message from socket');
 * }
 * ```
 */
export const isSocketFailedToParseMessageError = (
  err: unknown,
): err is SocketFailedToParseMessageError => {
  return err instanceof SocketFailedToParseMessageError;
};
