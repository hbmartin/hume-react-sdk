import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCallDuration } from './useCallDuration';

describe('useCallDuration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes elapsed time and stops advancing on request', async () => {
    const { result } = renderHook(() => useCallDuration());
    const listener = vi.fn();
    const unsubscribe = result.current.store.subscribe(listener);

    act(() => result.current.start());
    expect(result.current.store.getSnapshot()).toBe('00:00:00');

    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(result.current.store.getSnapshot()).toBe('00:00:01');

    act(() => result.current.stop());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.store.getSnapshot()).toBe('00:00:01');

    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clears a running timer when unmounted', () => {
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const { result, unmount } = renderHook(() => useCallDuration());

    act(() => result.current.start());
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });
});
