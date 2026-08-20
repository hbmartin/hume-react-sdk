import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceClient, VoiceReadyState } from './useVoiceClient';

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
});
