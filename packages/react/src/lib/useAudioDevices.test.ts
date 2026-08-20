import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAudioDevices } from './useAudioDevices';
import type { AudioDevices } from '../models/connect-options';
import {
  getAllAudioDevices,
  isAudioDeviceEnumerationSupported,
  requestAudioDevicePermission,
} from '../utils';

vi.mock('../utils', () => ({
  getAllAudioDevices: vi.fn(),
  isAudioDeviceEnumerationSupported: vi.fn(),
  requestAudioDevicePermission: vi.fn(),
}));

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

const devices = (suffix: string): AudioDevices => ({
  inputDevices: [
    {
      deviceId: `input-${suffix}`,
      kind: 'audioinput',
      label: `Microphone ${suffix}`,
    },
  ],
  outputDevices: [
    {
      deviceId: `output-${suffix}`,
      kind: 'audiooutput',
      label: `Speaker ${suffix}`,
    },
  ],
});

describe('useAudioDevices', () => {
  let originalMediaDevices: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalMediaDevices = Object.getOwnPropertyDescriptor(
      navigator,
      'mediaDevices',
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    vi.mocked(isAudioDeviceEnumerationSupported).mockReturnValue(true);
    vi.mocked(requestAudioDevicePermission).mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
    vi.resetAllMocks();
  });

  it('discards an older enumeration that finishes after a newer refetch', async () => {
    const older = createDeferred<AudioDevices>();
    const newer = createDeferred<AudioDevices>();
    vi.mocked(getAllAudioDevices)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const { result } = renderHook(() =>
      useAudioDevices({ requestPermission: false }),
    );
    await waitFor(() => expect(getAllAudioDevices).toHaveBeenCalledTimes(1));

    let newerRefetch = Promise.resolve();
    act(() => {
      newerRefetch = result.current.refetch();
    });

    await act(async () => {
      newer.resolve(devices('new'));
      await newerRefetch;
    });
    expect(result.current.inputDevices).toEqual(devices('new').inputDevices);
    expect(result.current.selectedInputDeviceId).toBe('input-new');

    await act(async () => {
      older.resolve(devices('old'));
      await older.promise;
    });

    expect(result.current.inputDevices).toEqual(devices('new').inputDevices);
    expect(result.current.outputDevices).toEqual(devices('new').outputDevices);
    expect(result.current.selectedInputDeviceId).toBe('input-new');
    expect(result.current.selectedOutputDeviceId).toBe('output-new');
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('keeps loading and error state owned by the newest refetch', async () => {
    const older = createDeferred<AudioDevices>();
    const newer = createDeferred<AudioDevices>();
    vi.mocked(getAllAudioDevices)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const { result } = renderHook(() =>
      useAudioDevices({ requestPermission: false }),
    );
    await waitFor(() => expect(getAllAudioDevices).toHaveBeenCalledTimes(1));

    let newerRefetch = Promise.resolve();
    act(() => {
      newerRefetch = result.current.refetch();
    });

    await act(async () => {
      older.reject(new Error('stale enumeration failure'));
      await older.promise.catch(() => undefined);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      newer.resolve(devices('new'));
      await newerRefetch;
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});
