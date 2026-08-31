export type AccessTokenLeaseResponse = {
  accessToken: string;
  expiresAfterMs: number;
  refreshAfterMs: number;
};

export type AccessTokenLease = {
  accessToken: string;
  expiresAt: number;
};

export type ScheduledAccessTokenLease = {
  lease: AccessTokenLease;
  refreshAfterMs: number;
};

/**
 * Convert server-relative durations to client-monotonic deadlines. Subtracting
 * the full request duration is deliberately conservative and avoids comparing
 * clocks from different machines.
 */
export const createAccessTokenLease = (
  response: AccessTokenLeaseResponse,
  requestStartedAt: number,
  responseReceivedAt: number,
): ScheduledAccessTokenLease | null => {
  const requestDuration = Math.max(0, responseReceivedAt - requestStartedAt);
  const expiresAfterMs = response.expiresAfterMs - requestDuration;
  if (expiresAfterMs <= 0) return null;

  return {
    lease: {
      accessToken: response.accessToken,
      expiresAt: responseReceivedAt + expiresAfterMs,
    },
    refreshAfterMs: Math.max(
      0,
      Math.min(response.refreshAfterMs - requestDuration, expiresAfterMs),
    ),
  };
};

export const isAccessTokenLeaseUsable = (
  lease: AccessTokenLease | null,
  now: number,
) => lease !== null && lease.expiresAt > now;
