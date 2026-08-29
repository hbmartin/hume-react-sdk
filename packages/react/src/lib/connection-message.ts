import type { Hume } from 'hume';

/** The close event emitted by the underlying chat socket. */
export type CloseEvent = Parameters<
  NonNullable<Hume.empathicVoice.chat.ChatSocket.EventHandlers['close']>
>[0];

/**
 * A local record of a connection lifecycle event.
 *
 * These are interleaved with EVI's own messages in `messages` so a transcript
 * can show when the call opened, closed, or changed session settings. They are
 * produced by the SDK and never received over the socket.
 */
export type ConnectionMessage =
  | {
      type: 'socket_connected';
      receivedAt: Date;
    }
  | {
      type: 'socket_disconnected';
      code: CloseEvent['code'];
      reason: CloseEvent['reason'];
      receivedAt: Date;
    }
  | {
      type: 'session_settings';
      sessionSettings: Hume.empathicVoice.SessionSettings;
      receivedAt: Date;
    };
