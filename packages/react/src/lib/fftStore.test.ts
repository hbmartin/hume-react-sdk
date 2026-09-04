import { afterEach, expect, it, vi } from 'vitest';

import { FftStore } from './fftStore';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('resets pending work and remains reusable after destruction', () => {
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
  expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  expect(callbacks.has(1)).toBe(false);
  callbacks.get(2)?.(0);
  expect(store.getSnapshot()[0]).toBe(2);
});

it('accepts new subscribers after destruction', () => {
  let flush: FrameRequestCallback | undefined;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      flush = callback;
      return 1;
    }),
  );
  const store = new FftStore();
  const listener = vi.fn();

  store.destroy();
  const unsubscribe = store.subscribe(listener);
  store.write([1]);
  flush?.(0);
  unsubscribe();

  expect(listener).toHaveBeenCalledOnce();
  expect(store.getSnapshot()[0]).toBe(1);
});

it('retains existing subscribers across destruction', () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextAnimationId = 0;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      nextAnimationId += 1;
      callbacks.set(nextAnimationId, callback);
      return nextAnimationId;
    }),
  );
  const store = new FftStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);

  store.write([1]);
  callbacks.get(1)?.(0);
  store.destroy();
  expect(listener).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot()[0]).toBe(0);

  store.write([2]);
  callbacks.get(2)?.(0);
  unsubscribe();

  expect(listener).toHaveBeenCalledTimes(3);
  expect(store.getSnapshot()[0]).toBe(2);
});
