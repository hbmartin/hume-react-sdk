import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const loadTokenModule = async () => {
  vi.resetModules();
  return import('./get-hume-access-token');
};

describe('getHumeAccessToken', () => {
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.stubEnv('HUME_API_KEY', 'api-key');
    vi.stubEnv('HUME_SECRET_KEY', 'secret-key');
    vi.stubEnv('NEXT_PUBLIC_HUME_VOICE_HOSTNAME', 'api.hume.ai');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('derives reuse and expiration durations from expires_in', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ access_token: 'first-token', expires_in: 1800 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { getHumeAccessToken } = await loadTokenModule();

    await expect(getHumeAccessToken()).resolves.toEqual({
      accessToken: 'first-token',
      expiresAfterMs: 1_800_000,
      refreshAfterMs: 1_500_000,
    });

    now += 60_000;
    await expect(getHumeAccessToken()).resolves.toEqual({
      accessToken: 'first-token',
      expiresAfterMs: 1_740_000,
      refreshAfterMs: 1_440_000,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.hume.ai/oauth2-cc/token',
      expect.objectContaining({
        body: 'grant_type=client_credentials',
        cache: 'no-store',
        method: 'POST',
      }),
    );
  });

  it('mints a new token when the measured reuse window ends', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: 'first-token', expires_in: 1800 }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: 'second-token', expires_in: 600 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { getHumeAccessToken } = await loadTokenModule();

    await getHumeAccessToken();
    now += 1_500_000;

    await expect(getHumeAccessToken()).resolves.toEqual({
      accessToken: 'second-token',
      expiresAfterMs: 600_000,
      refreshAfterMs: 500_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a response without expiration metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ access_token: 'token' })),
    );
    const { getHumeAccessToken } = await loadTokenModule();

    await expect(getHumeAccessToken()).rejects.toThrow(
      'without a valid expiration duration',
    );
  });
});
