import { describe, expect, it } from 'vitest';

import {
  AudioDeviceSwitchError,
  ConcurrentConnectAuthError,
  isAudioDeviceSwitchError,
  isConcurrentConnectAuthError,
  isSocketFailedToParseMessageError,
  isSocketUnknownMessageError,
  SocketFailedToParseMessageError,
  SocketUnknownMessageError,
} from './errors';

describe('socket message errors', () => {
  it('appends an optional detail and preserves a cause', () => {
    const cause = new Error('source failure');
    const error = new SocketFailedToParseMessageError('More detail.', {
      cause,
    });

    expect(error.message).toBe(
      'Failed to parse message from socket. More detail.',
    );
    expect(error.code).toBe('failed_to_parse_message');
    expect(error.cause).toBe(cause);
  });

  it('recognizes unknown-message errors from another package copy', () => {
    const error = Object.assign(new Error('Unknown message type.'), {
      code: 'unknown_message_type',
      name: 'SocketUnknownMessageError',
    });

    expect(error).not.toBeInstanceOf(SocketUnknownMessageError);
    expect(isSocketUnknownMessageError(error)).toBe(true);
    expect(isSocketFailedToParseMessageError(error)).toBe(false);
  });

  it('recognizes parse errors from another package copy', () => {
    const error = Object.assign(
      new Error('Failed to parse message from socket.'),
      {
        code: 'failed_to_parse_message',
        name: 'SocketFailedToParseMessageError',
      },
    );

    expect(error).not.toBeInstanceOf(SocketFailedToParseMessageError);
    expect(isSocketFailedToParseMessageError(error)).toBe(true);
    expect(isSocketUnknownMessageError(error)).toBe(false);
  });
});

describe('public error guards', () => {
  it.each([
    {
      code: 'audio_device_switch',
      guard: isAudioDeviceSwitchError,
      name: 'AudioDeviceSwitchError',
      ownConstructor: AudioDeviceSwitchError,
      properties: {
        cause: undefined,
        kind: 'audioinput',
        reason: 'permission_denied',
      },
    },
    {
      code: 'concurrent_connect_auth',
      guard: isConcurrentConnectAuthError,
      name: 'ConcurrentConnectAuthError',
      ownConstructor: ConcurrentConnectAuthError,
      properties: { reason: 'auth_conflict' },
    },
  ])('recognizes $name from another package copy', (identity) => {
    const error = Object.assign(new Error(identity.name), {
      code: identity.code,
      name: identity.name,
      ...identity.properties,
    });

    expect(error).not.toBeInstanceOf(identity.ownConstructor);
    expect(identity.guard(error)).toBe(true);
  });
});
