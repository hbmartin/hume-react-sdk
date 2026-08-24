import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeAudioContextWithTimeout } from './closeAudioContextWithTimeout';

const createContext = (close: () => Promise<void>) =>
  ({ close }) as unknown as AudioContext;

describe('closeAudioContextWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when the context closes', async () => {
    const close = vi.fn().mockResolvedValue(undefined);

    await expect(
      closeAudioContextWithTimeout(createContext(close)),
    ).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledOnce();
  });

  it('swallows synchronous throws and rejected close promises', async () => {
    const synchronousClose = vi.fn(() => {
      throw new DOMException('Already closed', 'InvalidStateError');
    });
    const rejectedClose = vi
      .fn()
      .mockRejectedValue(
        new DOMException('Already closed', 'InvalidStateError'),
      );

    await expect(
      closeAudioContextWithTimeout(createContext(synchronousClose)),
    ).resolves.toBeUndefined();
    await expect(
      closeAudioContextWithTimeout(createContext(rejectedClose)),
    ).resolves.toBeUndefined();
  });

  it('resolves after one second when close never settles', async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => new Promise<void>(() => {}));
    let settled = false;

    const closing = closeAudioContextWithTimeout(createContext(close)).then(
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(settled).toBe(true);
  });
});
