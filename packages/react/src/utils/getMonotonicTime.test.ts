import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMonotonicTime } from './getMonotonicTime';

describe('getMonotonicTime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to Date.now when performance.now throws', () => {
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => {
      throw new Error('performance clock unavailable');
    });
    vi.spyOn(Date, 'now').mockReturnValue(42);

    expect(getMonotonicTime()).toBe(42);
  });

  it('returns a numeric fallback when both host clocks throw', () => {
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => {
      throw new Error('performance clock unavailable');
    });
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('wall clock unavailable');
    });

    expect(getMonotonicTime()).toBe(0);
  });
});
