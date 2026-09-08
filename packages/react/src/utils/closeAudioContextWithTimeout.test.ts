import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeAudioContextWithTimeout } from './closeAudioContextWithTimeout';

const createContext = (close: () => Promise<void>) =>
  ({ close }) as unknown as AudioContext;

describe('closeAudioContextWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('attempts close when the context state is unreadable', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const context = Object.defineProperty({ close }, 'state', {
      get: () => {
        throw new Error('context state unavailable');
      },
    }) as unknown as AudioContext;

    await expect(closeAudioContextWithTimeout(context)).resolves.toEqual({
      success: true,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a close failure when the context state is unreadable', async () => {
    const closeError = new Error('context close failed');
    const close = vi.fn().mockRejectedValue(closeError);
    const context = Object.defineProperty({ close }, 'state', {
      get: () => {
        throw new Error('context state unavailable');
      },
    }) as unknown as AudioContext;

    await expect(closeAudioContextWithTimeout(context)).resolves.toMatchObject({
      success: false,
      error: { message: closeError.message, name: closeError.name },
      reason: 'rejected',
    });
  });

  it('does not close a context that is already closed', async () => {
    const close = vi.fn().mockRejectedValue(new Error('must not be called'));
    const context = { close, state: 'closed' } as unknown as AudioContext;

    await expect(closeAudioContextWithTimeout(context)).resolves.toEqual({
      success: true,
    });
    expect(close).not.toHaveBeenCalled();
  });

  it('reports a synchronous close failure even when close changed the public state', async () => {
    let state: AudioContextState = 'running';
    const closeError = new DOMException('Already closed', 'InvalidStateError');
    const close = vi.fn(() => {
      state = 'closed';
      throw closeError;
    });
    const context = {
      close,
      get state() {
        return state;
      },
    } as unknown as AudioContext;

    await expect(closeAudioContextWithTimeout(context)).resolves.toMatchObject({
      success: false,
      error: { message: closeError.message, name: closeError.name },
      reason: 'rejected',
    });
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

  it('reports a timeout after close changes state and later joins its completion', async () => {
    vi.useFakeTimers();
    let state: AudioContextState = 'running';
    let resolveClose: () => void = () => {
      throw new Error('Close promise was not initialized.');
    };
    const closeCompletion = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const close = vi.fn(() => {
      state = 'closed';
      return closeCompletion;
    });
    const context = {
      close,
      get state() {
        return state;
      },
    } as unknown as AudioContext;

    const firstClose = closeAudioContextWithTimeout(context);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(firstClose).resolves.toMatchObject({
      success: false,
      reason: 'timeout',
    });

    const joinedClose = closeAudioContextWithTimeout(context);
    resolveClose();
    await expect(joinedClose).resolves.toEqual({ success: true });
    expect(close).toHaveBeenCalledOnce();
  });
});
