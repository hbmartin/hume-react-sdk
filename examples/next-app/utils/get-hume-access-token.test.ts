import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getServerMonotonicTime: vi.fn<() => number>(),
}));

vi.mock('./server-monotonic-time', () => ({
  getServerMonotonicTime: mocks.getServerMonotonicTime,
}));

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
    vi.stubEnv('HUME_TOKEN_HOSTNAME', 'api.hume.ai');
    vi.stubEnv('NEXT_PUBLIC_HUME_VOICE_HOSTNAME', 'browser.example.test');
    mocks.getServerMonotonicTime.mockReset().mockImplementation(() => now);
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

  it('does not cache a non-OK OAuth response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ access_token: 'retry-token', expires_in: 600 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { getHumeAccessToken } = await loadTokenModule();

    await expect(getHumeAccessToken()).rejects.toThrow(
      'Hume rejected the access-token request with status 401.',
    );
    await expect(getHumeAccessToken()).resolves.toEqual({
      accessToken: 'retry-token',
      expiresAfterMs: 600_000,
      refreshAfterMs: 500_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one successful request between concurrent callers', async () => {
    let resolveResponse: (response: Response) => void = (_response) => {
      throw new Error('The OAuth response promise was not initialized.');
    };
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(responsePromise);
    vi.stubGlobal('fetch', fetchMock);
    const { getHumeAccessToken } = await loadTokenModule();

    const firstRequest = getHumeAccessToken();
    const concurrentRequest = getHumeAccessToken();

    expect(fetchMock).toHaveBeenCalledOnce();
    resolveResponse(
      Response.json({ access_token: 'shared-token', expires_in: 600 }),
    );
    await expect(
      Promise.all([firstRequest, concurrentRequest]),
    ).resolves.toEqual([
      {
        accessToken: 'shared-token',
        expiresAfterMs: 600_000,
        refreshAfterMs: 500_000,
      },
      {
        accessToken: 'shared-token',
        expiresAfterMs: 600_000,
        refreshAfterMs: 500_000,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('subtracts OAuth request latency from the returned token lifetime', async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      now += 4_000;
      return Promise.resolve(
        Response.json({ access_token: 'delayed-token', expires_in: 1800 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getHumeAccessToken } = await loadTokenModule();

    await expect(getHumeAccessToken()).resolves.toEqual({
      accessToken: 'delayed-token',
      expiresAfterMs: 1_796_000,
      refreshAfterMs: 1_496_000,
    });
  });

  it('does not extend token deadlines when the wall clock moves backward', async () => {
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fetchMock = vi.fn().mockImplementation(() => {
      now += 4_000;
      wallClock.mockReturnValue(996_000);
      return Promise.resolve(
        Response.json({ access_token: 'monotonic-token', expires_in: 1800 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getHumeAccessToken } = await loadTokenModule();

    await expect(getHumeAccessToken()).resolves.toEqual({
      accessToken: 'monotonic-token',
      expiresAfterMs: 1_796_000,
      refreshAfterMs: 1_496_000,
    });
  });

  it("rejects an expiration beyond Hume's documented 30-minute lifetime", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          access_token: 'token',
          expires_in: 1801,
        }),
      ),
    );
    const { getHumeAccessToken } = await loadTokenModule();

    await expect(getHumeAccessToken()).rejects.toThrow(
      'without a valid expiration duration',
    );
  });

  it('uses only the canonical server-side token hostname for credentials', async () => {
    vi.stubEnv('HUME_TOKEN_HOSTNAME', 'Voice.Staging.Hume.AI:8443');
    vi.stubEnv('NEXT_PUBLIC_HUME_VOICE_HOSTNAME', 'attacker.example');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ access_token: 'token', expires_in: 1800 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { getHumeAccessToken } = await loadTokenModule();

    await getHumeAccessToken();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://voice.staging.hume.ai:8443/oauth2-cc/token',
      expect.any(Object),
    );
  });

  it('rejects an invalid server-side token hostname before sending credentials', async () => {
    vi.stubEnv('HUME_TOKEN_HOSTNAME', 'api.hume.ai@attacker.example');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getHumeAccessToken } = await loadTokenModule();

    await expect(getHumeAccessToken()).rejects.toThrow(
      'HUME_TOKEN_HOSTNAME must be a hostname',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears a timed-out shared request so a later call can retry', async () => {
    const firstController = new AbortController();
    const retryController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(firstController.signal)
      .mockReturnValueOnce(retryController.signal);
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_input: RequestInfo | URL, init: RequestInit | undefined) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            return Promise.reject(new Error('Expected an abort signal.'));
          }

          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        },
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: 'retry-token', expires_in: 600 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { getHumeAccessToken } = await loadTokenModule();

    const firstRequest = getHumeAccessToken();
    const concurrentRequest = getHumeAccessToken();
    const sharedResults = Promise.allSettled([firstRequest, concurrentRequest]);
    const timeoutError = new Error('Token request timed out.');

    firstController.abort(timeoutError);

    await expect(sharedResults).resolves.toEqual([
      { status: 'rejected', reason: timeoutError },
      { status: 'rejected', reason: timeoutError },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);

    await expect(getHumeAccessToken()).resolves.toEqual({
      accessToken: 'retry-token',
      expiresAfterMs: 600_000,
      refreshAfterMs: 500_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
  });
});
