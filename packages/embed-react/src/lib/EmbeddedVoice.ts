import {
  type CloseHandler,
  EmbeddedVoice as EA,
  type EmbeddedVoiceConfig,
  type TranscriptMessageHandler,
} from '@humeai/voice-embed';
import { useEffect, useRef } from 'react';

export type EmbeddedVoiceProps = Partial<EmbeddedVoiceConfig> &
  NonNullable<Pick<EmbeddedVoiceConfig, 'auth'>> & {
    onMessage?: TranscriptMessageHandler;
    onClose?: CloseHandler;
    /**
     * Opens the widget when true. Changing this to false cancels an open that
     * is still waiting for iframe readiness, but does not collapse an open
     * widget.
     */
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
  const previousIsEmbedOpen = useRef(isEmbedOpen);
  const onMessageHandler = useRef<TranscriptMessageHandler | undefined>();
  const onCloseHandler = useRef<CloseHandler | undefined>();
  const initialConfig = useRef(config);
  const initialOpenOnMount = useRef(openOnMount);

  useEffect(() => {
    onMessageHandler.current = onMessage;
    onCloseHandler.current = onClose;
  }, [onClose, onMessage]);

  useEffect(() => {
    embeddedVoice.current = EA.create({
      onMessage: (message) => {
        onMessageHandler.current?.(message);
      },
      onClose: () => {
        onCloseHandler.current?.();
      },
      openOnMount: initialOpenOnMount.current,
      ...initialConfig.current,
    });
    const unmount = embeddedVoice.current.mount();

    return () => {
      unmount();
      embeddedVoice.current = null;
    };
  }, []);

  useEffect(() => {
    const wasEmbedOpen = previousIsEmbedOpen.current;
    previousIsEmbedOpen.current = isEmbedOpen;
    if (isEmbedOpen) {
      embeddedVoice.current?.openEmbed();
    } else if (wasEmbedOpen) {
      embeddedVoice.current?.cancelPendingOpen();
    }
  }, [isEmbedOpen]);

  return null;
};
