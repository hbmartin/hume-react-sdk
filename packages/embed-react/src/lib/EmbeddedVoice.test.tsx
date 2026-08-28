import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EmbeddedVoice } from './EmbeddedVoice';

const embeddedVoiceMocks = vi.hoisted(() => ({
  create: vi.fn(),
  mount: vi.fn(),
  openEmbed: vi.fn(),
  unmount: vi.fn(),
}));

vi.mock('@humeai/voice-embed', () => ({
  EmbeddedVoice: {
    create: embeddedVoiceMocks.create,
  },
}));

type CreatedConfig = {
  auth: { type: 'accessToken'; value: string };
  onMessage?: (message: unknown) => void;
  onClose?: () => void;
  openOnMount?: boolean;
  rendererUrl?: string;
};

describe('EmbeddedVoice', () => {
  beforeEach(() => {
    embeddedVoiceMocks.mount.mockReturnValue(embeddedVoiceMocks.unmount);
    embeddedVoiceMocks.create.mockReturnValue({
      mount: embeddedVoiceMocks.mount,
      openEmbed: embeddedVoiceMocks.openEmbed,
    });
  });

  it('forwards messages and closes to the latest callbacks without remounting', () => {
    const firstOnMessage = vi.fn();
    const firstOnClose = vi.fn();
    const latestOnMessage = vi.fn();
    const latestOnClose = vi.fn();
    const auth = { type: 'accessToken' as const, value: 'token' };
    const { rerender } = render(
      <EmbeddedVoice
        auth={auth}
        isEmbedOpen={false}
        onClose={firstOnClose}
        onMessage={firstOnMessage}
      />,
    );
    const createdConfig = embeddedVoiceMocks.create.mock.calls[0]?.[0] as
      | CreatedConfig
      | undefined;

    rerender(
      <EmbeddedVoice
        auth={auth}
        isEmbedOpen={false}
        onClose={latestOnClose}
        onMessage={latestOnMessage}
      />,
    );
    act(() => {
      createdConfig?.onMessage?.({ type: 'user_message' });
      createdConfig?.onClose?.();
    });

    expect(embeddedVoiceMocks.create).toHaveBeenCalledOnce();
    expect(firstOnMessage).not.toHaveBeenCalled();
    expect(firstOnClose).not.toHaveBeenCalled();
    expect(latestOnMessage).toHaveBeenCalledOnce();
    expect(latestOnClose).toHaveBeenCalledOnce();
  });

  it('uses the latest configuration when openOnMount causes a remount', () => {
    const { rerender } = render(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'first-token' }}
        isEmbedOpen={false}
        rendererUrl="https://first.example.com"
      />,
    );

    rerender(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'latest-token' }}
        isEmbedOpen={false}
        openOnMount={true}
        rendererUrl="https://latest.example.com"
      />,
    );

    expect(embeddedVoiceMocks.unmount).toHaveBeenCalledOnce();
    expect(embeddedVoiceMocks.create).toHaveBeenCalledTimes(2);
    expect(embeddedVoiceMocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auth: { type: 'accessToken', value: 'latest-token' },
        openOnMount: true,
        rendererUrl: 'https://latest.example.com',
      }),
    );
  });

  it('opens an existing embed when isEmbedOpen becomes true', () => {
    const auth = { type: 'accessToken' as const, value: 'token' };
    const { rerender } = render(
      <EmbeddedVoice auth={auth} isEmbedOpen={false} />,
    );

    rerender(<EmbeddedVoice auth={auth} isEmbedOpen={true} />);

    expect(embeddedVoiceMocks.create).toHaveBeenCalledOnce();
    expect(embeddedVoiceMocks.openEmbed).toHaveBeenCalledOnce();
  });
});
