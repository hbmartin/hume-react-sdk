import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getHumeAccessToken: vi.fn(),
  isAuthorized: vi.fn(),
}));

vi.mock('../../../utils/access-token-authorization', () => ({
  isHumeAccessTokenRequestAuthorized: mocks.isAuthorized,
}));
vi.mock('../../../utils/get-hume-access-token', () => ({
  getHumeAccessToken: mocks.getHumeAccessToken,
  MissingHumeCredentialsError: class MissingHumeCredentialsError extends Error {},
}));

import { POST } from './route';

describe('POST /api/access-token', () => {
  beforeEach(() => {
    mocks.getHumeAccessToken.mockReset();
    mocks.isAuthorized.mockReset();
  });

  it('rejects unauthorized callers before consulting the token cache', async () => {
    mocks.isAuthorized.mockReturnValue(false);

    const response = await POST(
      new Request('https://example.com/api/access-token?forged=same-origin', {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error:
        'This reference endpoint is disabled in production until the application adds user authentication and authorization.',
    });
    expect(mocks.getHumeAccessToken).not.toHaveBeenCalled();
  });

  it('returns a measured token lease to an authorized local caller', async () => {
    mocks.isAuthorized.mockReturnValue(true);
    mocks.getHumeAccessToken.mockResolvedValue({
      accessToken: 'token',
      expiresAfterMs: 1_800_000,
      refreshAfterMs: 1_500_000,
    });

    const response = await POST(
      new Request('http://127.0.0.1:3003/api/access-token', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      accessToken: 'token',
      expiresAfterMs: 1_800_000,
      refreshAfterMs: 1_500_000,
    });
    expect(mocks.getHumeAccessToken).toHaveBeenCalledOnce();
  });
});
