import { type Hume } from 'hume';
import * as HumeSerialization from 'hume/serialization';

import { type AudioMessage, parseAudioMessage } from './audio-message';
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

/**
 * The result of parsing a message off the socket: either the decoded message,
 * or the error explaining why it could not be decoded.
 */
export type ParsedMessageResult =
  | {
      success: true;
      message: Hume.empathicVoice.SubscribeEvent | AudioMessage;
    }
  | {
      success: false;
      error: Error;
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
  if (data instanceof Blob) {
    const message = await parseAudioMessage(data);

    if (message) {
      return {
        success: true,
        message,
      };
    } else {
      return {
        success: false,
        error: new SocketFailedToParseMessageError(
          `Received blob was unable to be converted to ArrayBuffer.`,
        ),
      };
    }
  }

  if (typeof data !== 'string') {
    return {
      success: false,
      error: new SocketFailedToParseMessageError(
        `Expected a string but received ${typeof data}.`,
      ),
    };
  }

  let serializedEvent: unknown;
  try {
    serializedEvent = JSON.parse(data);
  } catch {
    return {
      success: false,
      error: new SocketUnknownMessageError(
        `Received JSON was not a known message type.`,
      ),
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
