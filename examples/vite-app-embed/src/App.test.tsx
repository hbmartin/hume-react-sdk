import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';

const embed = vi.hoisted<{
  props: Record<string, unknown> | undefined;
}>(() => ({ props: undefined }));

vi.mock('@humeai/voice-embed-react', () => ({
  EmbeddedVoice: (props: Record<string, unknown>) => {
    embed.props = props;
    return <div data-testid="embedded-voice" />;
  },
}));

const isCallback = (value: unknown): value is () => void =>
  typeof value === 'function';

describe('embedded Vite example', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    embed.props = undefined;
    vi.unstubAllEnvs();
  });

  it('passes configured connection values and URL launch state', () => {
    window.history.replaceState({}, '', '/?launchWidget=true');
    vi.stubEnv('VITE_PUBLIC_HUME_API_KEY', 'test-key');
    vi.stubEnv('VITE_PUBLIC_RENDERER_URL', 'https://renderer.example/');
    vi.stubEnv('VITE_PUBLIC_HOSTNAME', 'api.example');

    act(() => root.render(<App />));

    expect(embed.props).toMatchObject({
      auth: { type: 'apiKey', value: 'test-key' },
      hostname: 'api.example',
      isEmbedOpen: false,
      openOnMount: true,
      rendererUrl: 'https://renderer.example/',
    });
  });

  it('opens and closes the widget', () => {
    window.history.replaceState({}, '', '/');
    act(() => root.render(<App />));

    const button = container.querySelector('button');
    if (button === null) throw new Error('Missing open button');
    act(() => button.click());
    expect(embed.props?.['isEmbedOpen']).toBe(true);

    const onClose = embed.props?.['onClose'];
    if (!isCallback(onClose)) throw new Error('Missing close handler');
    act(() => onClose());
    expect(embed.props?.['isEmbedOpen']).toBe(false);
  });
});
