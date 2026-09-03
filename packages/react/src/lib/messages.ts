import { type Hume } from 'hume';
import * as HumeSerialization from 'hume/serialization';

import {
  isBinaryMessageData,
  type ParsedAudioMessage,
  parseAudioMessage,
} from './audio-message';
import {
  SocketFailedToParseMessageError,
  SocketUnknownMessageError,
} from './errors';

type SubscribeEventParseResult =
  | { ok: true; value: Hume.empathicVoice.SubscribeEvent }
  | { ok: false };

type SubscribeEventParser = {
  parse: (value: unknown) => SubscribeEventParseResult;
};

// TypeScript 7 currently resolves the `hume/serialization` namespace through
// the SDK's API declaration namespace. Keep the compatibility cast isolated at
// this boundary while retaining the SDK's runtime parser and a typed result.
const subscribeEventParser = (
  HumeSerialization.empathicVoice as unknown as {
    SubscribeEvent: SubscribeEventParser;
  }
).SubscribeEvent;

/** A failure returned while decoding data from a socket message. */
export type ParsedMessageError =
  | SocketFailedToParseMessageError
  | SocketUnknownMessageError;

/**
 * The result of parsing a message off the socket: either the decoded message,
 * or the error explaining why it could not be decoded.
 */
export type ParsedMessageResult =
  | {
      success: true;
      message: Hume.empathicVoice.SubscribeEvent | ParsedAudioMessage;
    }
  | {
      success: false;
      error: ParsedMessageError;
    };

const describeMessageData = (data: unknown): string => {
  if (data === null) {
    return 'null';
  }

  if (typeof data === 'object') {
    const constructorName = (data as { constructor?: { name?: unknown } })
      .constructor?.name;
    if (typeof constructorName === 'string' && constructorName !== '') {
      return constructorName;
    }
  }

  return typeof data;
};

/**
 * Parse the data of a message from the socket.
 * @param data - The data to parse.
 * @returns
 * The parsed message data.
 * @example
 * ```ts
 * const message = await parseMessageData(data);
 * ```
 */
export const parseMessageData = async (
  data: unknown,
): Promise<ParsedMessageResult> => {
  if (isBinaryMessageData(data)) {
    try {
      const message = await parseAudioMessage(data);
      return {
        success: true,
        message,
      };
    } catch (cause) {
      return {
        success: false,
        error: new SocketFailedToParseMessageError(
          `Received ${describeMessageData(data)} was unable to be converted to an ArrayBuffer.`,
          { cause },
        ),
      };
    }
  }

  if (typeof data !== 'string') {
    return {
      success: false,
      error: new SocketFailedToParseMessageError(
        `Expected a string or binary data but received ${describeMessageData(data)}.`,
      ),
    };
  }

  let serializedEvent: unknown;
  try {
    serializedEvent = JSON.parse(data);
  } catch (cause) {
    return {
      success: false,
      error: new SocketFailedToParseMessageError(`Received malformed JSON.`, {
        cause,
      }),
    };
  }

  const parseResponse = subscribeEventParser.parse(serializedEvent);

  if (!parseResponse.ok) {
    return {
      success: false,
      error: new SocketUnknownMessageError(
        `Received JSON was not a known message type.`,
      ),
    };
  }

  return {
    success: true,
    message: parseResponse.value,
  };
};

/**
 * Parse the type of a message from the socket.
 * @param event - The event to parse.
 * @returns
 * The parsed message type.
 * @example
 * ```ts
 * const message = await parseMessageType(event);
 * ```
 */
export const parseMessageType = async (
  event: MessageEvent,
): Promise<ParsedMessageResult> => {
  const data: unknown = event.data;
  return parseMessageData(data);
};
