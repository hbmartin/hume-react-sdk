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
    ).resolves.toEqual({ success: true });

    expect(close).toHaveBeenCalledOnce();
  });

  it('reports synchronous throws and rejected close promises', async () => {
    const synchronousClose = vi.fn(() => {
      throw new DOMException('Already closed', 'InvalidStateError');
    });
    const rejectedClose = vi
      .fn()
      .mockRejectedValue(
        new DOMException('Already closed', 'InvalidStateError'),
      );

    const synchronousResult = await closeAudioContextWithTimeout(
      createContext(synchronousClose),
    );
    const rejectedResult = await closeAudioContextWithTimeout(
      createContext(rejectedClose),
    );

    expect(synchronousResult.success).toBe(false);
    expect(rejectedResult.success).toBe(false);
    if (synchronousResult.success || rejectedResult.success) {
      throw new Error('Expected both audio context closes to fail.');
    }
    expect(synchronousResult.error.message).toBe('Already closed');
    expect(rejectedResult.error.message).toBe('Already closed');
    expect(synchronousResult.reason).toBe('rejected');
    expect(rejectedResult.reason).toBe('rejected');
  });

  it('normalizes an empty cross-realm-shaped rejection', async () => {
    const close = vi.fn().mockRejectedValue({
      message: ' \n ',
      name: 'InvalidStateError',
    });

    const result = await closeAudioContextWithTimeout(createContext(close));

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected audio context close to fail.');
    }
    expect(result.error).toMatchObject({
      message: 'Unknown audio context error',
      name: 'InvalidStateError',
    });
    expect(result.reason).toBe('rejected');
  });

  it('resolves after one second when close never settles', async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => new Promise<void>(() => {}));
    let settled = false;

    const closing = closeAudioContextWithTimeout(createContext(close)).then(
      (result) => {
        settled = true;
        return result;
      },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await closing;
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected the audio context close to time out.');
    }
    expect(result.error.message).toBe('Audio context close timed out.');
    expect(result.reason).toBe('timeout');
    expect(settled).toBe(true);
  });
});
