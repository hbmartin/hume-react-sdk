// cspell:ignore ehume zckzah
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadHumeModule = async () => {
  vi.resetModules();
  return import('./hume');
};

describe('HUME_VOICE_HOSTNAME', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['', '   '])('uses the default for %j', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_HUME_VOICE_HOSTNAME', value);

    await expect(loadHumeModule()).resolves.toMatchObject({
      HUME_VOICE_HOSTNAME: 'api.hume.ai',
    });
  });

  it.each([
    ['  Voice.Staging.Hume.AI  ', 'voice.staging.hume.ai'],
    ['例え.テスト', 'xn--r8jz45g.xn--zckzah'],
    ['[::1]', '[::1]'],
    ['api.hume.ai:443', 'api.hume.ai'],
    ['api.hume.ai:8443', 'api.hume.ai:8443'],
    ['[::1]:8443', '[::1]:8443'],
  ])('normalizes configured hostname %j', async (value, expected) => {
    vi.stubEnv('NEXT_PUBLIC_HUME_VOICE_HOSTNAME', value);

    await expect(loadHumeModule()).resolves.toMatchObject({
      HUME_VOICE_HOSTNAME: expected,
    });
  });

  it.each([
    'https://api.hume.ai',
    '@api.hume.ai',
    'user@api.hume.ai',
    'api.hume.ai/oauth2-cc/token',
    'api.hume.ai?environment=staging',
    'api.hume.ai#fragment',
    'api.hume.ai\\alternate',
    'api%2ehume.ai',
  ])('reports URL-like configured value %j without throwing', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_HUME_VOICE_HOSTNAME', value);

    const hume = await loadHumeModule();

    expect(hume.HUME_VOICE_HOSTNAME).toBeNull();
    expect(hume.HUME_VOICE_HOSTNAME_ERROR).toContain(
      'NEXT_PUBLIC_HUME_VOICE_HOSTNAME must be a hostname',
    );
  });
});
