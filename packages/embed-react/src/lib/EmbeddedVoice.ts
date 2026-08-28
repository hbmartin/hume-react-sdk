import {
  type CloseHandler,
  EmbeddedVoice as EA,
  type EmbeddedVoiceConfig,
  type TranscriptMessageHandler,
} from '@humeai/voice-embed';
import { useEffect, useRef, useState } from 'react';

type EmbeddedVoiceProps = Partial<EmbeddedVoiceConfig> &
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
  const [stableConfig] = useState<
    Partial<EmbeddedVoiceConfig> &
      NonNullable<Pick<EmbeddedVoiceConfig, 'auth'>>
  >(config);

  useEffect(() => {
    onMessageHandler.current = onMessage;
    onCloseHandler.current = onClose;
  }, [onClose, onMessage]);

  useEffect(() => {
    let unmount: (() => void) | undefined;
    if (!embeddedVoice.current) {
      embeddedVoice.current = EA.create({
        ...(onMessageHandler.current === undefined
          ? {}
          : { onMessage: onMessageHandler.current }),
        ...(onCloseHandler.current === undefined
          ? {}
          : { onClose: onCloseHandler.current }),
        openOnMount: openOnMount,
        ...stableConfig,
      });
      unmount = embeddedVoice.current.mount();
    }

    return () => {
      if (unmount !== undefined) {
        unmount();
      }
      embeddedVoice.current = null;
    };
  }, [openOnMount, stableConfig]);

  useEffect(() => {
    if (isEmbedOpen) {
      embeddedVoice.current?.openEmbed();
    }
  }, [isEmbedOpen]);

  return null;
};
