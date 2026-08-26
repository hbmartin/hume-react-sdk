import { Channels } from '@humeai/assistant';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEncoding } from './useEncoding';

const getUserMedia = vi.fn();

const createStream = ({
  getSettings = () => ({
    sampleRate: 44_100,
    channelCount: Channels.STEREO,
  }),
}: {
  getSettings?: () => MediaTrackSettings;
} = {}) => {
  const stop = vi.fn();
  const track = {
    getSettings,
    stop,
  } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;

  return { stop, stream };
};

describe('useEncoding', () => {
  beforeEach(() => {
    getUserMedia.mockReset();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
  });

  it('returns the acquired stream and its negotiated encoding', async () => {
    const { stream } = createStream();
    getUserMedia.mockResolvedValue(stream);
    const { result } = renderHook(() =>
      useEncoding({
        encodingConstraints: {
          sampleRate: 16_000,
          channelCount: Channels.MONO,
        },
      }),
    );

    let acquired: Awaited<ReturnType<typeof result.current.getStream>>;
    await act(async () => {
      acquired = await result.current.getStream();
    });

    expect(acquired!).toEqual({
      stream,
      encoding: {
        sampleRate: 44_100,
        channelCount: Channels.STEREO,
      },
    });
  });

  it('preserves the original getUserMedia failure', async () => {
    const permissionError = new DOMException('blocked', 'NotAllowedError');
    getUserMedia.mockRejectedValue(permissionError);
    const { result } = renderHook(() =>
      useEncoding({ encodingConstraints: {} }),
    );

    await expect(result.current.getStream()).rejects.toBe(permissionError);
  });

  it('stops an acquired stream when reading its settings fails', async () => {
    const settingsError = new Error('settings unavailable');
    const { stop, stream } = createStream({
      getSettings: () => {
        throw settingsError;
      },
    });
    getUserMedia.mockResolvedValue(stream);
    const { result } = renderHook(() =>
      useEncoding({ encodingConstraints: {} }),
    );

    await expect(result.current.getStream()).rejects.toBe(settingsError);
    expect(stop).toHaveBeenCalledOnce();
  });
});
