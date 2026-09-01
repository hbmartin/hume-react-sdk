import { afterEach, describe, expect, it, vi } from 'vitest';

import { isHumeAccessTokenRequestAuthorized } from './access-token-authorization';

vi.mock('server-only', () => ({}));

describe('access-token authorization', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    'http://127.0.0.1:3003',
    'http://localhost:3003',
    'http://[::1]:3003',
  ])('allows the loopback development origin %s', (origin) => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(
      isHumeAccessTokenRequestAuthorized(
        new Request(`${origin}/api/access-token`, {
          headers: {
            Origin: origin,
            'Sec-Fetch-Site': 'same-origin',
          },
        }),
      ),
    ).toBe(true);
  });

  it('fails closed in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(
      isHumeAccessTokenRequestAuthorized(
        new Request('https://example.com/api/access-token'),
      ),
    ).toBe(false);
  });

  it('rejects a non-loopback request in development', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(
      isHumeAccessTokenRequestAuthorized(
        new Request('https://tunnel.example/api/access-token'),
      ),
    ).toBe(false);
  });

  it('rejects a cross-origin page targeting the loopback endpoint', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(
      isHumeAccessTokenRequestAuthorized(
        new Request('http://127.0.0.1:3003/api/access-token', {
          headers: {
            Origin: 'https://attacker.example',
            'Sec-Fetch-Site': 'cross-site',
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a request without a browser origin', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(
      isHumeAccessTokenRequestAuthorized(
        new Request('http://127.0.0.1:3003/api/access-token'),
      ),
    ).toBe(false);
  });

  it('fails closed when the environment is not explicitly development', () => {
    vi.stubEnv('NODE_ENV', 'test');

    expect(
      isHumeAccessTokenRequestAuthorized(
        new Request('http://127.0.0.1:3003/api/access-token', {
          headers: { Origin: 'http://127.0.0.1:3003' },
        }),
      ),
    ).toBe(false);
  });
});
