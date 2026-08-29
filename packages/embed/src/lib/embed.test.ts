import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbeddedVoice } from './embed';

const unmounts: Array<() => void> = [];

afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
});

const createMountedEmbed = (options?: {
  openOnMount?: boolean;
  rendererUrl?: string;
}) => {
  const embeddedVoice = EmbeddedVoice.create({
    auth: { type: 'accessToken', value: 'test-token' },
    ...options,
  });
  unmounts.push(embeddedVoice.mount());
  const iframes = document.querySelectorAll<HTMLIFrameElement>(
    '#hume-embedded-voice',
  );
  const iframe = iframes.item(iframes.length - 1);
  if (!iframe.contentWindow) {
    throw new Error('Mounted embed did not create an iframe window.');
  }
  const postMessage = vi
    .spyOn(iframe.contentWindow, 'postMessage')
    .mockImplementation(() => undefined);
  return { embeddedVoice, iframe, postMessage };
};

const dispatchReady = (iframe: HTMLIFrameElement) => {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'widget_iframe_is_ready' },
      origin: new URL(iframe.src).origin,
      source: iframe.contentWindow,
    }),
  );
};

const getPostedActionTypes = (calls: readonly (readonly unknown[])[]) =>
  calls.map((call) => {
    const action = call[0];
    if (
      typeof action !== 'object' ||
      action === null ||
      !('type' in action) ||
      typeof action.type !== 'string'
    ) {
      throw new Error('Embed posted an action without a string type.');
    }
    return action.type;
  });

describe('EmbeddedVoice', () => {
  it('accepts readiness messages only from its own iframe', () => {
    const first = createMountedEmbed({
      rendererUrl: 'https://voice-widget.hume.ai/first',
    });
    const second = createMountedEmbed({
      rendererUrl: 'https://voice-widget.hume.ai/second',
    });

    dispatchReady(first.iframe);

    expect(first.postMessage).toHaveBeenCalledTimes(2);
    expect(second.postMessage).not.toHaveBeenCalled();
  });

  it('sends configuration before a queued open request', () => {
    const { embeddedVoice, iframe, postMessage } = createMountedEmbed();

    embeddedVoice.openEmbed();
    expect(postMessage).not.toHaveBeenCalled();

    dispatchReady(iframe);

    expect(getPostedActionTypes(postMessage.mock.calls as unknown[][])).toEqual(
      ['update_config', 'send_window_size', 'expand_widget_from_client'],
    );
  });

  it('can cancel an open request queued before readiness', () => {
    const { embeddedVoice, iframe, postMessage } = createMountedEmbed();
    embeddedVoice.openEmbed();

    embeddedVoice.cancelPendingOpen();
    dispatchReady(iframe);

    expect(getPostedActionTypes(postMessage.mock.calls as unknown[][])).toEqual(
      ['update_config', 'send_window_size'],
    );
  });

  it('waits for fresh readiness after remounting the same instance', () => {
    const { embeddedVoice, iframe } = createMountedEmbed();
    dispatchReady(iframe);
    const firstUnmount = unmounts.at(-1);
    firstUnmount?.();

    unmounts.push(embeddedVoice.mount());
    const remountedIframe = document.querySelector<HTMLIFrameElement>(
      '#hume-embedded-voice',
    );
    if (!remountedIframe?.contentWindow) {
      throw new Error('Remounted embed did not create an iframe window.');
    }
    const remountedPostMessage = vi
      .spyOn(remountedIframe.contentWindow, 'postMessage')
      .mockImplementation(() => undefined);

    embeddedVoice.openEmbed();
    expect(remountedPostMessage).not.toHaveBeenCalled();

    dispatchReady(remountedIframe);
    expect(
      getPostedActionTypes(remountedPostMessage.mock.calls as unknown[][]),
    ).toEqual([
      'update_config',
      'send_window_size',
      'expand_widget_from_client',
    ]);
  });

  it('resolves relative renderer URLs through the iframe', () => {
    const { iframe } = createMountedEmbed({ rendererUrl: '/voice-widget' });

    expect(iframe.src).toBe(
      new URL('/voice-widget', window.location.href).href,
    );
  });
});
