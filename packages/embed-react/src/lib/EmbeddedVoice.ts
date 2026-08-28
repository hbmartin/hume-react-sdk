import {
  type CloseHandler,
  EmbeddedVoice as EA,
  type EmbeddedVoiceConfig,
  type TranscriptMessageHandler,
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
  const onMessageHandler = useRef<TranscriptMessageHandler | undefined>();
  const onCloseHandler = useRef<CloseHandler | undefined>();
  const [initialConfig] = useState(config);

  useEffect(() => {
    onMessageHandler.current = onMessage;
    onCloseHandler.current = onClose;
  }, [onClose, onMessage]);

  useEffect(() => {
    let unmount: (() => void) | undefined;
    if (!embeddedVoice.current) {
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
      if (unmount !== undefined) {
        unmount();
      }
      embeddedVoice.current = null;
    };
  }, [initialConfig, openOnMount]);

  useEffect(() => {
    if (isEmbedOpen && !openOnMount) {
      embeddedVoice.current?.openEmbed();
    }
  }, [isEmbedOpen, openOnMount]);

  return null;
};
