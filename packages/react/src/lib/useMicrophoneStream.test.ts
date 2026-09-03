import { act, renderHook } from '@testing-library/react';
import { checkForAudioTracks } from 'hume';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMicrophoneStream } from './useMicrophoneStream';

vi.mock('hume', () => ({
  checkForAudioTracks: vi.fn(),
}));

const getUserMediaMock = vi.fn<() => Promise<MediaStream>>();
const createStream = (tracks: MediaStreamTrack[] = []) =>
  ({ getTracks: () => tracks }) as unknown as MediaStream;
const runInAct = async <T>(callback: () => Promise<T>): Promise<T> => {
  let outcome: PromiseSettledResult<T> | undefined;
  await act(async () => {
    [outcome] = await Promise.allSettled([callback()]);
  });
  if (!outcome) {
    throw new Error('The asynchronous hook operation did not settle.');
  }
  if (outcome.status === 'rejected') {
    throw outcome.reason;
  }
  return outcome.value;
};
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

    await runInAct(() =>
      result.current.getStream({
        deviceId: 'test-device-id',
      }),
    );

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
    await runInAct(() => result.current.getStream({}));

    result.current.stopStream(staleStream);
    result.current.stopStream();

    expect(staleTrackStop).toHaveBeenCalledOnce();
    expect(currentTrackStop).toHaveBeenCalledOnce();
  });

  it('reports an unsupported environment without treating it as a permission denial', async () => {
    Reflect.deleteProperty(window.navigator, 'mediaDevices');
    const { result } = renderHook(() => useMicrophoneStream());

    await expect(
      runInAct(() => result.current.getStream({})),
    ).rejects.toMatchObject({
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

      await expect(
        runInAct(() => result.current.getStream({})),
      ).rejects.toMatchObject({
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

    await expect(runInAct(() => result.current.getStream({}))).rejects.toThrow(
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

    await expect(runInAct(() => result.current.getStream({}))).rejects.toBe(
      validationError,
    );
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

    await expect(runInAct(() => result.current.getStream({}))).rejects.toBe(
      validationError,
    );
    expect(finalTrackStop).toHaveBeenCalledOnce();
  });

  it('attempts every track and retains the owned stream for a cleanup retry', async () => {
    const firstTrackStop = vi.fn().mockImplementationOnce(() => {
      throw new Error('First track failed to stop');
    });
    const finalTrackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: firstTrackStop }, { stop: finalTrackStop }],
    } as unknown as MediaStream;
    getUserMediaMock.mockResolvedValueOnce(stream);
    const { result } = renderHook(() => useMicrophoneStream());
    await runInAct(() => result.current.getStream({}));

    expect(() => result.current.stopStream()).toThrow(
      'First track failed to stop',
    );
    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(finalTrackStop).toHaveBeenCalledOnce();

    result.current.stopStream();
    expect(firstTrackStop).toHaveBeenCalledTimes(2);
    expect(finalTrackStop).toHaveBeenCalledTimes(2);

    result.current.stopStream();
    expect(firstTrackStop).toHaveBeenCalledTimes(2);
    expect(finalTrackStop).toHaveBeenCalledTimes(2);
  });

  it('keeps a retained stream owned when a later stream is acquired', async () => {
    const retainedTrackStop = vi.fn().mockImplementationOnce(() => {
      throw new Error('Retained stream failed to stop');
    });
    const currentTrackStop = vi.fn();
    const retainedStream = {
      getTracks: () => [{ stop: retainedTrackStop }],
    } as unknown as MediaStream;
    const currentStream = {
      getTracks: () => [{ stop: currentTrackStop }],
    } as unknown as MediaStream;
    getUserMediaMock
      .mockResolvedValueOnce(retainedStream)
      .mockResolvedValueOnce(currentStream);
    const { result } = renderHook(() => useMicrophoneStream());
    await runInAct(() => result.current.getStream({}));

    expect(() => result.current.stopStream()).toThrow(
      'Retained stream failed to stop',
    );
    await runInAct(() => result.current.getStream({}));
    result.current.stopStream();

    expect(retainedTrackStop).toHaveBeenCalledTimes(2);
    expect(currentTrackStop).toHaveBeenCalledOnce();

    result.current.stopStream();
    expect(retainedTrackStop).toHaveBeenCalledTimes(2);
    expect(currentTrackStop).toHaveBeenCalledOnce();
  });

  it('reports failures from every owned stream in one cleanup pass', async () => {
    const firstFailure = new Error('First owned stream failed');
    const secondFailure = new Error('Second owned stream failed');
    const firstTrackStop = vi.fn(() => {
      throw firstFailure;
    });
    const secondTrackStop = vi.fn(() => {
      throw secondFailure;
    });
    getUserMediaMock
      .mockResolvedValueOnce(
        createStream([{ stop: firstTrackStop } as unknown as MediaStreamTrack]),
      )
      .mockResolvedValueOnce(
        createStream([
          { stop: secondTrackStop } as unknown as MediaStreamTrack,
        ]),
      );
    const { result } = renderHook(() => useMicrophoneStream());
    await runInAct(() => result.current.getStream({}));
    await runInAct(() => result.current.getStream({}));

    const cleanupError = (() => {
      try {
        result.current.stopStream();
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toEqual([
      firstFailure,
      secondFailure,
    ]);
    expect((cleanupError as AggregateError).message).toContain(
      '2 microphone cleanup failures occurred.',
    );
    expect((cleanupError as AggregateError).message).toContain(
      'First owned stream failed',
    );
    expect((cleanupError as AggregateError).message).toContain(
      'Second owned stream failed',
    );
    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(secondTrackStop).toHaveBeenCalledOnce();
  });

  it('retains the owned stream when track enumeration fails', async () => {
    const trackStop = vi.fn();
    const getTracks = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('Track enumeration failed');
      })
      .mockReturnValue([{ stop: trackStop }]);
    const stream = { getTracks } as unknown as MediaStream;
    getUserMediaMock.mockResolvedValueOnce(stream);
    const { result } = renderHook(() => useMicrophoneStream());
    await runInAct(() => result.current.getStream({}));

    expect(() => result.current.stopStream()).toThrow(
      'Track enumeration failed',
    );
    result.current.stopStream();

    expect(getTracks).toHaveBeenCalledTimes(2);
    expect(trackStop).toHaveBeenCalledOnce();

    result.current.stopStream();
    expect(getTracks).toHaveBeenCalledTimes(2);
  });
});
