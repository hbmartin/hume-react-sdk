import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const client = {
    connect: vi.fn(),
    on: vi.fn(),
  };
  const constructor = vi.fn();
  return {
    client,
    constructor,
    HumeClient: class {
      empathicVoice = { chat: { connect: () => client } };

      constructor(options: unknown) {
        constructor(options);
      }
    },
  };
});

vi.mock('hume', () => ({ HumeClient: mocks.HumeClient }));

const isMessageHandler = (
  value: unknown,
): value is (message?: unknown) => void => typeof value === 'function';

const getHandler = (event: string) => {
  const registration = mocks.client.on.mock.calls.find(
    ([registeredEvent]) => registeredEvent === event,
  );
  if (registration === undefined) throw new Error(`Missing ${event} handler`);
  const handler: unknown = registration[1];
  if (!isMessageHandler(handler)) throw new Error(`Invalid ${event} handler`);
  return handler;
};

describe('Vite SDK example', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('shows a useful error when the API key is absent', async () => {
    vi.stubEnv('VITE_HUME_API_KEY', '');

    await expect(import('./main')).rejects.toThrow(
      'VITE_HUME_API_KEY is not set',
    );
    expect(document.body.textContent).toContain(
      'Connection State: VITE_HUME_API_KEY is not set',
    );
  });

  it('connects and renders connection and message events as text', async () => {
    vi.stubEnv('VITE_HUME_API_KEY', 'test-key');

    await import('./main');
    expect(mocks.constructor).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(mocks.client.connect).toHaveBeenCalledOnce();

    getHandler('open')();
    expect(document.body.textContent).toContain('Connection State: connected');

    getHandler('message')({
      type: 'user_message',
      message: { role: 'user', content: '<script>unsafe()</script>' },
    });
    expect(document.body.textContent).toContain('<script>unsafe()</script>');
    expect(document.body.querySelector('script')).toBeNull();

    getHandler('message')({ type: 'audio_output' });
    expect(document.body.textContent).toContain('<Audio Blob>');

    getHandler('close')();
    expect(document.body.textContent).toContain(
      'Connection State: disconnected',
    );
  });
});
