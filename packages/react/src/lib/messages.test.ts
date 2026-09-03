import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import {
  SocketFailedToParseMessageError,
  SocketUnknownMessageError,
} from './errors';
import {
  type ParsedMessageError,
  type ParsedMessageResult,
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

const getAudioMessage = (result: ParsedMessageResult) => {
  expect(result.success).toBe(true);
  if (!result.success || result.message.type !== 'audio') {
    throw new Error('Expected a parsed audio message.');
  }
  return result.message;
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

    const message = getAudioMessage(result);
    expect(message).toMatchObject({ type: 'audio', data: buffer });
    expect(message.receivedAt).toBeInstanceOf(Date);
  });

  it('parses a Blob as audio', async () => {
    const blob = new Blob([Uint8Array.from([1, 2, 3])]);
    const arrayBuffer = vi.spyOn(blob, 'arrayBuffer');

    const result = await parseMessageData(blob);

    const message = getAudioMessage(result);
    expect(Array.from(new Uint8Array(message.data))).toEqual([1, 2, 3]);
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it('parses a cross-realm ArrayBuffer as audio', async () => {
    const buffer = runInNewContext(
      'Uint8Array.from([1, 2, 3]).buffer',
    ) as ArrayBuffer;
    expect(buffer).not.toBeInstanceOf(ArrayBuffer);

    const result = await parseMessageData(buffer);

    const message = getAudioMessage(result);
    expect(Array.from(new Uint8Array(message.data))).toEqual([1, 2, 3]);
  });

  it('parses a cross-realm Blob as audio', async () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    try {
      const frameWindow = iframe.contentWindow;
      if (frameWindow === null) throw new Error('Expected an iframe window.');
      const { Blob: CrossRealmBlob } = frameWindow as unknown as {
        Blob: typeof Blob;
      };
      const blob = new CrossRealmBlob([Uint8Array.from([1, 2, 3])]);
      expect(blob).not.toBeInstanceOf(Blob);

      const result = await parseMessageData(blob);

      const message = getAudioMessage(result);
      expect(Array.from(new Uint8Array(message.data))).toEqual([1, 2, 3]);
    } finally {
      iframe.remove();
    }
  });

  it('copies only the addressed bytes from an ArrayBuffer view', async () => {
    const buffer = Uint8Array.from([0, 1, 2, 3]).buffer;
    const view = new Uint8Array(buffer, 1, 2);

    const result = await parseMessageData(view);

    const message = getAudioMessage(result);
    expect(Array.from(new Uint8Array(message.data))).toEqual([1, 2]);
  });

  it('reports Blob conversion failures with their cause', async () => {
    const cause = new Error('read failed');
    const blob = new Blob([]);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(cause);

    const result = await parseMessageData(blob);

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error).toBeInstanceOf(SocketFailedToParseMessageError);
      expect(result.error.cause).toBe(cause);
    }
  });

  it('does not reject when unsupported data has hostile accessors', async () => {
    const data = Object.defineProperty({}, 'constructor', {
      get() {
        throw new Error('constructor getter should not run');
      },
    });

    await expect(parseMessageData(data)).resolves.toMatchObject({
      success: false,
      error: { code: 'failed_to_parse_message' },
    });
  });

  it('does not reject when binary identity checks throw', async () => {
    const data = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('prototype lookup failed');
        },
      },
    );

    await expect(parseMessageData(data)).resolves.toMatchObject({
      success: false,
      error: { code: 'failed_to_parse_message' },
    });
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
