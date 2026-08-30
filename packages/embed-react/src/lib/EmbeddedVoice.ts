import {
  type CloseHandler,
  EmbeddedVoice as EA,
  type EmbeddedVoiceConfig,
  type ReadyHandler,
  type TranscriptMessageHandler,
} from '@humeai/voice-embed';
import { useEffect, useRef } from 'react';

/**
 * Props for {@link EmbeddedVoice}.
 *
 * Everything `EmbeddedVoiceConfig` from `@humeai/voice-embed` accepts is
 * available here, with `auth` required.
 */
export type EmbeddedVoiceProps = Partial<EmbeddedVoiceConfig> &
  NonNullable<Pick<EmbeddedVoiceConfig, 'auth'>> & {
    /** Receives user and assistant transcripts as the conversation proceeds. */
    onMessage?: TranscriptMessageHandler;
    /** Called when the user collapses the widget. */
    onClose?: CloseHandler;
    /** Called after the current widget iframe reports that it is ready. */
    onReady?: ReadyHandler;
    /**
     * Opens the widget when true. Changing this to false cancels an open that
     * is still waiting for iframe readiness, but does not collapse an open
     * widget. Keep this controlled state synchronized by setting it to false
     * from `onClose` when the user collapses the widget.
     */
    isEmbedOpen: boolean;
    /**
     * Opens the widget as soon as it is ready, without waiting for
     * `isEmbedOpen`. Read once on mount. Defaults to `false`.
     */
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

/**
 * Mounts Hume's hosted voice widget into a React application.
 *
 * The component renders no markup of its own: it manages an iframe appended to
 * `document.body`, which owns the EVI connection, the microphone, and audio
 * playback. Render it from a client component.
 *
 * @example
 * ```tsx
 * const [isEmbedOpen, setIsEmbedOpen] = useState(false);
 *
 * <button onClick={() => setIsEmbedOpen(true)}>Talk to us</button>
 * <EmbeddedVoice
 *   auth={{ type: 'accessToken', value: accessToken }}
 *   isEmbedOpen={isEmbedOpen}
 *   onClose={() => setIsEmbedOpen(false)}
 * />
 * ```
 */
export const EmbeddedVoice = (props: EmbeddedVoiceProps) => {
  const {
    onMessage,
    isEmbedOpen,
    onClose,
    onReady,
    openOnMount = false,
    ...config
  } = props;
  const embeddedVoice = useRef<EA | null>(null);
  const controlledOpenInstance = useRef<EA | null>(null);
  const previousIsEmbedOpen = useRef(isEmbedOpen);
  const onMessageHandler = useRef<TranscriptMessageHandler | undefined>();
  const onCloseHandler = useRef<CloseHandler | undefined>();
  const onReadyHandler = useRef<ReadyHandler | undefined>();
  const initialOpenOnMountPending = useRef(openOnMount);
  const configSignature = getConfigSignature(config);

  useEffect(() => {
    onMessageHandler.current = onMessage;
    onCloseHandler.current = onClose;
    onReadyHandler.current = onReady;
  }, [onClose, onMessage, onReady]);

  useEffect(() => {
    if (previousIsEmbedOpen.current && !isEmbedOpen) {
      initialOpenOnMountPending.current = false;
    }
    const applyInitialOpenOnMount = initialOpenOnMountPending.current;
    let readyInstance: EA | null = null;
    const instance = EA.create({
      onMessage: (message) => {
        onMessageHandler.current?.(message);
      },
      onClose: () => {
        onCloseHandler.current?.();
      },
      onReady: () => {
        if (readyInstance === null || embeddedVoice.current !== readyInstance) {
          return;
        }
        if (applyInitialOpenOnMount) {
          initialOpenOnMountPending.current = false;
        }
        onReadyHandler.current?.();
      },
      openOnMount: applyInitialOpenOnMount,
      ...config,
    });
    readyInstance = instance;
    embeddedVoice.current = instance;
    const unmount = instance.mount();

    return () => {
      unmount();
      if (embeddedVoice.current === instance) {
        embeddedVoice.current = null;
      }
      if (controlledOpenInstance.current === instance) {
        controlledOpenInstance.current = null;
      }
    };
    // oxlint-disable-next-line react/exhaustive-deps -- the signature deep-compares config; controlled state is consulted only when recreation coincides with a close
  }, [configSignature]);

  useEffect(() => {
    const wasEmbedOpen = previousIsEmbedOpen.current;
    previousIsEmbedOpen.current = isEmbedOpen;
    if (isEmbedOpen) {
      const instance = embeddedVoice.current;
      instance?.openEmbed();
      controlledOpenInstance.current = instance;
    } else if (wasEmbedOpen) {
      controlledOpenInstance.current?.cancelPendingOpen();
      controlledOpenInstance.current = null;
      initialOpenOnMountPending.current = false;
    }
  }, [isEmbedOpen, configSignature]);

  return null;
};
