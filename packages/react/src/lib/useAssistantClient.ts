import type { Config, Message } from '@humeai/assistant';
import { AssistantClient } from '@humeai/assistant';
import { useCallback, useMemo, useRef, useState } from 'react';

export enum ReadyState {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  OPEN = 'open',
  CLOSED = 'closed',
}

export const useAssistantClient = (props: {
  config: Config;
  onAudioMessage?: (arrayBuffer: ArrayBufferLike) => void;
  onError: (message: string) => void;
}) => {
  const config = useRef<Config>(props.config);
  config.current = props.config;

  const client = useRef<AssistantClient | null>(null);

  const [readyState, setReadyState] = useState<ReadyState>(ReadyState.IDLE);
  const [messages, setMessages] = useState<Message[]>([]);

  const onAudioMessage = useRef<
    ((arrayBuffer: ArrayBufferLike) => void) | undefined
  >(props.onAudioMessage);
  onAudioMessage.current = props.onAudioMessage;
  const onError = useRef(props.onError);
  onError.current = props.onError;

  const connect = useCallback((nextConfig: Config = config.current) => {
    client.current?.disconnect();
    const nextClient = AssistantClient.create(nextConfig);
    client.current = nextClient;

    nextClient.on('open', () => {
      setReadyState(ReadyState.OPEN);
    });

    nextClient.on('message', (message) => {
      if (message.type === 'audio') {
        onAudioMessage.current?.(message.data);
      }

      setMessages((prev) => {
        return prev.concat([message]);
      });
    });

    nextClient.on('close', () => {
      setReadyState(ReadyState.CLOSED);
    });

    nextClient.on('error', (e) => {
      const message = e instanceof Error ? e.message : 'Unknown error';
      onError.current(`Error with websocket connection: ${message}`);
    });

    setReadyState(ReadyState.CONNECTING);

    nextClient.connect();
  }, []);

  const disconnect = useCallback(() => {
    setReadyState(ReadyState.IDLE);
    client.current?.disconnect();
    client.current = null;
  }, []);

  const sendAudio = useCallback((arrayBuffer: ArrayBufferLike) => {
    client.current?.sendAudio(arrayBuffer);
  }, []);

  return useMemo(
    () => ({
      readyState,
      messages,
      sendAudio,
      connect,
      disconnect,
    }),
    [connect, disconnect, messages, readyState, sendAudio],
  );
};
