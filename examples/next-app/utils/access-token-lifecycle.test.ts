import { describe, expect, it } from 'vitest';

import {
  createAccessTokenLease,
  isAccessTokenLeaseUsable,
} from './access-token-lifecycle';

describe('access-token lifecycle', () => {
  it('uses relative durations and a monotonic client clock', () => {
    const scheduled = createAccessTokenLease(
      {
        accessToken: 'token',
        expiresAfterMs: 30 * 60 * 1000,
        refreshAfterMs: 25 * 60 * 1000,
      },
      500,
      1_500,
    );

    expect(scheduled).toEqual({
      lease: {
        accessToken: 'token',
        expiresAt: 1_800_500,
      },
      refreshAfterMs: 1_499_000,
    });
    expect(isAccessTokenLeaseUsable(scheduled?.lease ?? null, 1_800_499)).toBe(
      true,
    );
    expect(isAccessTokenLeaseUsable(scheduled?.lease ?? null, 1_800_500)).toBe(
      false,
    );
  });

  it('rejects a token that expired before its response arrived', () => {
    expect(
      createAccessTokenLease(
        {
          accessToken: 'expired-token',
          expiresAfterMs: 1_000,
          refreshAfterMs: 500,
        },
        1_000,
        2_000,
      ),
    ).toBeNull();
  });
});
