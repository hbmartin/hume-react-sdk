import { Hume, HumeClient } from 'hume';
import { useCallback, useMemo, useRef, useState } from 'react';
import { type Simplify } from 'type-fest';

import { type AuthStrategy, getAuthStrategyError } from './auth';
import { useLatestRef } from './useLatestRef';
import type {
  AudioOutputMessage,
  JSONMessage,
  ToolCall,
} from '../models/messages';

const isNever = (_n: never) => {
  return;
};

export type SocketConfig = {
  auth: AuthStrategy;
  hostname?: string;
} & Hume.empathicVoice.chat.Chat.ConnectArgs;

/**
 * The close event emitted by the underlying chat socket. Derived from the
 * SDK's own handler type so it stays correct across `hume` upgrades.
 */
export type SocketCloseEvent = Parameters<
  NonNullable<Hume.empathicVoice.chat.ChatSocket.EventHandlers['close']>
>[0];

export enum VoiceReadyState {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  OPEN = 'open',
  CLOSED = 'closed',
}
type SessionSettingsOnConnect = Omit<
  Hume.empathicVoice.SessionSettings,
  'builtinTools' | 'tools' | 'metadata' | 'type'
>;
export type SessionSettingsUpdate = Omit<
  Hume.empathicVoice.SessionSettings,
  'type'
>;

type ActiveConnection = {
  consumerInitiated: boolean;
  socket: Hume.empathicVoice.chat.ChatSocket;
};
/**
 * Extracts session settings that can be sent as query params when the websocket connects.
 * Matches ConnectSessionSettings in the TypeScript SDK (systemPrompt, voiceId, context, etc. are supported).
 *
 * `tools`, `builtinTools`, and `metadata` are not yet supported in the connect query string.
 */
const getSessionSettingsOnConnect = (
  sessionSettings?: Hume.empathicVoice.SessionSettings,
): SessionSettingsOnConnect | undefined => {
  if (!sessionSettings) {
    return undefined;
  }

  const { builtinTools, tools, metadata, type, ...onConnect } = sessionSettings;
  return onConnect;
};

export type ToolCallHandler = (
  // message will always be a tool call message where toolType === 'function'
  message: Simplify<
    ToolCall & {
      // caveat: this doesn't actually do what it appears to, since ToolType is
      // exported as both an interface and a value, this ends up being a constant
      // that doesn't share an type identity with the actual ToolType enum
      toolType: typeof Hume.empathicVoice.ToolType.Function;
    }
  >,
  send: {
    success: (content: unknown) => Hume.empathicVoice.ToolResponseMessage;
    error: (e: {
      error: string;
      code: string;
      level: string;
      content: string;
    }) => Hume.empathicVoice.ToolErrorMessage;
  },
) => Promise<
  Hume.empathicVoice.ToolResponseMessage | Hume.empathicVoice.ToolErrorMessage
>;

export const useVoiceClient = (props: {
  onAudioMessage?: (message: AudioOutputMessage) => void;
  onMessage?: (message: JSONMessage) => void;
  onSessionSettings?: (
    sessionSettings: Hume.empathicVoice.SessionSettings,
  ) => void;
  onToolCall?: ToolCallHandler;
  onToolCallError?: (message: string, error?: Error) => void;
  onClientError?: (message: string, error?: Error) => void;
  onOpen?: () => void;
  onClose?: (
    event: SocketCloseEvent,
    consumerInitiated: boolean,
  ) => void | Promise<void>;
}) => {
  const connectAbortController = useRef<AbortController | null>(null);
  const activeConnection = useRef<ActiveConnection | null>(null);
  const client = useRef<Hume.empathicVoice.chat.ChatSocket | null>(null);

  const [readyState, setReadyState] = useState<VoiceReadyState>(
    VoiceReadyState.IDLE,
  );

  const onAudioMessage = useLatestRef(props.onAudioMessage);
  const onMessage = useLatestRef(props.onMessage);
  const onSessionSettings = useLatestRef(props.onSessionSettings);
  const onToolCall = useLatestRef(props.onToolCall);
  const onClientError = useLatestRef(props.onClientError);
  const onToolCallError = useLatestRef(props.onToolCallError);
  const onOpen = useLatestRef(props.onOpen);
  const onClose = useLatestRef(props.onClose);

  const connect = useCallback(
    (
      config: SocketConfig,
      sessionSettings?: Hume.empathicVoice.SessionSettings,
    ) => {
      // Abort previous attempt if any
      connectAbortController.current?.abort();

      const controller = new AbortController();
      const signal = controller.signal;
      connectAbortController.current = controller;

      const connectSettings = getSessionSettingsOnConnect(sessionSettings);

      return new Promise<VoiceReadyState>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('Connection attempt has already been aborted'));
          return;
        }

        // Fail fast on unusable credentials instead of letting the server
        // reject the socket with an opaque close event.
        const authError = getAuthStrategyError(config.auth);
        if (authError !== null) {
          const error = new Error(authError);
          onClientError.current?.(authError, error);
          reject(error);
          return;
        }

        const hostname = config.hostname || 'api.hume.ai';

        const hume = new HumeClient(
          config.auth.type === 'apiKey'
            ? {
                apiKey: config.auth.value,
                environment: hostname,
              }
            : {
                accessToken: config.auth.value,
                environment: hostname,
              },
        );

        const socket = hume.empathicVoice.chat.connect({
          ...config,
          reconnectAttempts: 0,
          ...(connectSettings && { sessionSettings: connectSettings }),
        });

        client.current = socket;
        const connection: ActiveConnection = {
          consumerInitiated: false,
          socket,
        };
        activeConnection.current = connection;

        const abortHandler = () => {
          connection.consumerInitiated = true;
          socket.close();
          reject(new Error('Connection attempt has been aborted'));
        };

        signal.addEventListener('abort', abortHandler);

        socket.on('message', (message) => {
          if (signal.aborted) {
            return;
          }

          if (message.type === 'audio_output') {
            const messageWithReceivedAt = {
              ...message,
              receivedAt: new Date(),
            };
            onAudioMessage.current?.(messageWithReceivedAt);
            return;
          }

          if (message.type === 'chat_metadata') {
            onOpen.current?.();
            setReadyState(VoiceReadyState.OPEN);
            signal.removeEventListener('abort', abortHandler);
            resolve(VoiceReadyState.OPEN);
          }

          if (
            message.type === 'assistant_message' ||
            message.type === 'user_message' ||
            message.type === 'user_interruption' ||
            message.type === 'error' ||
            message.type === 'tool_response' ||
            message.type === 'tool_error' ||
            message.type === 'chat_metadata' ||
            message.type === 'assistant_end' ||
            message.type === 'assistant_prosody'
          ) {
            const messageWithReceivedAt = {
              ...message,
              receivedAt: new Date(),
            };
            onMessage.current?.(messageWithReceivedAt);
            return;
          }

          if (message.type === 'tool_call') {
            const messageWithReceivedAt = {
              ...message,
              receivedAt: new Date(),
            };
            onMessage.current?.(messageWithReceivedAt);

            // only pass tool call messages for user defined tools
            if (message.toolType === Hume.empathicVoice.ToolType.Function) {
              const handler = onToolCall.current;
              if (handler) {
                void Promise.resolve()
                  .then(() =>
                    handler(
                      {
                        ...messageWithReceivedAt,
                        // we have to do this because even though we are using the correct
                        // enum on line 30 for the type definition
                        // fern exports an interface and a value using the same `ToolType`
                        // identifier so the type comparisons will always fail
                        toolType: 'function',
                      },
                      {
                        success: (content: unknown) => ({
                          type: 'tool_response',
                          toolCallId: messageWithReceivedAt.toolCallId,
                          content: JSON.stringify(content),
                        }),
                        error: ({
                          error,
                          code,
                          level,
                          content,
                        }: {
                          error: string;
                          code: string;
                          level: string;
                          content: string;
                        }) => ({
                          type: 'tool_error',
                          toolCallId: messageWithReceivedAt.toolCallId,
                          error,
                          code,
                          level: level !== null ? 'warn' : undefined, // level can only be warn
                          content,
                        }),
                      },
                    ),
                  )
                  .then((response) => {
                    try {
                      if (response.type === 'tool_response') {
                        socket.sendToolResponseMessage(response);
                      } else if (response.type === 'tool_error') {
                        socket.sendToolErrorMessage(response);
                      } else {
                        onToolCallError.current?.(
                          'Invalid response from tool call',
                        );
                        return;
                      }
                    } catch (error) {
                      const normalizedError =
                        error instanceof Error
                          ? error
                          : new Error(String(error));
                      onToolCallError.current?.(
                        'Failed to send tool response',
                        normalizedError,
                      );
                      return;
                    }
                    onMessage.current?.({
                      ...response,
                      receivedAt: new Date(),
                    });
                  })
                  .catch((error: unknown) => {
                    const normalizedError =
                      error instanceof Error ? error : new Error(String(error));
                    onToolCallError.current?.(
                      'Tool call handler failed',
                      normalizedError,
                    );
                  });
              }
            }
            return;
          }
          if (message.type === 'session_settings') {
            onSessionSettings.current?.(message);
            return;
          }

          // asserts that all message types are handled
          isNever(message);
          return;
        });

        socket.on('close', (event) => {
          signal.removeEventListener('abort', abortHandler);
          if (activeConnection.current !== connection) {
            return;
          }
          activeConnection.current = null;
          if (client.current === socket) {
            client.current = null;
          }
          void onClose.current?.(event, connection.consumerInitiated);
          setReadyState(VoiceReadyState.CLOSED);
        });

        socket.on('error', (e) => {
          signal.removeEventListener('abort', abortHandler);
          if (activeConnection.current !== connection) {
            return;
          }
          const message = e instanceof Error ? e.message : 'Unknown error';
          onClientError.current?.(message, e instanceof Error ? e : undefined);
          reject(e);
        });

        setReadyState(VoiceReadyState.CONNECTING);
      });
    },
    [],
  );

  const disconnect = useCallback(() => {
    const connection = activeConnection.current;
    if (connection) {
      connection.consumerInitiated = true;
    }
    connectAbortController.current?.abort();
    connectAbortController.current = null;
    setReadyState(VoiceReadyState.IDLE);
    connection?.socket.close();
  }, []);

  const sendSessionSettings = useCallback(
    (sessionSettings: SessionSettingsUpdate) => {
      if (readyState !== VoiceReadyState.OPEN) {
        return;
      }
      client.current?.sendSessionSettings(sessionSettings);
      onSessionSettings.current?.({
        ...sessionSettings,
        type: 'session_settings',
      });
    },
    [readyState],
  );

  const sendAudio = useCallback(
    (arrayBuffer: ArrayBufferLike) => {
      if (readyState !== VoiceReadyState.OPEN) {
        return;
      }
      client.current?.socket?.send(arrayBuffer as ArrayBuffer);
    },
    [readyState],
  );

  const sendUserInput = useCallback(
    (text: string) => {
      if (readyState !== VoiceReadyState.OPEN) {
        return;
      }
      client.current?.sendUserInput(text);
    },
    [readyState],
  );

  const sendAssistantInput = useCallback(
    (text: string) => {
      if (readyState !== VoiceReadyState.OPEN) {
        return;
      }
      client.current?.sendAssistantInput({
        text,
      });
    },
    [readyState],
  );

  const sendToolMessage = useCallback(
    (
      // type definitions for toolMessage come from the Hume SDK because messages that are sent from the client
      // to the backend do not have the extended `receivedAt` field
      toolMessage:
        | Hume.empathicVoice.ToolResponseMessage
        | Hume.empathicVoice.ToolErrorMessage,
    ) => {
      if (readyState !== VoiceReadyState.OPEN) {
        return;
      }
      const socket = client.current;
      if (!socket) {
        return;
      }
      if (toolMessage.type === 'tool_error') {
        socket.sendToolErrorMessage(toolMessage);
      } else {
        socket.sendToolResponseMessage(toolMessage);
      }
      onMessage.current?.({
        ...toolMessage,
        receivedAt: new Date(),
      });
    },
    [readyState],
  );

  const sendPauseAssistantMessage = useCallback(() => {
    if (readyState !== VoiceReadyState.OPEN) {
      return;
    }
    client.current?.pauseAssistant({});
  }, [readyState]);
  const sendResumeAssistantMessage = useCallback(() => {
    if (readyState !== VoiceReadyState.OPEN) {
      return;
    }
    client.current?.resumeAssistant({});
  }, [readyState]);

  return useMemo(
    () => ({
      readyState,
      sendSessionSettings,
      sendAudio,
      connect,
      disconnect,
      sendUserInput,
      sendAssistantInput,
      sendToolMessage,
      sendPauseAssistantMessage,
      sendResumeAssistantMessage,
    }),
    [
      readyState,
      sendSessionSettings,
      sendAudio,
      connect,
      disconnect,
      sendUserInput,
      sendAssistantInput,
      sendToolMessage,
      sendPauseAssistantMessage,
      sendResumeAssistantMessage,
    ],
  );
};
