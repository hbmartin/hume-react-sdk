import {
  type CloseHandler,
  EmbeddedVoice as EA,
  type EmbeddedVoiceConfig,
  type TranscriptMessageHandler,
  WIDGET_IFRAME_IS_READY_ACTION,
} from '@humeai/voice-embed';
import { useEffect, useMemo, useRef } from 'react';

export type EmbeddedVoiceProps = Partial<EmbeddedVoiceConfig> &
  NonNullable<Pick<EmbeddedVoiceConfig, 'auth'>> & {
    onMessage?: TranscriptMessageHandler;
    onClose?: CloseHandler;
    isEmbedOpen: boolean;
    openOnMount?: boolean;
  };

const getConfigSignature = (config: EmbeddedVoiceConfig): string =>
  JSON.stringify(config, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });

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
  const previousIsEmbedOpen = useRef(isEmbedOpen);
  const onMessageHandler = useRef<TranscriptMessageHandler | undefined>();
  const onCloseHandler = useRef<CloseHandler | undefined>();
  const configSignature = getConfigSignature(config);
  // oxlint-disable-next-line react/exhaustive-deps -- the signature deep-compares the serializable embed configuration
  const stableConfig = useMemo(() => config, [configSignature]);

  useEffect(() => {
    onMessageHandler.current = onMessage;
    onCloseHandler.current = onClose;
  }, [onClose, onMessage]);

  useEffect(() => {
    let unmount: (() => void) | undefined;
    const rendererOrigin = new URL(
      stableConfig.rendererUrl ?? 'https://voice-widget.hume.ai',
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
      openWhenReady.current = openOnMount;
      embeddedVoice.current = EA.create({
        onMessage: (message) => {
          onMessageHandler.current?.(message);
        },
        onClose: () => {
          onCloseHandler.current?.();
        },
        // React owns the initial and controlled open state so expansion always
        // happens after the embed's readiness handler sends its configuration.
        openOnMount: false,
        ...stableConfig,
      });
      unmount = embeddedVoice.current.mount();
      window.addEventListener('message', handleMessage);
    }

    return () => {
      window.removeEventListener('message', handleMessage);
      if (unmount !== undefined) {
        unmount();
      }
      embeddedVoice.current = null;
    };
  }, [openOnMount, stableConfig]);

  useEffect(() => {
    const wasEmbedOpen = previousIsEmbedOpen.current;
    previousIsEmbedOpen.current = isEmbedOpen;
    if (isEmbedOpen) {
      if (iframeIsReady.current) {
        embeddedVoice.current?.openEmbed();
      } else {
        openWhenReady.current = true;
      }
    } else if (wasEmbedOpen) {
      openWhenReady.current = false;
    }
  }, [isEmbedOpen, openOnMount, stableConfig]);

  return null;
};
