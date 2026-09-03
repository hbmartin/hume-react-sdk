import { describe, expect, it, vi } from 'vitest';

import {
  SocketFailedToParseMessageError,
  SocketUnknownMessageError,
} from './errors';
import {
  type ParsedMessageError,
  parseMessageData,
  parseMessageType,
} from './messages';

const classifyParseError = (error: ParsedMessageError): string => {
  switch (error.code) {
    case 'failed_to_parse_message':
      return 'parse';
    case 'unknown_message_type':
      return 'unknown';
    default: {
      const exhaustiveError: never = error;
      return exhaustiveError;
    }
  }
};

describe('parseMessageData', () => {
  it('parses a valid serialized subscribe event', async () => {
    await expect(
      parseMessageData(JSON.stringify({ type: 'assistant_end' })),
    ).resolves.toEqual({
      success: true,
      message: { type: 'assistant_end' },
    });
  });

  it('rejects an unknown serialized event type', async () => {
    const result = await parseMessageData(
      JSON.stringify({ type: 'not_a_subscribe_event' }),
    );

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error).toBeInstanceOf(SocketUnknownMessageError);
      expect(result.error.code).toBe('unknown_message_type');
      expect(classifyParseError(result.error)).toBe('unknown');
    }
  });

  it('reports malformed JSON as a parse failure with its cause', async () => {
    const result = await parseMessageData('{');

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error).toBeInstanceOf(SocketFailedToParseMessageError);
      expect(result.error.code).toBe('failed_to_parse_message');
      expect(result.error.cause).toBeInstanceOf(SyntaxError);
      expect(classifyParseError(result.error)).toBe('parse');
    }
  });

  it('describes unsupported non-string data precisely', async () => {
    const result = await parseMessageData(null);

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error).toBeInstanceOf(SocketFailedToParseMessageError);
      expect(result.error.message).toContain('received null');
    }
  });

  it('parses an ArrayBuffer as audio', async () => {
    const buffer = Uint8Array.from([1, 2, 3]).buffer;

    const result = await parseMessageData(buffer);

    expect(result.success).toBe(true);
    if (result.success && result.message.type === 'audio') {
      expect(result.message).toMatchObject({ type: 'audio', data: buffer });
      expect(result.message.receivedAt).toBeInstanceOf(Date);
    }
  });

  it('parses a Blob as audio', async () => {
    const buffer = Uint8Array.from([1, 2, 3]).buffer;
    const arrayBuffer = vi.fn().mockResolvedValue(buffer);
    const blob = Object.assign(Object.create(Blob.prototype) as Blob, {
      arrayBuffer,
    });

    const result = await parseMessageData(blob);

    expect(result.success).toBe(true);
    if (result.success && result.message.type === 'audio') {
      expect(result.message.data).toBe(buffer);
    }
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it('copies only the addressed bytes from an ArrayBuffer view', async () => {
    const buffer = Uint8Array.from([0, 1, 2, 3]).buffer;
    const view = new Uint8Array(buffer, 1, 2);

    const result = await parseMessageData(view);

    expect(result.success).toBe(true);
    if (result.success && result.message.type === 'audio') {
      expect(Array.from(new Uint8Array(result.message.data))).toEqual([1, 2]);
    }
  });

  it('reports Blob conversion failures with their cause', async () => {
    const cause = new Error('read failed');
    const blob = Object.assign(Object.create(Blob.prototype) as Blob, {
      arrayBuffer: vi.fn().mockRejectedValue(cause),
    });

    const result = await parseMessageData(blob);

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error).toBeInstanceOf(SocketFailedToParseMessageError);
      expect(result.error.cause).toBe(cause);
    }
  });
});

describe('parseMessageType', () => {
  it('parses the data from a MessageEvent', async () => {
    const event = new MessageEvent('message', {
      data: JSON.stringify({ type: 'assistant_end' }),
    });

    await expect(parseMessageType(event)).resolves.toEqual({
      success: true,
      message: { type: 'assistant_end' },
    });
  });
});
