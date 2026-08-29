import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EmbeddedVoice } from './EmbeddedVoice';

const embeddedVoiceMocks = vi.hoisted(() => ({
  cancelPendingOpen: vi.fn(),
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
      cancelPendingOpen: embeddedVoiceMocks.cancelPendingOpen,
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

  it('recreates the embed when authentication or configuration changes', () => {
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
        openOnMount: false,
        rendererUrl: 'https://latest.example.com',
      }),
    );
  });

  it('reopens a recreated embed when controlled open state remains true', () => {
    const { rerender } = render(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'first-token' }}
        isEmbedOpen={true}
      />,
    );

    rerender(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'latest-token' }}
        isEmbedOpen={true}
      />,
    );

    expect(embeddedVoiceMocks.create).toHaveBeenCalledTimes(2);
    expect(embeddedVoiceMocks.openEmbed).toHaveBeenCalledTimes(2);
  });

  it('does not reapply openOnMount when configuration recreates the embed', () => {
    const { rerender } = render(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'first-token' }}
        isEmbedOpen={false}
        openOnMount={true}
      />,
    );

    rerender(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'latest-token' }}
        isEmbedOpen={false}
        openOnMount={true}
      />,
    );

    expect(embeddedVoiceMocks.create).toHaveBeenCalledTimes(2);
    expect(embeddedVoiceMocks.create.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ openOnMount: true }),
    );
    expect(embeddedVoiceMocks.create.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ openOnMount: false }),
    );
  });

  it('preserves openOnMount through Strict Mode effect replay', () => {
    render(
      <StrictMode>
        <EmbeddedVoice
          auth={{ type: 'accessToken', value: 'token' }}
          isEmbedOpen={false}
          openOnMount={true}
        />
      </StrictMode>,
    );

    expect(embeddedVoiceMocks.create).toHaveBeenCalledTimes(2);
    expect(embeddedVoiceMocks.create.mock.calls).toEqual([
      [expect.objectContaining({ openOnMount: true })],
      [expect.objectContaining({ openOnMount: true })],
    ]);
  });

  it('does not cancel openOnMount on a replacement embed', () => {
    const { rerender } = render(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'first-token' }}
        isEmbedOpen={true}
        openOnMount={true}
      />,
    );

    rerender(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'latest-token' }}
        isEmbedOpen={false}
        openOnMount={true}
      />,
    );

    expect(embeddedVoiceMocks.create).toHaveBeenCalledTimes(2);
    expect(embeddedVoiceMocks.cancelPendingOpen).not.toHaveBeenCalled();
  });

  it('does not recreate for semantically unchanged configuration objects', () => {
    const { rerender } = render(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'token' }}
        isEmbedOpen={false}
        queryParams={{ feature: ['one', 'two'] }}
      />,
    );

    rerender(
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: 'token' }}
        isEmbedOpen={false}
        queryParams={{ feature: ['one', 'two'] }}
      />,
    );

    expect(embeddedVoiceMocks.create).toHaveBeenCalledOnce();
    expect(embeddedVoiceMocks.unmount).not.toHaveBeenCalled();
  });

  it('passes relative and malformed renderer URLs through without parsing them', () => {
    const auth = { type: 'accessToken' as const, value: 'token' };
    const { unmount } = render(
      <EmbeddedVoice
        auth={auth}
        isEmbedOpen={false}
        rendererUrl="/voice-widget"
      />,
    );

    expect(embeddedVoiceMocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ rendererUrl: '/voice-widget' }),
    );

    unmount();
    render(
      <EmbeddedVoice
        auth={auth}
        isEmbedOpen={false}
        rendererUrl="not a valid absolute URL"
      />,
    );

    expect(embeddedVoiceMocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ rendererUrl: 'not a valid absolute URL' }),
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

  it('does not recreate the embed when openOnMount changes', () => {
    const auth = { type: 'accessToken' as const, value: 'token' };
    const { rerender } = render(
      <EmbeddedVoice auth={auth} isEmbedOpen={true} openOnMount={true} />,
    );

    expect(embeddedVoiceMocks.openEmbed).toHaveBeenCalledOnce();

    rerender(
      <EmbeddedVoice auth={auth} isEmbedOpen={true} openOnMount={false} />,
    );

    expect(embeddedVoiceMocks.create).toHaveBeenCalledOnce();
    expect(embeddedVoiceMocks.unmount).not.toHaveBeenCalled();
    expect(embeddedVoiceMocks.openEmbed).toHaveBeenCalledOnce();
  });

  it('opens from an external trigger while openOnMount remains enabled', () => {
    const auth = { type: 'accessToken' as const, value: 'token' };
    const { rerender } = render(
      <EmbeddedVoice auth={auth} isEmbedOpen={false} openOnMount={true} />,
    );

    expect(embeddedVoiceMocks.openEmbed).not.toHaveBeenCalled();

    rerender(
      <EmbeddedVoice auth={auth} isEmbedOpen={true} openOnMount={true} />,
    );

    expect(embeddedVoiceMocks.openEmbed).toHaveBeenCalledOnce();
  });

  it('cancels an opening queued before iframe readiness', () => {
    const auth = { type: 'accessToken' as const, value: 'token' };
    const { rerender } = render(
      <EmbeddedVoice auth={auth} isEmbedOpen={true} />,
    );

    rerender(<EmbeddedVoice auth={auth} isEmbedOpen={false} />);

    expect(embeddedVoiceMocks.cancelPendingOpen).toHaveBeenCalledOnce();
  });
});
