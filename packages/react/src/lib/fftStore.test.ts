import { afterEach, expect, it, vi } from 'vitest';

import { FftStore } from './fftStore';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('does not accept writes after destruction', () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextAnimationId = 0;
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    nextAnimationId += 1;
    callbacks.set(nextAnimationId, callback);
    return nextAnimationId;
  });
  const cancelAnimationFrame = vi.fn((animationId: number) => {
    callbacks.delete(animationId);
  });
  vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
  const store = new FftStore();

  store.write([1]);
  store.destroy();
  store.write([2]);

  expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
  expect(callbacks.has(1)).toBe(false);
  expect(store.getSnapshot()[0]).toBe(0);
});

it('does not retain subscribers added after destruction', () => {
  const store = new FftStore();
  const listener = vi.fn();

  store.destroy();
  const unsubscribe = store.subscribe(listener);
  store.clear();
  unsubscribe();

  expect(listener).not.toHaveBeenCalled();
});
