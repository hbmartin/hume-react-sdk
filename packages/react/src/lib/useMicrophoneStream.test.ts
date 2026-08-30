import { renderHook } from '@testing-library/react-hooks';
import { checkForAudioTracks } from 'hume';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMicrophoneStream } from './useMicrophoneStream';

vi.mock('hume', () => ({
  checkForAudioTracks: vi.fn(),
}));

const getUserMediaMock = vi.fn<() => Promise<MediaStream>>();
const originalMediaDevices = Object.getOwnPropertyDescriptor(
  window.navigator,
  'mediaDevices',
);

beforeEach(() => {
  vi.clearAllMocks();
  getUserMediaMock.mockResolvedValue({
    getTracks: () => [],
  } as unknown as MediaStream);
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: {
      getUserMedia: getUserMediaMock,
    },
    configurable: true,
  });
});

afterEach(() => {
  if (originalMediaDevices) {
    Object.defineProperty(
      window.navigator,
      'mediaDevices',
      originalMediaDevices,
    );
  } else {
    Reflect.deleteProperty(window.navigator, 'mediaDevices');
  }
});

describe('useGetMicrophoneStream', () => {
  it('is defined', () => {
    expect(useMicrophoneStream).toBeDefined();
  });

  it('getStream function works correctly', async () => {
    const { result } = renderHook(() => useMicrophoneStream());

    await result.current.getStream({
      deviceId: 'test-device-id',
    });

    expect(result.current.permission).toBe('granted');

    expect(getUserMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId: 'test-device-id',
        },
        video: false,
      }),
    );
  });

  it('can stop an exact stream without clearing a newer current stream', async () => {
    const currentTrackStop = vi.fn();
    const staleTrackStop = vi.fn();
    const currentStream = {
      getTracks: () => [{ stop: currentTrackStop }],
    } as unknown as MediaStream;
    const staleStream = {
      getTracks: () => [{ stop: staleTrackStop }],
    } as unknown as MediaStream;
    getUserMediaMock.mockResolvedValueOnce(currentStream);
    const { result } = renderHook(() => useMicrophoneStream());
    await result.current.getStream({});

    result.current.stopStream(staleStream);
    result.current.stopStream();

    expect(staleTrackStop).toHaveBeenCalledOnce();
    expect(currentTrackStop).toHaveBeenCalledOnce();
  });

  it('reports an unsupported environment without treating it as a permission denial', async () => {
    Reflect.deleteProperty(window.navigator, 'mediaDevices');
    const { result } = renderHook(() => useMicrophoneStream());

    await expect(result.current.getStream({})).rejects.toMatchObject({
      name: 'NotSupportedError',
      message: 'Microphone capture is not supported.',
    });

    expect(result.current.permission).toBe('prompt');
  });

  it.each(['NotAllowedError', 'SecurityError'])(
    'recognizes a name-only %s as a permission denial',
    async (name) => {
      getUserMediaMock.mockRejectedValueOnce({ name });
      const { result } = renderHook(() => useMicrophoneStream());

      await expect(result.current.getStream({})).rejects.toMatchObject({
        name,
      });

      expect(result.current.permission).toBe('denied');
    },
  );

  it('stops an acquired stream when audio-track validation fails', async () => {
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    getUserMediaMock.mockResolvedValueOnce(stream);
    vi.mocked(checkForAudioTracks).mockImplementationOnce(() => {
      throw new Error('No audio tracks');
    });
    const { result } = renderHook(() => useMicrophoneStream());

    await expect(result.current.getStream({})).rejects.toThrow(
      'No audio tracks',
    );

    expect(trackStop).toHaveBeenCalledOnce();
    expect(result.current.permission).toBe('granted');
  });

  it('preserves the validation error when enumerating cleanup tracks fails', async () => {
    const validationError = new Error('No audio tracks');
    const stream = {
      getTracks: () => {
        throw new Error('Track enumeration failed');
      },
    } as unknown as MediaStream;
    getUserMediaMock.mockResolvedValueOnce(stream);
    vi.mocked(checkForAudioTracks).mockImplementationOnce(() => {
      throw validationError;
    });
    const { result } = renderHook(() => useMicrophoneStream());

    await expect(result.current.getStream({})).rejects.toBe(validationError);
  });

  it('stops remaining tracks and preserves validation when one stop fails', async () => {
    const validationError = new Error('No audio tracks');
    const finalTrackStop = vi.fn();
    const stream = {
      getTracks: () => [
        {
          stop: () => {
            throw new Error('First track failed to stop');
          },
        },
        { stop: finalTrackStop },
      ],
    } as unknown as MediaStream;
    getUserMediaMock.mockResolvedValueOnce(stream);
    vi.mocked(checkForAudioTracks).mockImplementationOnce(() => {
      throw validationError;
    });
    const { result } = renderHook(() => useMicrophoneStream());

    await expect(result.current.getStream({})).rejects.toBe(validationError);
    expect(finalTrackStop).toHaveBeenCalledOnce();
  });
});
