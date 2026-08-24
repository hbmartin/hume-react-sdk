import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientProps: null as null | {
    onMessage?: (message: never) => void;
  },
  getStream: vi.fn(),
  micStart: vi.fn(),
  playerInit: vi.fn(),
}));

const fftStore = {
  getSnapshot: () => [],
  subscribe: () => () => {},
};

vi.mock('./useVoiceClient', async () => {
  const actual =
    await vi.importActual<typeof UseVoiceClientModule>('./useVoiceClient');
  return {
    ...actual,
    useVoiceClient: (props: Parameters<typeof actual.useVoiceClient>[0]) => {
      mocks.clientProps = props as typeof mocks.clientProps;
      return {
        connect: vi.fn().mockResolvedValue(actual.VoiceReadyState.OPEN),
        disconnect: vi.fn(),
        readyState: actual.VoiceReadyState.OPEN,
        sendAssistantInput: vi.fn(),
        sendAudio: vi.fn(),
        sendPauseAssistantMessage: vi.fn(),
        sendResumeAssistantMessage: vi.fn(),
        sendSessionSettings: vi.fn(),
        sendToolMessage: vi.fn(),
        sendUserInput: vi.fn(),
      };
    },
  };
});

vi.mock('./useSoundPlayer', () => ({
  useSoundPlayer: () => ({
    addToQueue: vi.fn(),
    clearQueue: vi.fn(),
    fftStore,
    initPlayer: mocks.playerInit,
    isAudioMuted: false,
    isPlaying: false,
    muteAudio: vi.fn(),
    queueLength: 0,
    setVolume: vi.fn(),
    stopAll: vi.fn(),
    stopAllForContext: vi.fn(),
    unmuteAudio: vi.fn(),
    volume: 1,
    waitForQueueToDrain: vi.fn(),
  }),
}));

vi.mock('./useMicrophone', () => ({
  useMicrophone: () => ({
    fftStore,
    isMuted: false,
    mute: vi.fn(),
    start: mocks.micStart,
    stop: vi.fn(),
    unmute: vi.fn(),
  }),
}));

vi.mock('./useMicrophoneStream', () => ({
  useMicrophoneStream: () => ({
    getStream: mocks.getStream,
    stopStream: vi.fn(),
  }),
}));

import type * as UseVoiceClientModule from './useVoiceClient';
import { useVoice, VoiceProvider } from './VoiceProvider';

describe('VoiceProvider tool message state', () => {
  let originalAudioContext: typeof globalThis.AudioContext;

  beforeEach(() => {
    originalAudioContext = globalThis.AudioContext;
    globalThis.AudioContext = vi.fn(() => ({
      close: vi.fn().mockResolvedValue(undefined),
    })) as unknown as typeof AudioContext;
    mocks.getStream.mockResolvedValue({ getTracks: () => [] });
    mocks.playerInit.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    globalThis.AudioContext = originalAudioContext;
    mocks.clientProps = null;
    vi.clearAllMocks();
  });

  it('adds a locally emitted tool result to every public message surface', async () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() => useVoice(), {
      wrapper: ({ children }) => (
        <VoiceProvider onMessage={onMessage}>{children}</VoiceProvider>
      ),
    });

    await act(() =>
      result.current.connect({
        auth: { type: 'accessToken', value: 'test-token' },
      }),
    );

    const toolCall = {
      type: 'tool_call' as const,
      toolCallId: 'tool-call-id',
      name: 'lookup',
      parameters: '{}',
      toolType: 'function' as const,
      responseRequired: true,
      receivedAt: new Date(1),
    };
    const toolResponse = {
      type: 'tool_response' as const,
      toolCallId: 'tool-call-id',
      content: 'result',
      receivedAt: new Date(2),
    };

    act(() => {
      mocks.clientProps?.onMessage?.(toolCall as never);
      mocks.clientProps?.onMessage?.(toolResponse as never);
    });

    await waitFor(() => {
      expect(result.current.messages).toEqual(
        expect.arrayContaining([toolCall, toolResponse]),
      );
      expect(result.current.toolStatusStore['tool-call-id']).toEqual({
        call: toolCall,
        resolved: toolResponse,
      });
    });
    expect(onMessage).toHaveBeenCalledWith(toolCall);
    expect(onMessage).toHaveBeenCalledWith(toolResponse);
  });
});
