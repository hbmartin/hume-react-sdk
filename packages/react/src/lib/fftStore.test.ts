import { afterEach, expect, it, vi } from 'vitest';

import { FftStore } from './fftStore';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('can schedule a new flush after destroying a pending write', () => {
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
  callbacks.get(2)?.(0);
  expect(store.getSnapshot()[0]).toBe(2);
});
