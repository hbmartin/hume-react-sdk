import {
  type CloseHandler,
  EmbeddedVoice as EA,
  type EmbeddedVoiceConfig,
  type TranscriptMessageHandler,
  WIDGET_IFRAME_IS_READY_ACTION,
} from '@humeai/voice-embed';
import { useEffect, useRef, useState } from 'react';

export type EmbeddedVoiceProps = Partial<EmbeddedVoiceConfig> &
  NonNullable<Pick<EmbeddedVoiceConfig, 'auth'>> & {
    onMessage?: TranscriptMessageHandler;
    onClose?: CloseHandler;
    isEmbedOpen: boolean;
    openOnMount?: boolean;
  };

export const EmbeddedVoice = (props: EmbeddedVoiceProps) => {
  const {
    onMessage,
    isEmbedOpen,
    onClose,
    openOnMount = false,
    ...config
  } = props;
  const embeddedVoice = useRef<EA | null>(null);
  const iframeIsReady = useRef(false);
  const openWhenReady = useRef(false);
  const onMessageHandler = useRef<TranscriptMessageHandler | undefined>();
  const onCloseHandler = useRef<CloseHandler | undefined>();
  const [initialConfig] = useState(config);

  useEffect(() => {
    onMessageHandler.current = onMessage;
    onCloseHandler.current = onClose;
  }, [onClose, onMessage]);

  useEffect(() => {
    let unmount: (() => void) | undefined;
    const rendererOrigin = new URL(
      initialConfig.rendererUrl ?? 'https://voice-widget.hume.ai',
    ).origin;
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== rendererOrigin ||
        typeof event.data !== 'object' ||
        event.data === null ||
        !('type' in event.data) ||
        event.data.type !== WIDGET_IFRAME_IS_READY_ACTION.type
      ) {
        return;
      }

      iframeIsReady.current = true;
      if (openWhenReady.current) {
        openWhenReady.current = false;
        embeddedVoice.current?.openEmbed();
      }
    };

    if (!embeddedVoice.current) {
      iframeIsReady.current = false;
      openWhenReady.current = false;
      window.addEventListener('message', handleMessage);
      embeddedVoice.current = EA.create({
        onMessage: (message) => {
          onMessageHandler.current?.(message);
        },
        onClose: () => {
          onCloseHandler.current?.();
        },
        openOnMount,
        ...initialConfig,
      });
      unmount = embeddedVoice.current.mount();
    }

    return () => {
      window.removeEventListener('message', handleMessage);
      if (unmount !== undefined) {
        unmount();
      }
      embeddedVoice.current = null;
    };
  }, [initialConfig, openOnMount]);

  useEffect(() => {
    if (isEmbedOpen && !openOnMount) {
      if (iframeIsReady.current) {
        embeddedVoice.current?.openEmbed();
      } else {
        openWhenReady.current = true;
      }
    } else {
      openWhenReady.current = false;
    }
  }, [isEmbedOpen, openOnMount]);

  return null;
};
