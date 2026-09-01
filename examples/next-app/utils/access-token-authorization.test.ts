import { afterEach, describe, expect, it, vi } from 'vitest';

import { isHumeAccessTokenRequestAuthorized } from './access-token-authorization';

vi.mock('server-only', () => ({}));

describe('access-token authorization', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows the loopback development example', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(
      isHumeAccessTokenRequestAuthorized(
        new Request('http://127.0.0.1:3003/api/access-token'),
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

  it('fails closed when the environment is not explicitly development', () => {
    vi.stubEnv('NODE_ENV', 'test');

    expect(
      isHumeAccessTokenRequestAuthorized(
        new Request('http://127.0.0.1:3003/api/access-token'),
      ),
    ).toBe(false);
  });
});
