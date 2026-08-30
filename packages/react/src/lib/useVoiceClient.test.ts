import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createVoiceDiagnosticsReporter,
  type VoiceDiagnosticEvent,
} from './diagnostics';
import { ConnectionGenerationError } from './errors';
import {
  type ToolCallHandler,
  useVoiceClient,
  VoiceReadyState,
} from './useVoiceClient';

type MessageHandler = NonNullable<
  Parameters<typeof useVoiceClient>[0]['onMessage']
>;

const humeMocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock('hume', () => ({
  Hume: {
    empathicVoice: {
      ToolType: { Function: 'function' },
    },
  },
  HumeClient: vi.fn(() => ({
    empathicVoice: {
      chat: {
        connect: humeMocks.connect,
      },
    },
  })),
}));

type SocketHandler = (value: never) => void;

const createSocket = () => {
  const handlers = new Map<string, SocketHandler>();
  return {
    handlers,
    close: vi.fn(),
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
    }),
    sendSessionSettings: vi.fn(),
    sendToolErrorMessage: vi.fn(),
    sendToolResponseMessage: vi.fn(),
  };
};

const config = {
  auth: { type: 'accessToken' as const, value: 'test-token' },
};

const createDeferred = <T>() => {
  let resolve = (_value: T): void => {
    throw new Error('Deferred promise was not initialized.');
  };
  let reject = (_reason?: unknown): void => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

describe('useVoiceClient', () => {
  beforeEach(() => {
    humeMocks.connect.mockReset();
  });

  it('creates a client with the given config', () => {
    const hook = renderHook(() =>
      useVoiceClient({
        onClientError: () => {},
      }),
    );

    expect(hook.result.current.readyState).toBe(VoiceReadyState.IDLE);
  });

  it('rejects an unusable auth strategy before creating a socket', async () => {
    const onClientError = vi.fn();
    const { result } = renderHook(() => useVoiceClient({ onClientError }));

    let connectPromise = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connectPromise = result.current.connect({
        auth: { type: 'apiKey', value: '' },
      });
    });

    await expect(connectPromise).rejects.toThrow(
      'auth.value: API key for the Hume API must not be empty',
    );
    expect(onClientError).toHaveBeenCalledWith(
      'auth.value: API key for the Hume API must not be empty',
      expect.any(Error),
    );
    expect(humeMocks.connect).not.toHaveBeenCalled();
    expect(result.current.readyState).toBe(VoiceReadyState.IDLE);
  });

  it('ignores a stale socket close after a newer connection becomes active', async () => {
    const firstSocket = createSocket();
    const secondSocket = createSocket();
    humeMocks.connect
      .mockReturnValueOnce(firstSocket)
      .mockReturnValueOnce(secondSocket);
    const onClose = vi.fn();
    const onClientError = vi.fn();
    const { result } = renderHook(() =>
      useVoiceClient({ onClose, onClientError }),
    );

    let firstConnect = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      firstConnect = result.current.connect(config);
    });
    act(() => {
      firstSocket.handlers.get('message')?.({
        type: 'chat_metadata',
      } as never);
    });
    await expect(firstConnect).resolves.toBe(VoiceReadyState.OPEN);

    let secondConnect = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      secondConnect = result.current.connect(config, undefined, 22);
    });
    act(() => {
      secondSocket.handlers.get('message')?.({
        type: 'chat_metadata',
      } as never);
    });
    await expect(secondConnect).resolves.toBe(VoiceReadyState.OPEN);

    act(() => {
      firstSocket.handlers.get('error')?.(new Error('stale failure') as never);
    });
    expect(onClientError).not.toHaveBeenCalled();
    expect(result.current.readyState).toBe(VoiceReadyState.OPEN);

    act(() => {
      firstSocket.handlers.get('close')?.({ code: 1000 } as never);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.readyState).toBe(VoiceReadyState.OPEN);

    act(() => {
      result.current.disconnect();
      secondSocket.handlers.get('close')?.({ code: 1000 } as never);
    });
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1000 }),
      true,
      22,
    );
  });

  it('rejects when the active socket closes before opening', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const onClose = vi.fn();
    const { result } = renderHook(() => useVoiceClient({ onClose }));

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config, undefined, 7);
    });
    act(() => {
      socket.handlers.get('close')?.({ code: 1006 } as never);
    });

    await expect(connecting).rejects.toThrow(
      'The websocket closed before the voice connection opened (code 1006).',
    );
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1006 }),
      false,
      7,
    );
    expect(result.current.readyState).toBe(VoiceReadyState.CLOSED);
  });

  it('settles a pre-open connection before invoking a throwing onClose', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      level: 'debug',
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const onClose = vi.fn(() => {
      throw new Error('consumer close failed');
    });
    const { result } = renderHook(() =>
      useVoiceClient({ diagnostics, onClose }),
    );

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config, undefined, 8);
    });
    act(() => {
      socket.handlers.get('close')?.({ code: 1006 } as never);
    });

    await expect(connecting).rejects.toThrow(
      'The websocket closed before the voice connection opened (code 1006).',
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(
      events.filter((event) => event.name === 'consumer.callback_failed'),
    ).toHaveLength(1);
    expect(result.current.readyState).toBe(VoiceReadyState.CLOSED);
  });

  it('generates close correlation when the caller omits a generation', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const onClose = vi.fn();
    const { result } = renderHook(() => useVoiceClient({ onClose }));

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('close')?.({ code: 1006 } as never);
    });

    await expect(connecting).rejects.toThrow(
      'The websocket closed before the voice connection opened (code 1006).',
    );
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1006 }),
      false,
      -1,
    );
  });

  it('keeps generated and caller-supplied generations disjoint', async () => {
    const generatedSocket = createSocket();
    const suppliedSocket = createSocket();
    humeMocks.connect
      .mockReturnValueOnce(generatedSocket)
      .mockReturnValueOnce(suppliedSocket);
    const onClose = vi.fn();
    const { result } = renderHook(() => useVoiceClient({ onClose }));

    let generatedConnection = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      generatedConnection = result.current.connect(config);
    });
    act(() => {
      generatedSocket.handlers.get('close')?.({ code: 1006 } as never);
    });
    await expect(generatedConnection).rejects.toThrow();

    let suppliedConnection = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      suppliedConnection = result.current.connect(config, undefined, 1);
    });
    act(() => {
      suppliedSocket.handlers.get('close')?.({ code: 1006 } as never);
    });
    await expect(suppliedConnection).rejects.toThrow();

    expect(onClose).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ code: 1006 }),
      false,
      -1,
    );
    expect(onClose).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ code: 1006 }),
      false,
      1,
    );
  });

  it('rejects reuse of an explicit generation after its connection closes', async () => {
    const firstSocket = createSocket();
    humeMocks.connect.mockReturnValueOnce(firstSocket);
    const { result } = renderHook(() => useVoiceClient({}));

    let firstConnection = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      firstConnection = result.current.connect(config, undefined, 9);
    });
    act(() => {
      firstSocket.handlers.get('close')?.({ code: 1006 } as never);
    });
    await expect(firstConnection).rejects.toThrow();

    const generationError = await result.current
      .connect(config, undefined, 9)
      .catch((error: unknown) => error);

    expect(generationError).toBeInstanceOf(ConnectionGenerationError);
    expect(generationError).toMatchObject({
      connectionGeneration: 9,
      reason: 'not_strictly_increasing',
    });
    expect(humeMocks.connect).toHaveBeenCalledOnce();
  });

  it('does not abort an active attempt for an invalid generation', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const { result } = renderHook(() => useVoiceClient({}));

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config, undefined, 10);
    });

    await expect(result.current.connect(config, undefined, -1)).rejects.toThrow(
      'connectionGeneration must be a non-negative safe integer',
    );
    expect(socket.close).not.toHaveBeenCalled();

    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await expect(connecting).resolves.toBe(VoiceReadyState.OPEN);
  });

  it('ignores a late tool call after the socket closes', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const onMessage = vi.fn<MessageHandler>();
    const onToolCall = vi.fn<ToolCallHandler>();
    const { result } = renderHook(() =>
      useVoiceClient({ onMessage, onToolCall }),
    );

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;
    onMessage.mockClear();

    act(() => {
      socket.handlers.get('close')?.({ code: 1000 } as never);
      socket.handlers.get('message')?.({
        type: 'tool_call',
        toolCallId: 'late-call',
        name: 'late',
        parameters: '{}',
        toolType: 'function',
        responseRequired: true,
      } as never);
    });
    await act(() => Promise.resolve());

    expect(onMessage).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it('accepts session settings without the wire-level type field', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const onSessionSettings = vi.fn();
    const { result } = renderHook(() => useVoiceClient({ onSessionSettings }));

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;

    act(() => {
      result.current.sendSessionSettings({
        builtinTools: [{ name: 'web_search' }],
      });
    });

    expect(socket.sendSessionSettings).toHaveBeenCalledWith({
      builtinTools: [{ name: 'web_search' }],
    });
    expect(onSessionSettings).toHaveBeenCalledWith({
      type: 'session_settings',
      builtinTools: [{ name: 'web_search' }],
    });
  });

  it('continues to forward inbound tool responses', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const onMessage = vi.fn<MessageHandler>();
    const { result } = renderHook(() => useVoiceClient({ onMessage }));

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;
    onMessage.mockClear();

    act(() => {
      socket.handlers.get('message')?.({
        type: 'tool_response',
        toolCallId: 'builtin-call',
        content: 'result',
      } as never);
    });

    expect(onMessage).toHaveBeenCalledOnce();
    const receivedMessage = onMessage.mock.calls[0]?.[0];
    expect(receivedMessage).toMatchObject({
      type: 'tool_response',
      toolCallId: 'builtin-call',
      content: 'result',
    });
    expect(receivedMessage?.receivedAt).toBeInstanceOf(Date);
  });

  it('reports message metadata without content unless content is enabled', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const events: VoiceDiagnosticEvent[] = [];
    let includeContent = false;
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      includeContent,
      level: 'debug',
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    diagnostics.beginConnection('test-token');
    const { result } = renderHook(() => useVoiceClient({ diagnostics }));

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({
        type: 'chat_metadata',
        chatId: 'chat-123',
      } as never);
    });
    await connecting;

    act(() => {
      socket.handlers.get('message')?.({
        type: 'user_message',
        id: 'message-123',
        message: { content: 'private transcript' },
      } as never);
    });

    const firstMessageEvent = events.find(
      (event) =>
        event.name === 'message.received' &&
        event.details['type'] === 'user_message',
    );
    expect(firstMessageEvent).toMatchObject({
      chatId: 'chat-123',
      details: {
        contentLength: 18,
        direction: 'inbound',
        messageId: 'message-123',
        type: 'user_message',
      },
    });
    expect(JSON.stringify(firstMessageEvent)).not.toContain(
      'private transcript',
    );

    includeContent = true;
    act(() => {
      socket.handlers.get('message')?.({
        type: 'assistant_message',
        id: 'message-456',
        message: { content: 'opted-in transcript' },
      } as never);
    });

    expect(JSON.stringify(events.at(-1))).toContain('opted-in transcript');
    expect(JSON.stringify(events)).not.toContain('test-token');
  });

  it('emits an automatic tool response after sending it', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const onMessage = vi.fn<MessageHandler>();
    const onToolCall = vi.fn<ToolCallHandler>((_message, send) =>
      Promise.resolve(send.success({ answer: 42 })),
    );
    const { result } = renderHook(() =>
      useVoiceClient({ onMessage, onToolCall }),
    );

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;
    onMessage.mockClear();

    act(() => {
      socket.handlers.get('message')?.({
        type: 'tool_call',
        toolCallId: 'function-call',
        name: 'answer',
        parameters: '{}',
        toolType: 'function',
        responseRequired: true,
      } as never);
    });

    await waitFor(() =>
      expect(socket.sendToolResponseMessage).toHaveBeenCalledWith({
        type: 'tool_response',
        toolCallId: 'function-call',
        content: '{"answer":42}',
      }),
    );
    const sentMessage = onMessage.mock.calls.at(-1)?.[0];
    expect(sentMessage).toMatchObject({
      type: 'tool_response',
      toolCallId: 'function-call',
      content: '{"answer":42}',
    });
    expect(sentMessage?.receivedAt).toBeInstanceOf(Date);
    expect(
      socket.sendToolResponseMessage.mock.invocationCallOrder[0],
    ).toBeLessThan(onMessage.mock.invocationCallOrder.at(-1) ?? 0);
  });

  it.each([
    {
      message: {
        type: 'tool_response' as const,
        toolCallId: 'manual-response',
        content: 'ok',
      },
      sendMethod: 'sendToolResponseMessage' as const,
    },
    {
      message: {
        type: 'tool_error' as const,
        toolCallId: 'manual-error',
        error: 'failed',
        code: 'tool_failed',
        level: 'warn' as const,
        content: 'fallback',
      },
      sendMethod: 'sendToolErrorMessage' as const,
    },
  ])('emits a manually sent $message.type', async ({ message, sendMethod }) => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const onMessage = vi.fn<MessageHandler>();
    const { result } = renderHook(() => useVoiceClient({ onMessage }));

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;
    onMessage.mockClear();

    act(() => {
      result.current.sendToolMessage(message);
    });

    expect(socket[sendMethod]).toHaveBeenCalledWith(message);
    const sentMessage = onMessage.mock.calls[0]?.[0];
    expect(sentMessage).toMatchObject({
      ...message,
    });
    expect(sentMessage?.receivedAt).toBeInstanceOf(Date);
    expect(socket[sendMethod].mock.invocationCallOrder[0]).toBeLessThan(
      onMessage.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('does not emit a manual tool response when the socket send fails', async () => {
    const socket = createSocket();
    socket.sendToolResponseMessage.mockImplementation(() => {
      throw new Error('send failed');
    });
    humeMocks.connect.mockReturnValue(socket);
    const onMessage = vi.fn<MessageHandler>();
    const { result } = renderHook(() => useVoiceClient({ onMessage }));

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;
    onMessage.mockClear();

    expect(() =>
      act(() => {
        result.current.sendToolMessage({
          type: 'tool_response',
          toolCallId: 'failed-call',
          content: 'nope',
        });
      }),
    ).toThrow('send failed');
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('reports automatic tool handler and send failures without emitting', async () => {
    const socket = createSocket();
    socket.sendToolResponseMessage.mockImplementation(() => {
      throw new Error('send failed');
    });
    humeMocks.connect.mockReturnValue(socket);
    const onMessage = vi.fn<MessageHandler>();
    const onToolCallError = vi.fn();
    const onToolCall = vi.fn<ToolCallHandler>((_message, send) =>
      Promise.resolve(send.success('result')),
    );
    const { result } = renderHook(() =>
      useVoiceClient({ onMessage, onToolCall, onToolCallError }),
    );

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;
    onMessage.mockClear();

    act(() => {
      socket.handlers.get('message')?.({
        type: 'tool_call',
        toolCallId: 'failed-call',
        name: 'fail',
        parameters: '{}',
        toolType: 'function',
        responseRequired: true,
      } as never);
    });

    await waitFor(() =>
      expect(onToolCallError).toHaveBeenCalledWith(
        'Failed to send tool response',
        expect.objectContaining({ message: 'send failed' }),
        'send_failure',
      ),
    );
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_call' }),
    );
  });

  it('reports a synchronous automatic tool handler failure', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const onMessage = vi.fn<MessageHandler>();
    const onToolCallError = vi.fn();
    const onToolCall = vi.fn<ToolCallHandler>(() => {
      throw new Error('handler failed');
    });
    const { result } = renderHook(() =>
      useVoiceClient({ onMessage, onToolCall, onToolCallError }),
    );

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;
    onMessage.mockClear();

    act(() => {
      socket.handlers.get('message')?.({
        type: 'tool_call',
        toolCallId: 'failed-handler',
        name: 'fail',
        parameters: '{}',
        toolType: 'function',
        responseRequired: true,
      } as never);
    });

    await waitFor(() =>
      expect(onToolCallError).toHaveBeenCalledWith(
        'Tool call handler failed',
        expect.objectContaining({ message: 'handler failed' }),
        'handler_failure',
      ),
    );
    expect(socket.sendToolResponseMessage).not.toHaveBeenCalled();
    expect(socket.sendToolErrorMessage).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_call' }),
    );
  });

  it('reports an undefined tool handler result as invalid', async () => {
    const socket = createSocket();
    humeMocks.connect.mockReturnValue(socket);
    const onToolCallError = vi.fn();
    const onToolCall = vi.fn<ToolCallHandler>(() =>
      Promise.resolve(undefined as never),
    );
    const { result } = renderHook(() =>
      useVoiceClient({ onToolCall, onToolCallError }),
    );

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;

    act(() => {
      socket.handlers.get('message')?.({
        type: 'tool_call',
        toolCallId: 'undefined-handler',
        name: 'invalid',
        parameters: '{}',
        toolType: 'function',
        responseRequired: true,
      } as never);
    });

    await waitFor(() =>
      expect(onToolCallError).toHaveBeenCalledWith(
        'Invalid response from tool call',
        undefined,
        'invalid_response',
      ),
    );
    expect(socket.sendToolResponseMessage).not.toHaveBeenCalled();
    expect(socket.sendToolErrorMessage).not.toHaveBeenCalled();
  });

  it('ignores a tool handler result that settles after disconnect', async () => {
    const socket = createSocket();
    const response = createDeferred<Awaited<ReturnType<ToolCallHandler>>>();
    humeMocks.connect.mockReturnValue(socket);
    const onMessage = vi.fn<MessageHandler>();
    const onToolCallError = vi.fn();
    const onToolCall = vi.fn<ToolCallHandler>(() => response.promise);
    const { result } = renderHook(() =>
      useVoiceClient({ onMessage, onToolCall, onToolCallError }),
    );

    let connecting = Promise.resolve(VoiceReadyState.IDLE);
    act(() => {
      connecting = result.current.connect(config);
    });
    act(() => {
      socket.handlers.get('message')?.({ type: 'chat_metadata' } as never);
    });
    await connecting;
    onMessage.mockClear();

    act(() => {
      socket.handlers.get('message')?.({
        type: 'tool_call',
        toolCallId: 'late-handler',
        name: 'late',
        parameters: '{}',
        toolType: 'function',
        responseRequired: true,
      } as never);
    });
    await waitFor(() => expect(onToolCall).toHaveBeenCalledOnce());

    act(() => result.current.disconnect());
    await act(async () => {
      response.resolve({
        type: 'tool_response',
        toolCallId: 'late-handler',
        content: 'late result',
      });
      await response.promise;
    });

    expect(socket.sendToolResponseMessage).not.toHaveBeenCalled();
    expect(socket.sendToolErrorMessage).not.toHaveBeenCalled();
    expect(onToolCallError).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_call' }),
    );
  });
});
