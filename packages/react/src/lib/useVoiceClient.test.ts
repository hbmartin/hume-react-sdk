import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      secondConnect = result.current.connect(config);
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
    );
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
      ),
    );
    expect(socket.sendToolResponseMessage).not.toHaveBeenCalled();
    expect(socket.sendToolErrorMessage).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_call' }),
    );
  });
});
