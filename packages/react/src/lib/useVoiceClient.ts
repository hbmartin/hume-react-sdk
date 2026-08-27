import { Hume, HumeClient } from 'hume';
import { useCallback, useMemo, useRef, useState } from 'react';
import { type Simplify } from 'type-fest';

import { type AuthStrategy, getAuthStrategyError } from './auth';
import {
  invokeIsolatedConsumerCallback,
  type VoiceDiagnosticInput,
  type VoiceDiagnosticsReporter,
} from './diagnostics';
import { ConnectionGenerationError } from './errors';
import { useLatestRef } from './useLatestRef';
import type {
  AudioOutputMessage,
  JSONMessage,
  ToolCall,
} from '../models/messages';

const isNever = (_n: never) => {
  return;
};

const getMonotonicTime = () => globalThis.performance?.now() ?? Date.now();

const getMessageDiagnostics = (message: { type: string }) => {
  const record = message as unknown as Record<string, unknown>;
  const nestedMessage =
    typeof record.message === 'object' && record.message !== null
      ? (record.message as Record<string, unknown>)
      : undefined;
  const content = nestedMessage?.content ?? record.content;
  const parameters = record.parameters;
  const toolError = record.error;
  const contentLength =
    typeof content === 'string' ? content.length : undefined;
  return {
    details: {
      direction: 'inbound',
      type: message.type,
      ...(typeof record.id === 'string' ? { messageId: record.id } : undefined),
      ...(typeof record.toolCallId === 'string'
        ? { toolCallId: record.toolCallId }
        : undefined),
      ...(typeof record.name === 'string'
        ? { toolName: record.name }
        : undefined),
      ...(contentLength === undefined ? undefined : { contentLength }),
    },
    sensitiveDetails: {
      ...(content === undefined ? undefined : { content }),
      ...(parameters === undefined ? undefined : { parameters }),
      ...(toolError === undefined ? undefined : { error: toolError }),
    },
  };
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

export type ToolCallErrorSource =
  | 'handler_failure'
  | 'invalid_response'
  | 'send_failure';

const SKIPPED_TOOL_CALL = Symbol('skipped_tool_call');
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
  diagnostics?: VoiceDiagnosticsReporter;
  onAudioMessage?: (message: AudioOutputMessage) => void;
  onMessage?: (message: JSONMessage) => void;
  onSessionSettings?: (
    sessionSettings: Hume.empathicVoice.SessionSettings,
  ) => void;
  onToolCall?: ToolCallHandler;
  onToolCallError?: (
    message: string,
    error?: Error,
    source?: ToolCallErrorSource,
  ) => void;
  onClientError?: (message: string, error?: Error) => void;
  onOpen?: () => void;
  onClose?: (
    event: SocketCloseEvent,
    consumerInitiated: boolean,
    connectionGeneration: number,
  ) => void | Promise<void>;
}) => {
  const connectAbortController = useRef<AbortController | null>(null);
  const activeConnection = useRef<ActiveConnection | null>(null);
  const client = useRef<Hume.empathicVoice.chat.ChatSocket | null>(null);
  const generatedConnectionGeneration = useRef(0);
  const latestExplicitConnectionGeneration = useRef<number | null>(null);

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
  const diagnostics = useLatestRef(props.diagnostics);

  const report = useCallback(
    (input: VoiceDiagnosticInput) => diagnostics.current?.emit(input),
    [diagnostics],
  );

  const connect = useCallback(
    (
      config: SocketConfig,
      sessionSettings?: Hume.empathicVoice.SessionSettings,
      connectionGeneration?: number,
    ) => {
      if (
        connectionGeneration !== undefined &&
        (!Number.isSafeInteger(connectionGeneration) ||
          connectionGeneration < 0)
      ) {
        return Promise.reject(
          new ConnectionGenerationError(
            connectionGeneration,
            'invalid',
            'connectionGeneration must be a non-negative safe integer',
          ),
        );
      }
      if (
        connectionGeneration !== undefined &&
        latestExplicitConnectionGeneration.current !== null &&
        connectionGeneration <= latestExplicitConnectionGeneration.current
      ) {
        return Promise.reject(
          new ConnectionGenerationError(
            connectionGeneration,
            'not_strictly_increasing',
            `connectionGeneration ${connectionGeneration} must be greater than the previous explicit generation ${latestExplicitConnectionGeneration.current}`,
          ),
        );
      }
      if (connectionGeneration !== undefined) {
        latestExplicitConnectionGeneration.current = connectionGeneration;
      }
      // Generated values occupy the negative namespace while provider-owned
      // lifecycle generations are non-negative, so the two modes cannot alias.
      const resolvedConnectionGeneration =
        connectionGeneration ?? --generatedConnectionGeneration.current;

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

        report({
          level: 'info',
          category: 'socket',
          name: 'resource.initialization_started',
          details: { resource: 'socket', hostname },
        });

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
        let connectionOpened = false;
        activeConnection.current = connection;
        const isConnectionActive = () =>
          !signal.aborted &&
          activeConnection.current === connection &&
          client.current === socket;

        const abortHandler = () => {
          connection.consumerInitiated = true;
          socket.close();
          reject(new Error('Connection attempt has been aborted'));
        };

        signal.addEventListener('abort', abortHandler);

        socket.on('message', (message) => {
          if (!isConnectionActive()) {
            return;
          }

          if (message.type === 'audio_output') {
            if (diagnostics.current?.isEnabled('debug')) {
              diagnostics.current.emit({
                level: 'debug',
                category: 'audio_player',
                name: 'audio.chunk_received',
                details: {
                  messageId: message.id,
                  index: message.index,
                  encodedLength: message.data.length,
                },
              });
            }
            const messageWithReceivedAt = {
              ...message,
              receivedAt: new Date(),
            };
            onAudioMessage.current?.(messageWithReceivedAt);
            return;
          }

          if (message.type === 'chat_metadata') {
            connectionOpened = true;
            const chatId = (message as unknown as { chatId?: string }).chatId;
            diagnostics.current?.setChatId(chatId);
            report({
              level: 'info',
              category: 'socket',
              name: 'resource.initialized',
              details: { resource: 'socket' },
            });
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
            if (diagnostics.current?.isEnabled('debug')) {
              diagnostics.current.emit({
                level: 'debug',
                category: 'message',
                name: 'message.received',
                ...getMessageDiagnostics(message),
              });
            }
            const messageWithReceivedAt = {
              ...message,
              receivedAt: new Date(),
            };
            onMessage.current?.(messageWithReceivedAt);
            return;
          }

          if (message.type === 'tool_call') {
            if (diagnostics.current?.isEnabled('debug')) {
              diagnostics.current.emit({
                level: 'debug',
                category: 'message',
                name: 'message.received',
                ...getMessageDiagnostics(message),
              });
            }
            const messageWithReceivedAt = {
              ...message,
              receivedAt: new Date(),
            };
            onMessage.current?.(messageWithReceivedAt);

            // only pass tool call messages for user defined tools
            if (message.toolType === Hume.empathicVoice.ToolType.Function) {
              const handler = onToolCall.current;
              if (handler) {
                const handlerStartedAt = getMonotonicTime();
                report({
                  level: 'info',
                  category: 'tool',
                  name: 'tool.handler_started',
                  details: {
                    toolCallId: message.toolCallId,
                    toolName: message.name,
                  },
                  sensitiveDetails: { parameters: message.parameters },
                });
                void Promise.resolve()
                  .then<
                    | Awaited<ReturnType<ToolCallHandler>>
                    | typeof SKIPPED_TOOL_CALL
                  >(() => {
                    if (!isConnectionActive()) {
                      return SKIPPED_TOOL_CALL;
                    }
                    return handler(
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
                    );
                  })
                  .then((response) => {
                    if (
                      !isConnectionActive() ||
                      response === SKIPPED_TOOL_CALL
                    ) {
                      report({
                        level: 'warn',
                        category: 'tool',
                        name: 'tool.handler_skipped',
                        durationMs: getMonotonicTime() - handlerStartedAt,
                        details: {
                          toolCallId: message.toolCallId,
                          reason: 'connection_inactive',
                        },
                      });
                      return;
                    }
                    if (response === undefined || response === null) {
                      report({
                        level: 'error',
                        category: 'tool',
                        name: 'tool.handler_failed',
                        durationMs: getMonotonicTime() - handlerStartedAt,
                        details: {
                          toolCallId: message.toolCallId,
                          reason: 'invalid_response',
                        },
                      });
                      onToolCallError.current?.(
                        'Invalid response from tool call',
                        undefined,
                        'invalid_response',
                      );
                      return;
                    }
                    try {
                      if (response.type === 'tool_response') {
                        socket.sendToolResponseMessage(response);
                      } else if (response.type === 'tool_error') {
                        socket.sendToolErrorMessage(response);
                      } else {
                        report({
                          level: 'error',
                          category: 'tool',
                          name: 'tool.handler_failed',
                          durationMs: getMonotonicTime() - handlerStartedAt,
                          details: {
                            toolCallId: message.toolCallId,
                            reason: 'invalid_response',
                          },
                        });
                        onToolCallError.current?.(
                          'Invalid response from tool call',
                          undefined,
                          'invalid_response',
                        );
                        return;
                      }
                    } catch (error) {
                      if (!isConnectionActive()) {
                        return;
                      }
                      const normalizedError =
                        error instanceof Error
                          ? error
                          : new Error(String(error));
                      report({
                        level: 'error',
                        category: 'tool',
                        name: 'tool.handler_failed',
                        durationMs: getMonotonicTime() - handlerStartedAt,
                        details: {
                          toolCallId: message.toolCallId,
                          reason: 'send_failure',
                          errorName: normalizedError.name,
                        },
                        sensitiveDetails: { error: normalizedError.message },
                      });
                      onToolCallError.current?.(
                        'Failed to send tool response',
                        normalizedError,
                        'send_failure',
                      );
                      return;
                    }
                    if (!isConnectionActive()) {
                      return;
                    }
                    report({
                      level: 'info',
                      category: 'tool',
                      name: 'tool.handler_completed',
                      durationMs: getMonotonicTime() - handlerStartedAt,
                      details: {
                        toolCallId: message.toolCallId,
                        responseType: response.type,
                      },
                      sensitiveDetails: {
                        content: response.content,
                        ...(response.type === 'tool_error'
                          ? { error: response.error }
                          : undefined),
                      },
                    });
                    onMessage.current?.({
                      ...response,
                      receivedAt: new Date(),
                    });
                  })
                  .catch((error: unknown) => {
                    if (!isConnectionActive()) {
                      return;
                    }
                    const normalizedError =
                      error instanceof Error ? error : new Error(String(error));
                    report({
                      level: 'error',
                      category: 'tool',
                      name: 'tool.handler_failed',
                      durationMs: getMonotonicTime() - handlerStartedAt,
                      details: {
                        toolCallId: message.toolCallId,
                        reason: 'handler_failure',
                        errorName: normalizedError.name,
                      },
                      sensitiveDetails: { error: normalizedError.message },
                    });
                    onToolCallError.current?.(
                      'Tool call handler failed',
                      normalizedError,
                      'handler_failure',
                    );
                  });
              } else {
                report({
                  level: 'warn',
                  category: 'tool',
                  name: 'tool.handler_skipped',
                  details: {
                    toolCallId: message.toolCallId,
                    reason: 'handler_missing',
                  },
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
          report({
            level: connection.consumerInitiated ? 'info' : 'warn',
            category: 'socket',
            name: 'socket.closed',
            details: {
              code: event.code,
              reason: event.reason,
              wasClean: event.wasClean,
              consumerInitiated: connection.consumerInitiated,
            },
          });
          setReadyState(VoiceReadyState.CLOSED);
          if (!connectionOpened) {
            reject(
              new Error(
                `The websocket closed before the voice connection opened (code ${event.code}).`,
              ),
            );
          }
          invokeIsolatedConsumerCallback(diagnostics.current, 'onClose', () =>
            onClose.current?.(
              event,
              connection.consumerInitiated,
              resolvedConnectionGeneration,
            ),
          );
        });

        socket.on('error', (e) => {
          signal.removeEventListener('abort', abortHandler);
          if (activeConnection.current !== connection) {
            return;
          }
          const message = e instanceof Error ? e.message : 'Unknown error';
          report({
            level: 'error',
            category: 'socket',
            name: 'resource.cleanup_failed',
            details: { resource: 'socket', message, error: e },
          });
          onClientError.current?.(message, e instanceof Error ? e : undefined);
          reject(e);
        });

        setReadyState(VoiceReadyState.CONNECTING);
      });
    },
    [
      onAudioMessage,
      onClientError,
      onClose,
      onMessage,
      onOpen,
      onSessionSettings,
      onToolCall,
      onToolCallError,
      diagnostics,
      report,
    ],
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
        report({
          level: 'warn',
          category: 'message',
          name: 'message.skipped',
          details: {
            direction: 'outbound',
            type: 'session_settings',
            reason: 'socket_not_open',
          },
        });
        return;
      }
      client.current?.sendSessionSettings(sessionSettings);
      report({
        level: 'debug',
        category: 'message',
        name: 'message.sent',
        details: {
          direction: 'outbound',
          type: 'session_settings',
          settingKeys: Object.keys(sessionSettings),
        },
      });
      onSessionSettings.current?.({
        ...sessionSettings,
        type: 'session_settings',
      });
    },
    [onSessionSettings, readyState, report],
  );

  const sendAudio = useCallback(
    (arrayBuffer: ArrayBufferLike) => {
      if (readyState !== VoiceReadyState.OPEN) {
        if (diagnostics.current?.isEnabled('debug')) {
          report({
            level: 'debug',
            category: 'message',
            name: 'message.skipped',
            details: {
              direction: 'outbound',
              type: 'audio_input',
              reason: 'socket_not_open',
            },
          });
        }
        return;
      }
      client.current?.socket?.send(arrayBuffer as ArrayBuffer);
      if (diagnostics.current?.isEnabled('debug')) {
        report({
          level: 'debug',
          category: 'message',
          name: 'message.sent',
          details: {
            direction: 'outbound',
            type: 'audio_input',
            byteLength: arrayBuffer.byteLength,
          },
        });
      }
    },
    [diagnostics, readyState, report],
  );

  const sendUserInput = useCallback(
    (text: string) => {
      if (readyState !== VoiceReadyState.OPEN) {
        report({
          level: 'warn',
          category: 'message',
          name: 'message.skipped',
          details: {
            direction: 'outbound',
            type: 'user_input',
            reason: 'socket_not_open',
            contentLength: text.length,
          },
          sensitiveDetails: { content: text },
        });
        return;
      }
      client.current?.sendUserInput(text);
      report({
        level: 'debug',
        category: 'message',
        name: 'message.sent',
        details: {
          direction: 'outbound',
          type: 'user_input',
          contentLength: text.length,
        },
        sensitiveDetails: { content: text },
      });
    },
    [readyState, report],
  );

  const sendAssistantInput = useCallback(
    (text: string) => {
      if (readyState !== VoiceReadyState.OPEN) {
        report({
          level: 'warn',
          category: 'message',
          name: 'message.skipped',
          details: {
            direction: 'outbound',
            type: 'assistant_input',
            reason: 'socket_not_open',
            contentLength: text.length,
          },
          sensitiveDetails: { content: text },
        });
        return;
      }
      client.current?.sendAssistantInput({
        text,
      });
      report({
        level: 'debug',
        category: 'message',
        name: 'message.sent',
        details: {
          direction: 'outbound',
          type: 'assistant_input',
          contentLength: text.length,
        },
        sensitiveDetails: { content: text },
      });
    },
    [readyState, report],
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
        report({
          level: 'warn',
          category: 'message',
          name: 'message.skipped',
          details: {
            direction: 'outbound',
            type: toolMessage.type,
            reason: 'socket_not_open',
            toolCallId: toolMessage.toolCallId,
          },
          sensitiveDetails: {
            content: toolMessage.content,
            ...(toolMessage.type === 'tool_error'
              ? { error: toolMessage.error }
              : undefined),
          },
        });
        return;
      }
      const socket = client.current;
      if (!socket) {
        report({
          level: 'warn',
          category: 'message',
          name: 'message.skipped',
          details: {
            direction: 'outbound',
            type: toolMessage.type,
            reason: 'socket_missing',
            toolCallId: toolMessage.toolCallId,
          },
          sensitiveDetails: {
            content: toolMessage.content,
            ...(toolMessage.type === 'tool_error'
              ? { error: toolMessage.error }
              : undefined),
          },
        });
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
      report({
        level: 'debug',
        category: 'message',
        name: 'message.sent',
        details: {
          direction: 'outbound',
          type: toolMessage.type,
          toolCallId: toolMessage.toolCallId,
        },
        sensitiveDetails: {
          content: toolMessage.content,
          ...(toolMessage.type === 'tool_error'
            ? { error: toolMessage.error }
            : undefined),
        },
      });
    },
    [onMessage, readyState, report],
  );

  const sendPauseAssistantMessage = useCallback(() => {
    if (readyState !== VoiceReadyState.OPEN) {
      report({
        level: 'warn',
        category: 'message',
        name: 'message.skipped',
        details: {
          direction: 'outbound',
          type: 'pause_assistant',
          reason: 'socket_not_open',
        },
      });
      return;
    }
    client.current?.pauseAssistant({});
    report({
      level: 'info',
      category: 'message',
      name: 'message.sent',
      details: { direction: 'outbound', type: 'pause_assistant' },
    });
  }, [readyState, report]);
  const sendResumeAssistantMessage = useCallback(() => {
    if (readyState !== VoiceReadyState.OPEN) {
      report({
        level: 'warn',
        category: 'message',
        name: 'message.skipped',
        details: {
          direction: 'outbound',
          type: 'resume_assistant',
          reason: 'socket_not_open',
        },
      });
      return;
    }
    client.current?.resumeAssistant({});
    report({
      level: 'info',
      category: 'message',
      name: 'message.sent',
      details: { direction: 'outbound', type: 'resume_assistant' },
    });
  }, [readyState, report]);

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
