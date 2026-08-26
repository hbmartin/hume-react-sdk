import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useMicrophone } from './useMicrophone';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  recorders: [] as Array<{
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  register: vi.fn(() => Promise.resolve()),
}));

vi.mock('extendable-media-recorder', () => ({
  MediaRecorder: class {
    addEventListener = vi.fn();

    removeEventListener = vi.fn();

    start = vi.fn();

    stop = vi.fn();

    constructor() {
      mocks.recorders.push(this);
    }
  },
  register: mocks.register,
}));

vi.mock('extendable-media-recorder-wav-encoder', () => ({
  connect: mocks.connect,
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const createStream = () => {
  const stop = vi.fn();
  const stream = {
    getTracks: () => [{ stop }],
  } as unknown as MediaStream;
  return { stop, stream };
};

describe('useMicrophone', () => {
  it('reports registration errors, cancels pending starts, and registers once', async () => {
    const registrationError = new Error('encoder unavailable');
    const encoderConnection = deferred<MessagePort>();
    mocks.connect
      .mockRejectedValueOnce(registrationError)
      .mockReturnValueOnce(encoderConnection.promise);
    const onError = vi.fn();
    const onStartRecording = vi.fn();
    const onStopRecording = vi.fn();
    const { result } = renderHook(() =>
      useMicrophone({
        onAudioCaptured: vi.fn(),
        onError,
        onStartRecording,
        onStopRecording,
      }),
    );

    const failedStream = createStream();
    await expect(result.current.start(failedStream.stream)).resolves.toBe(
      false,
    );
    expect(failedStream.stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      'Error with microphone: encoder unavailable',
    );

    const canceledStream = createStream();
    let pendingStart!: Promise<boolean>;
    act(() => {
      pendingStart = result.current.start(canceledStream.stream);
    });
    await act(async () => Promise.resolve());
    act(() => result.current.stop());
    expect(canceledStream.stop).toHaveBeenCalledOnce();

    encoderConnection.resolve({} as MessagePort);
    await expect(pendingStart).resolves.toBe(false);
    expect(mocks.recorders).toHaveLength(0);

    const firstRecording = createStream();
    await expect(result.current.start(firstRecording.stream)).resolves.toBe(
      true,
    );
    act(() => result.current.stop());

    const secondRecording = createStream();
    await expect(result.current.start(secondRecording.stream)).resolves.toBe(
      true,
    );
    act(() => result.current.stop());

    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.recorders).toHaveLength(2);
    expect(firstRecording.stop).toHaveBeenCalledOnce();
    expect(secondRecording.stop).toHaveBeenCalledOnce();
    expect(onStartRecording).toHaveBeenCalledTimes(2);
    expect(onStopRecording).toHaveBeenCalledTimes(2);
  });
});
