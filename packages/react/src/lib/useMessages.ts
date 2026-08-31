import type { Hume } from 'hume';
import { useCallback, useMemo, useReducer, useRef } from 'react';

import type {
  AssistantProsodyMessage,
  AssistantTranscriptMessage,
  ChatMetadataMessage,
  JSONMessage,
  UserTranscriptMessage,
} from '../models/messages';
import { keepLastN } from '../utils';
import type { CloseEvent, ConnectionMessage } from './connection-message';

type StoredMessage = JSONMessage | ConnectionMessage;

type MessageStoreState = {
  messages: StoredMessage[];
  lastVoiceMessage: AssistantTranscriptMessage | null;
  lastUserMessage: UserTranscriptMessage | null;
  lastAssistantProsodyMessage: AssistantProsodyMessage | null;
  chatMetadata: ChatMetadataMessage | null;
};

type MessageStoreAction =
  | {
      type: 'append_connection_message';
      message: ConnectionMessage;
      messageHistoryLimit: number;
    }
  | {
      type: 'receive_message';
      message: JSONMessage;
      messageHistoryLimit: number;
    }
  | {
      type: 'receive_user_message';
      message: UserTranscriptMessage;
      messageHistoryLimit: number;
    }
  | {
      type: 'receive_assistant_prosody';
      message: AssistantProsodyMessage;
      messageHistoryLimit: number;
    }
  | {
      type: 'receive_chat_metadata';
      message: ChatMetadataMessage;
      messageHistoryLimit: number;
    }
  | {
      type: 'play_voice_message';
      message: AssistantTranscriptMessage;
      messageHistoryLimit: number;
    }
  | { type: 'clear' };

const createInitialMessageStoreState = (): MessageStoreState => ({
  messages: [],
  lastVoiceMessage: null,
  lastUserMessage: null,
  lastAssistantProsodyMessage: null,
  chatMetadata: null,
});

const addMessageKeepingInterimLast = (
  messages: StoredMessage[],
  messageToAdd: JSONMessage,
  messageHistoryLimit: number,
) => {
  const last = messages[messages.length - 1];

  if (last?.type === 'user_message' && last.interim === true) {
    const result = messages.slice(0, -1);
    result.push(messageToAdd, last);
    return keepLastN(messageHistoryLimit, result);
  }

  return keepLastN(messageHistoryLimit, messages.concat([messageToAdd]));
};

const addUserMessage = (
  messages: StoredMessage[],
  message: UserTranscriptMessage,
  messageHistoryLimit: number,
) => {
  const last = messages[messages.length - 1];

  if (last?.type === 'user_message' && last.interim === true) {
    return keepLastN(
      messageHistoryLimit,
      messages.slice(0, -1).concat([message]),
    );
  }

  return keepLastN(messageHistoryLimit, messages.concat([message]));
};

const messageStoreReducer = (
  state: MessageStoreState,
  action: MessageStoreAction,
): MessageStoreState => {
  switch (action.type) {
    case 'append_connection_message':
      return {
        ...state,
        messages: keepLastN(
          action.messageHistoryLimit,
          state.messages.concat([action.message]),
        ),
        ...(action.message.type === 'socket_connected'
          ? { chatMetadata: null }
          : undefined),
      };
    case 'receive_message':
      return {
        ...state,
        messages: addMessageKeepingInterimLast(
          state.messages,
          action.message,
          action.messageHistoryLimit,
        ),
      };
    case 'receive_user_message':
      return {
        ...state,
        messages: addUserMessage(
          state.messages,
          action.message,
          action.messageHistoryLimit,
        ),
        ...(action.message.interim === false
          ? { lastUserMessage: action.message }
          : undefined),
      };
    case 'receive_assistant_prosody':
      return {
        ...state,
        messages: addMessageKeepingInterimLast(
          state.messages,
          action.message,
          action.messageHistoryLimit,
        ),
        lastAssistantProsodyMessage: action.message,
      };
    case 'receive_chat_metadata':
      return {
        ...state,
        messages: addMessageKeepingInterimLast(
          state.messages,
          action.message,
          action.messageHistoryLimit,
        ),
        chatMetadata: action.message,
      };
    case 'play_voice_message':
      return {
        ...state,
        messages: addMessageKeepingInterimLast(
          state.messages,
          action.message,
          action.messageHistoryLimit,
        ),
        lastVoiceMessage: action.message,
      };
    case 'clear':
      return createInitialMessageStoreState();
  }
};

export const useMessages = ({
  sendMessageToParent,
  messageHistoryLimit,
}: {
  sendMessageToParent?: (message: JSONMessage) => void;
  messageHistoryLimit: number;
}) => {
  const voiceMessageMapRef = useRef<Record<string, AssistantTranscriptMessage>>(
    {},
  );
  const [state, dispatch] = useReducer(
    messageStoreReducer,
    undefined,
    createInitialMessageStoreState,
  );

  const createConnectMessage = useCallback(() => {
    dispatch({
      type: 'append_connection_message',
      message: {
        type: 'socket_connected',
        receivedAt: new Date(),
      },
      messageHistoryLimit,
    });
  }, [messageHistoryLimit]);

  const createSessionSettingsMessage = useCallback(
    (sessionSettings: Hume.empathicVoice.SessionSettings) => {
      dispatch({
        type: 'append_connection_message',
        message: {
          type: 'session_settings',
          sessionSettings,
          receivedAt: new Date(),
        },
        messageHistoryLimit,
      });
    },
    [messageHistoryLimit],
  );

  const createDisconnectMessage = useCallback(
    (event: CloseEvent) => {
      dispatch({
        type: 'append_connection_message',
        message: {
          type: 'socket_disconnected',
          code: event.code,
          reason: event.reason,
          receivedAt: new Date(),
        },
        messageHistoryLimit,
      });
    },
    [messageHistoryLimit],
  );

  const onMessage = useCallback(
    (message: JSONMessage) => {
      switch (message.type) {
        case 'assistant_message':
          // For assistant messages, `sendMessageToParent` is called in `onPlayAudio`
          // to line up the transcript event with the correct audio clip.
          if (message.id !== undefined && message.id !== '') {
            voiceMessageMapRef.current[message.id] = message;
          }
          break;
        case 'user_message':
          dispatch({
            type: 'receive_user_message',
            message,
            messageHistoryLimit,
          });
          sendMessageToParent?.(message);

          break;
        case 'user_interruption':
        case 'error':
        case 'tool_call':
        case 'tool_response':
        case 'tool_error':
        case 'assistant_end':
        case 'session_settings':
          dispatch({ type: 'receive_message', message, messageHistoryLimit });
          sendMessageToParent?.(message);
          break;
        case 'assistant_prosody':
          dispatch({
            type: 'receive_assistant_prosody',
            message,
            messageHistoryLimit,
          });
          sendMessageToParent?.(message);
          break;
        case 'chat_metadata':
          dispatch({
            type: 'receive_chat_metadata',
            message,
            messageHistoryLimit,
          });
          sendMessageToParent?.(message);
          break;
        default:
          break;
      }
    },
    [messageHistoryLimit, sendMessageToParent],
  );

  const onPlayAudio = useCallback(
    (id: string) => {
      const matchingTranscript = voiceMessageMapRef.current[id];
      if (matchingTranscript) {
        dispatch({
          type: 'play_voice_message',
          message: matchingTranscript,
          messageHistoryLimit,
        });
        // Remove the message before notifying application code so a throwing
        // callback cannot cause the transcript to be published twice.
        delete voiceMessageMapRef.current[id];
        sendMessageToParent?.(matchingTranscript);
      }
    },
    [messageHistoryLimit, sendMessageToParent],
  );

  const clearMessages = useCallback(() => {
    voiceMessageMapRef.current = {};
    dispatch({ type: 'clear' });
  }, []);

  return useMemo(
    () => ({
      createConnectMessage,
      createDisconnectMessage,
      createSessionSettingsMessage,
      onMessage,
      onPlayAudio,
      clearMessages,
      messages: state.messages,
      lastVoiceMessage: state.lastVoiceMessage,
      lastUserMessage: state.lastUserMessage,
      lastAssistantProsodyMessage: state.lastAssistantProsodyMessage,
      chatMetadata: state.chatMetadata,
    }),
    [
      createConnectMessage,
      createDisconnectMessage,
      createSessionSettingsMessage,
      onMessage,
      onPlayAudio,
      clearMessages,
      state.messages,
      state.lastVoiceMessage,
      state.lastUserMessage,
      state.lastAssistantProsodyMessage,
      state.chatMetadata,
    ],
  );
};
