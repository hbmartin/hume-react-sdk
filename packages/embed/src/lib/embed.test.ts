import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbeddedVoice } from './embed';

const unmounts: Array<() => void> = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

const createMountedEmbed = (options?: {
  onReady?: () => void;
  openOnMount?: boolean;
  rendererUrl?: string;
}) => {
  const embeddedVoice = EmbeddedVoice.create({
    auth: { type: 'accessToken', value: 'test-token' },
    ...options,
  });
  const unmount = embeddedVoice.mount();
  unmounts.push(unmount);
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
  return { embeddedVoice, iframe, postMessage, unmount };
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

  it('reports readiness after applying a queued open request', () => {
    const onReady = vi.fn();
    const { embeddedVoice, iframe, postMessage } = createMountedEmbed({
      onReady,
    });
    embeddedVoice.openEmbed();

    dispatchReady(iframe);

    expect(getPostedActionTypes(postMessage.mock.calls as unknown[][])).toEqual(
      ['update_config', 'send_window_size', 'expand_widget_from_client'],
    );
    expect(onReady).toHaveBeenCalledOnce();
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

  it('can cancel configured open-on-mount for the current mount', () => {
    const { embeddedVoice, iframe, postMessage } = createMountedEmbed({
      openOnMount: true,
    });

    embeddedVoice.cancelPendingOpen();
    dispatchReady(iframe);

    expect(getPostedActionTypes(postMessage.mock.calls as unknown[][])).toEqual(
      ['update_config', 'send_window_size'],
    );
  });

  it('reattaches on a second mount without duplicate listeners', () => {
    const { embeddedVoice } = createMountedEmbed();

    unmounts.push(embeddedVoice.mount());
    const reattachedIframe = document.querySelector<HTMLIFrameElement>(
      '#hume-embedded-voice',
    );
    if (!reattachedIframe?.contentWindow) {
      throw new Error('Reattached embed did not create an iframe window.');
    }
    const postMessage = vi
      .spyOn(reattachedIframe.contentWindow, 'postMessage')
      .mockImplementation(() => undefined);
    dispatchReady(reattachedIframe);

    expect(getPostedActionTypes(postMessage.mock.calls as unknown[][])).toEqual(
      ['update_config', 'send_window_size'],
    );
  });

  it('reattaches after the iframe is detached externally', () => {
    const { embeddedVoice, iframe } = createMountedEmbed();
    iframe.remove();

    unmounts.push(embeddedVoice.mount());
    const reattachedIframe = document.querySelector<HTMLIFrameElement>(
      '#hume-embedded-voice',
    );
    if (!reattachedIframe?.contentWindow) {
      throw new Error('Reattached embed did not create an iframe window.');
    }
    const postMessage = vi
      .spyOn(reattachedIframe.contentWindow, 'postMessage')
      .mockImplementation(() => undefined);
    dispatchReady(reattachedIframe);

    expect(getPostedActionTypes(postMessage.mock.calls as unknown[][])).toEqual(
      ['update_config', 'send_window_size'],
    );
  });

  it('hides stale iframe content without changing a supplied container', () => {
    const container = document.createElement('div');
    container.style.pointerEvents = 'auto';
    document.body.appendChild(container);
    containers.push(container);
    const embeddedVoice = EmbeddedVoice.create({
      auth: { type: 'accessToken', value: 'test-token' },
    });
    const firstUnmount = embeddedVoice.mount(container);
    unmounts.push(firstUnmount);
    const iframe = container.querySelector<HTMLIFrameElement>(
      '#hume-embedded-voice',
    );
    if (!iframe) throw new Error('Embed did not mount its iframe.');
    expect(iframe.style.pointerEvents).toBe('none');
    expect(container.style.pointerEvents).toBe('auto');
    dispatchReady(iframe);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'resize_frame', payload: { width: 320, height: 480 } },
        origin: new URL(iframe.src).origin,
        source: iframe.contentWindow,
      }),
    );
    expect(iframe.style.opacity).toBe('1');
    expect(iframe.style.width).toBe('320px');
    expect(iframe.style.height).toBe('480px');
    expect(iframe.style.pointerEvents).toBe('auto');
    expect(container.style.pointerEvents).toBe('auto');

    firstUnmount();

    expect(iframe.isConnected).toBe(false);
    expect(container.style.pointerEvents).toBe('auto');

    unmounts.push(embeddedVoice.mount(container));
    expect(iframe.style.opacity).toBe('0');
    expect(iframe.style.width).toBe('0px');
    expect(iframe.style.height).toBe('0px');
    expect(iframe.style.pointerEvents).toBe('none');
    expect(container.style.pointerEvents).toBe('auto');
  });

  it('does not let multiple embeds overwrite a supplied container style', () => {
    const container = document.createElement('div');
    container.style.pointerEvents = 'painted';
    document.body.appendChild(container);
    containers.push(container);
    const first = EmbeddedVoice.create({
      auth: { type: 'accessToken', value: 'first-token' },
    });
    const second = EmbeddedVoice.create({
      auth: { type: 'accessToken', value: 'second-token' },
    });
    const firstUnmount = first.mount(container);
    const secondUnmount = second.mount(container);
    unmounts.push(firstUnmount, secondUnmount);

    const iframes = container.querySelectorAll<HTMLIFrameElement>(
      '#hume-embedded-voice',
    );
    dispatchReady(iframes.item(0));
    dispatchReady(iframes.item(1));
    firstUnmount();
    secondUnmount();

    expect(container.style.pointerEvents).toBe('painted');
  });

  it('continues unmounting when iframe removal fails', () => {
    const { iframe, unmount } = createMountedEmbed();
    const remove = vi.spyOn(iframe, 'remove').mockImplementationOnce(() => {
      throw new Error('remove failed');
    });

    expect(unmount).not.toThrow();
    expect(iframe.isConnected).toBe(false);

    remove.mockRestore();
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

  it('opens on every mount when openOnMount is configured', () => {
    const { embeddedVoice, iframe, postMessage } = createMountedEmbed({
      openOnMount: true,
    });
    dispatchReady(iframe);
    expect(getPostedActionTypes(postMessage.mock.calls as unknown[][])).toEqual(
      ['update_config', 'send_window_size', 'expand_widget_from_client'],
    );

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

    dispatchReady(remountedIframe);
    expect(
      getPostedActionTypes(remountedPostMessage.mock.calls as unknown[][]),
    ).toEqual([
      'update_config',
      'send_window_size',
      'expand_widget_from_client',
    ]);
  });

  it('opens only once when readiness is reported more than once', () => {
    const { iframe, postMessage } = createMountedEmbed({ openOnMount: true });

    dispatchReady(iframe);
    dispatchReady(iframe);

    expect(
      getPostedActionTypes(postMessage.mock.calls as unknown[][]).filter(
        (type) => type === 'expand_widget_from_client',
      ),
    ).toEqual(['expand_widget_from_client']);
  });

  it('rearms openOnMount after cancellation when the instance is remounted', () => {
    const { embeddedVoice, iframe } = createMountedEmbed({ openOnMount: true });
    embeddedVoice.cancelPendingOpen();
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
