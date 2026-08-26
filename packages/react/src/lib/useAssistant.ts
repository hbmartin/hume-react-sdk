import { AudioEncoding, createConfig } from '@humeai/assistant';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAssistantClient } from './useAssistantClient';
import { useMicrophone } from './useMicrophone';
import { useEncoding } from './useMicrophone/useEncoding';
import { useSoundPlayer } from './useSoundPlayer';

type AssistantStatus =
  | {
      value: 'disconnected' | 'connecting' | 'connected';
      reason?: never;
    }
  | {
      value: 'error';
      reason: string;
    };

const stopStream = (stream: MediaStream) => {
  stream.getTracks().forEach((track) => track.stop());
};

export const useAssistant = (props: Parameters<typeof createConfig>[0]) => {
  const [status, setStatus] = useState<AssistantStatus>({
    value: 'disconnected',
  });
  const config = createConfig(props);

  const onError = useCallback((message: string) => {
    setStatus({ value: 'error', reason: message });
  }, []);

  const player = useSoundPlayer({ onError });
  const { getStream } = useEncoding({
    encodingConstraints: {
      sampleRate: config.sampleRate,
      channelCount: config.channels,
    },
  });

  const client = useAssistantClient({
    config: {
      ...config,
      encoding: AudioEncoding.LINEAR16,
    },
    onAudioMessage: (arrayBuffer) => {
      player.addToQueue(arrayBuffer);
    },
    onError,
  });

  const mic = useMicrophone({
    onAudioCaptured: (arrayBuffer) => {
      client.sendAudio(arrayBuffer);
    },
    onError,
  });

  const clientRef = useRef(client);
  const micRef = useRef(mic);
  const playerRef = useRef(player);
  clientRef.current = client;
  micRef.current = mic;
  playerRef.current = player;

  const connectionGeneration = useRef(0);
  const disconnectResources = useCallback(() => {
    connectionGeneration.current += 1;
    clientRef.current.disconnect();
    playerRef.current.stopAll();
    micRef.current.stop();
  }, []);

  const connect = useCallback(() => {
    disconnectResources();
    const generation = ++connectionGeneration.current;
    setStatus({ value: 'connecting' });

    void (async () => {
      let candidateStream: MediaStream | null = null;
      let microphoneOwnsStream = false;

      try {
        const { encoding, stream } = await getStream();
        candidateStream = stream;

        if (generation !== connectionGeneration.current) {
          stopStream(stream);
          return;
        }

        playerRef.current.initPlayer();
        clientRef.current.connect({
          ...config,
          channels: encoding.channelCount,
          encoding: AudioEncoding.LINEAR16,
          sampleRate: encoding.sampleRate,
        });

        microphoneOwnsStream = true;
        const started = await micRef.current.start(stream);
        if (!started || generation !== connectionGeneration.current) {
          return;
        }

        setStatus({ value: 'connected' });
      } catch (error) {
        if (candidateStream && !microphoneOwnsStream) {
          stopStream(candidateStream);
        }
        if (generation !== connectionGeneration.current) {
          return;
        }

        const permissionDenied =
          error instanceof DOMException && error.name === 'NotAllowedError';
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        onError(
          permissionDenied
            ? `Microphone permission denied: ${message}`
            : `Error initializing assistant: ${message}`,
        );
      }
    })();
  }, [config, disconnectResources, getStream, onError]);

  const disconnect = useCallback(() => {
    disconnectResources();
    setStatus((currentStatus) =>
      currentStatus.value === 'error'
        ? currentStatus
        : { value: 'disconnected' },
    );
  }, [disconnectResources]);

  useEffect(() => {
    if (status.value === 'error') {
      disconnectResources();
    }
  }, [disconnectResources, status.value]);

  useEffect(() => disconnectResources, [disconnectResources]);

  return {
    connect,
    disconnect,
    fft: player.fft,
    isMuted: mic.isMuted,
    isPlaying: player.isPlaying,
    messages: client.messages,
    mute: mic.mute,
    readyState: client.readyState,
    status,
    unmute: mic.unmute,
  };
};
