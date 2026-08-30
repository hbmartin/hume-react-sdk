import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AudioDevices } from '../models/connect-options';
import {
  getAllAudioDevices,
  isAudioDeviceEnumerationSupported,
  requestAudioDevicePermission,
} from '../utils';
import { useAudioDevices } from './useAudioDevices';

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
    vi.mocked(getAllAudioDevices).mockResolvedValue(devices('initial'));
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

  it('enumerates without requesting permission by default', async () => {
    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() =>
      expect(result.current.inputDevices).toEqual(
        devices('initial').inputDevices,
      ),
    );
    expect(requestAudioDevicePermission).not.toHaveBeenCalled();
  });

  it('enumerates while an opt-in permission prompt is still pending', async () => {
    const permission = createDeferred<void>();
    vi.mocked(requestAudioDevicePermission).mockReturnValue(permission.promise);

    const { result } = renderHook(() =>
      useAudioDevices({ requestPermission: true }),
    );

    await waitFor(() =>
      expect(result.current.inputDevices).toEqual(
        devices('initial').inputDevices,
      ),
    );
    expect(requestAudioDevicePermission).toHaveBeenCalledTimes(1);

    await act(async () => {
      permission.resolve(undefined);
      await permission.promise;
    });
  });

  it('keeps privacy-redacted empty device ids unselected', async () => {
    vi.mocked(getAllAudioDevices).mockResolvedValue({
      inputDevices: [{ deviceId: '', kind: 'audioinput', label: 'Microphone' }],
      outputDevices: [{ deviceId: '', kind: 'audiooutput', label: 'Speaker' }],
    });

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.inputDevices).toHaveLength(1));
    expect(result.current.selectedInputDeviceId).toBeNull();
    expect(result.current.selectedOutputDeviceId).toBeNull();
  });

  it('distinguishes permission denial from other capture failures', async () => {
    for (const name of ['NotAllowedError', 'SecurityError']) {
      vi.mocked(requestAudioDevicePermission).mockRejectedValueOnce({
        message: 'Denied',
        name,
      });
      const denied = renderHook(() => useAudioDevices());
      await act(() => denied.result.current.requestPermission());
      expect(denied.result.current.permissionDenied).toBe(true);
      expect(denied.result.current.permissionError).toBeNull();
      denied.unmount();
    }

    const unavailable = new DOMException('Busy', 'NotReadableError');
    vi.mocked(requestAudioDevicePermission).mockRejectedValueOnce(unavailable);
    const failed = renderHook(() => useAudioDevices());
    await act(() => failed.result.current.requestPermission());
    expect(failed.result.current.permissionDenied).toBe(false);
    expect(failed.result.current.permissionError).toMatchObject({
      message: 'Busy',
      name: 'NotReadableError',
    });
  });

  it('requests permission only once during Strict Mode effect replay', async () => {
    const wrapper = ({ children }: React.PropsWithChildren) =>
      React.createElement(React.StrictMode, null, children);

    renderHook(() => useAudioDevices({ requestPermission: true }), { wrapper });

    await waitFor(() =>
      expect(requestAudioDevicePermission).toHaveBeenCalledTimes(1),
    );
  });

  it('uses a deterministic unsupported snapshot during server rendering', () => {
    const SupportProbe = () =>
      React.createElement('span', null, String(useAudioDevices().isSupported));

    expect(renderToString(React.createElement(SupportProbe))).toContain(
      'false',
    );
  });
});
