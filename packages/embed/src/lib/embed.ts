import type { Hume } from 'hume';

import {
  type ClientToFrameAction,
  EXPAND_FROM_CLIENT_ACTION,
  FrameToClientActionSchema,
  SEND_WINDOW_SIZE_ACTION,
  type SocketConfig,
  UPDATE_CONFIG_ACTION,
  WIDGET_IFRAME_IS_READY_ACTION,
} from './embed-messages';

/** Widget options, combined with the socket credentials to forward to it. */
export type EmbeddedVoiceConfig = {
  /**
   * Where the widget is hosted. Defaults to `https://voice-widget.hume.ai`.
   */
  rendererUrl?: string;
  /**
   * Accessible title for the widget iframe. Defaults to
   * `Hume Empathic Voice Widget`.
   */
  iframeTitle?: string;
} & SocketConfig;

/** Receives user and assistant transcripts as the conversation proceeds. */
export type TranscriptMessageHandler = (
  message: Hume.empathicVoice.UserMessage | Hume.empathicVoice.AssistantMessage,
) => void;

/** Called when the user collapses the widget. */
export type CloseHandler = () => void;

/** Called after the widget iframe reports that it is ready. */
export type ReadyHandler = () => void;

/** Runs one teardown step and records a failure without stopping later cleanup. */
function runTeardownStep(step: () => void, errors: unknown[]): boolean {
  try {
    step();
    return true;
  } catch (error) {
    errors.push(error);
    return false;
  }
}

/** Throws teardown failures after every cleanup step has had a chance to run. */
function throwTeardownErrors(errors: unknown[], message: string) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

/** Removes an element, falling back to its parent when `Element.remove` fails. */
function removeElement(element: HTMLElement) {
  const errors: unknown[] = [];
  runTeardownStep(() => {
    element.remove();
  }, errors);
  if (isDetached(element)) return;

  const parent = element.parentNode;
  if (parent === null) return;
  runTeardownStep(() => {
    parent.removeChild(element);
  }, errors);
  if (isDetached(element)) return;

  if (errors.length === 0) {
    errors.push(new Error('The element remained attached after removal.'));
  }
  throwTeardownErrors(errors, 'Unable to remove the embedded voice element.');
}

/** @returns Whether an element has no DOM parent, including in detached trees. */
function isDetached(element: HTMLElement): boolean {
  return element.parentNode === null;
}

/**
 * Hume's hosted voice widget, embedded in an iframe.
 *
 * Create an instance with {@link EmbeddedVoice.create}, then call
 * {@link EmbeddedVoice.mount} to attach it to the page. The iframe owns the
 * EVI connection, the microphone, and audio playback.
 *
 * @example
 * ```ts
 * const widget = EmbeddedVoice.create({
 *   auth: { type: 'accessToken', value: accessToken },
 *   onMessage: (message) => console.log(message),
 * });
 *
 * const unmount = widget.mount();
 * widget.openEmbed();
 * ```
 */
export class EmbeddedVoice {
  private iframe: HTMLIFrameElement;

  private config: EmbeddedVoiceConfig;

  private onMessage: TranscriptMessageHandler;

  private onClose: CloseHandler;

  private onReady: ReadyHandler;

  private isReady: boolean = false;

  private readonly openOnMount: boolean;

  private shouldOpenWhenReady: boolean = false;

  private unmountActiveMount: (() => void) | null = null;

  private constructor({
    onMessage = () => {},
    onClose = () => {},
    onReady = () => {},
    openOnMount,
    ...config
  }: {
    onMessage?: TranscriptMessageHandler;
    onClose?: CloseHandler;
    onReady?: ReadyHandler;
    openOnMount?: boolean;
  } & EmbeddedVoiceConfig) {
    this.config = config;
    this.iframe = this.createIframe(config);
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onReady = onReady;
    this.openOnMount = openOnMount ?? false;
    this.messageHandler = this.messageHandler.bind(this);
  }

  /**
   * Creates a widget instance without attaching it to the page.
   *
   * @param config - Credentials, widget options, and event handlers.
   * @returns An unmounted widget; call {@link EmbeddedVoice.mount} next.
   */
  static create({
    rendererUrl,
    onMessage,
    onClose,
    onReady,
    openOnMount,
    ...config
  }: EmbeddedVoiceConfig & {
    onMessage?: TranscriptMessageHandler;
    onClose?: CloseHandler;
    onReady?: ReadyHandler;
    openOnMount?: boolean;
  }): EmbeddedVoice {
    return new EmbeddedVoice({
      rendererUrl: rendererUrl ?? 'https://voice-widget.hume.ai',
      ...(onMessage === undefined ? {} : { onMessage }),
      ...(onClose === undefined ? {} : { onClose }),
      ...(onReady === undefined ? {} : { onReady }),
      ...(openOnMount === undefined ? {} : { openOnMount }),
      ...config,
    });
  }

  /**
   * Attaches the widget iframe to the page and starts listening for its
   * messages.
   *
   * @param container - Element to mount into. When omitted, a fixed-position
   * container is appended to `document.body` and removed again on unmount.
   * @returns A function that unmounts the widget and removes its listeners.
   * @throws If the widget cannot be attached or teardown cannot release it.
   */
  mount(container?: HTMLElement) {
    this.unmountActiveMount?.();

    // Reattaching an iframe creates a fresh renderer lifecycle, even when the
    // same element and EmbeddedVoice instance are reused.
    this.isReady = false;
    this.shouldOpenWhenReady = this.openOnMount || this.shouldOpenWhenReady;
    const messageHandler = (event: MessageEvent<unknown>) => {
      this.messageHandler(event);
    };

    const resizeHandler = () => {
      this.sendWindowSize();
    };
    const removeListeners = (errors: unknown[]) => {
      runTeardownStep(() => {
        window.removeEventListener('message', messageHandler);
      }, errors);
      runTeardownStep(() => {
        window.removeEventListener('resize', resizeHandler);
      }, errors);
    };

    const el = container ?? this.createContainer();
    this.hideIframe();

    let isActive = false;
    const unmount = () => {
      if (!isActive) {
        return;
      }
      isActive = false;
      this.isReady = false;
      const errors: unknown[] = [];
      removeListeners(errors);
      const removedIframe = runTeardownStep(() => {
        removeElement(this.iframe);
      }, errors);
      if (!removedIframe) {
        runTeardownStep(() => {
          this.iframe.src = 'about:blank';
        }, errors);
        this.hideIframe();
      }
      if (!container) {
        runTeardownStep(() => {
          removeElement(el);
        }, errors);
      }
      if (this.unmountActiveMount === unmount) {
        this.unmountActiveMount = null;
      }
      throwTeardownErrors(
        errors,
        'Unable to completely unmount EmbeddedVoice.',
      );
    };

    try {
      window.addEventListener('message', messageHandler);
      window.addEventListener('resize', resizeHandler);
      el.appendChild(this.iframe);
      isActive = true;
      this.unmountActiveMount = unmount;
    } catch (mountError) {
      const cleanupErrors: unknown[] = [];
      removeListeners(cleanupErrors);
      if (!container) {
        runTeardownStep(() => {
          removeElement(el);
        }, cleanupErrors);
      }
      throwTeardownErrors(
        [mountError, ...cleanupErrors],
        'Unable to mount EmbeddedVoice.',
      );
    }

    return unmount;
  }

  private createContainer() {
    const div = document.createElement('div');

    Object.assign(div.style, {
      background: 'transparent',
      position: 'fixed',
      bottom: '0',
      right: '0',
      margin: '24px',
      zIndex: '999999',
      fontSize: '0px',
    });

    div.id = 'hume-embedded-voice-container';

    document.body.appendChild(div);

    return div;
  }

  private createIframe({ rendererUrl, iframeTitle }: EmbeddedVoiceConfig) {
    const el = document.createElement('iframe');

    Object.assign(el.style, {
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      border: 'none',
      height: '0px',
      width: '0px',
      opacity: '0',
      pointerEvents: 'none',
    });

    el.id = 'hume-embedded-voice';
    el.src = `${rendererUrl}`;

    el.setAttribute('title', iframeTitle ?? 'Hume Empathic Voice Widget');
    el.setAttribute('frameborder', '0');
    el.setAttribute('allowtransparency', 'true');
    el.setAttribute('scrolling', 'no');
    el.setAttribute('allow', 'microphone');

    if (el.contentWindow) {
      el.contentWindow.document.documentElement.style.backgroundColor =
        'transparent';
      el.contentWindow.document.body.style.backgroundColor = 'transparent';
    }

    return el;
  }

  private messageHandler(event: MessageEvent<unknown>) {
    if (event.source !== this.iframe.contentWindow) {
      return;
    }
    if (event.origin !== new URL(this.iframe.src).origin) {
      return;
    }

    const action = FrameToClientActionSchema.safeParse(event.data);

    if (!action.success) {
      return;
    }

    switch (action.data.type) {
      case WIDGET_IFRAME_IS_READY_ACTION.type: {
        this.isReady = true;
        this.showIframe();
        this.sendConfigObject();
        this.sendWindowSize();
        if (this.shouldOpenWhenReady) {
          this.openEmbed();
        }
        this.onReady();
        break;
      }
      case 'resize_frame': {
        this.resizeIframe(action.data.payload);
        break;
      }
      case 'transcript_message': {
        this.onMessage(action.data.payload);
        break;
      }
      case 'collapse_widget': {
        this.onClose();
        break;
      }
      case 'expand_widget':
      case 'minimize_widget': {
        break;
      }
    }
  }

  /**
   * Opens the widget.
   *
   * When called before the iframe signals readiness, the request is deferred
   * and applied as soon as the widget is ready. {@link
   * EmbeddedVoice.cancelPendingOpen} withdraws a deferred request.
   */
  openEmbed() {
    if (!this.isReady) {
      this.shouldOpenWhenReady = true;
      return;
    }
    this.shouldOpenWhenReady = false;
    const action = EXPAND_FROM_CLIENT_ACTION({
      width: window.screen.availWidth,
      height: window.screen.availHeight,
    });
    this.sendMessageToFrame(action);
  }

  /**
   * Cancels an open request waiting for readiness on the current mount.
   * A later mount will reapply the configured `openOnMount` behavior.
   */
  cancelPendingOpen() {
    if (!this.isReady) {
      this.shouldOpenWhenReady = false;
    }
  }

  private sendConfigObject() {
    const action = UPDATE_CONFIG_ACTION(this.config);
    this.sendMessageToFrame(action);
  }

  private sendWindowSize() {
    const action = SEND_WINDOW_SIZE_ACTION({
      width: window.screen.availWidth,
      height: window.screen.availHeight,
    });
    this.sendMessageToFrame(action);
  }

  private sendMessageToFrame(action: ClientToFrameAction) {
    const frame = this.iframe;

    if (!frame.contentWindow) {
      return;
    }

    frame.contentWindow.postMessage(action, new URL(frame.src).origin);
  }

  private showIframe() {
    this.iframe.style.opacity = '1';
    this.iframe.style.pointerEvents = 'auto';
  }

  private hideIframe() {
    this.iframe.style.opacity = '0';
    this.iframe.style.width = '0px';
    this.iframe.style.height = '0px';
    this.iframe.style.pointerEvents = 'none';
  }

  private resizeIframe({ width, height }: { width: number; height: number }) {
    this.iframe.style.width = `${width}px`;
    this.iframe.style.height = `${height}px`;
  }
}
