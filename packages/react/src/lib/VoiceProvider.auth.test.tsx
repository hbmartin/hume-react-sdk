import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  getStream: vi.fn(),
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
    useVoiceClient: () => ({
      connect: mocks.clientConnect,
      disconnect: vi.fn(),
      readyState: actual.VoiceReadyState.IDLE,
      sendAssistantInput: vi.fn(),
      sendAudio: vi.fn(),
      sendPauseAssistantMessage: vi.fn(),
      sendResumeAssistantMessage: vi.fn(),
      sendSessionSettings: vi.fn(),
      sendToolMessage: vi.fn(),
      sendUserInput: vi.fn(),
    }),
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
    start: vi.fn(),
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

describe('VoiceProvider auth validation', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])(
    'reports an %s auth strategy without requesting the microphone',
    async (_description, value) => {
      const onError = vi.fn();
      const { result } = renderHook(() => useVoice(), {
        wrapper: ({ children }) => (
          <VoiceProvider onError={onError}>{children}</VoiceProvider>
        ),
      });

      await act(() =>
        result.current.connect({ auth: { type: 'accessToken', value } }),
      );

      const expectedMessage =
        'A websocket connection could not be established. Error message: auth.value: Access token for the Hume API must not be empty';
      expect(result.current.error).toMatchObject({
        type: 'socket_error',
        reason: 'socket_connection_failure',
        message: expectedMessage,
      });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'socket_error',
          message: expectedMessage,
        }),
      );
      expect(result.current.status.value).toBe('error');
      expect(mocks.getStream).not.toHaveBeenCalled();
      expect(mocks.playerInit).not.toHaveBeenCalled();
      expect(mocks.clientConnect).not.toHaveBeenCalled();
    },
  );
});
