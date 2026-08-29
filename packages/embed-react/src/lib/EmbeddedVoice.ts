import {
  type CloseHandler,
  EmbeddedVoice as EA,
  type EmbeddedVoiceConfig,
  type TranscriptMessageHandler,
} from '@humeai/voice-embed';
import { useEffect, useMemo, useRef } from 'react';

export type EmbeddedVoiceProps = Partial<EmbeddedVoiceConfig> &
  NonNullable<Pick<EmbeddedVoiceConfig, 'auth'>> & {
    onMessage?: TranscriptMessageHandler;
    onClose?: CloseHandler;
    /**
     * Opens the widget when true. Changing this to false cancels an open that
     * is still waiting for iframe readiness, but does not collapse an open
     * widget. Keep this controlled state synchronized by setting it to false
     * from `onClose` when the user collapses the widget.
     */
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
  const previousIsEmbedOpen = useRef(isEmbedOpen);
  const onMessageHandler = useRef<TranscriptMessageHandler | undefined>();
  const onCloseHandler = useRef<CloseHandler | undefined>();
  const initialOpenOnMount = useRef(openOnMount);
  const configSignature = getConfigSignature(config);
  // oxlint-disable-next-line react/exhaustive-deps -- the signature deep-compares the serializable embed configuration
  const stableConfig = useMemo(() => config, [configSignature]);

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
      ...stableConfig,
    });
    const unmount = embeddedVoice.current.mount();

    return () => {
      unmount();
      embeddedVoice.current = null;
    };
  }, [stableConfig]);

  useEffect(() => {
    const wasEmbedOpen = previousIsEmbedOpen.current;
    previousIsEmbedOpen.current = isEmbedOpen;
    if (isEmbedOpen) {
      embeddedVoice.current?.openEmbed();
    } else if (wasEmbedOpen) {
      embeddedVoice.current?.cancelPendingOpen();
    }
  }, [isEmbedOpen, stableConfig]);

  return null;
};
