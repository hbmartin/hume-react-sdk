/**
 * Hume's hosted Empathic Voice Interface widget as a React component.
 *
 * Render `EmbeddedVoice` with your credentials and control its
 * visibility through `isEmbedOpen`. This is a thin wrapper over
 * `@humeai/voice-embed`: same widget, same behavior.
 *
 * @packageDocumentation
 */

export * from './lib/EmbeddedVoice';

export {
  COLLAPSE_WIDGET_ACTION,
  EXPAND_WIDGET_ACTION,
  MINIMIZE_WIDGET_ACTION,
  RESIZE_FRAME_ACTION,
  TRANSCRIPT_MESSAGE_ACTION,
  WIDGET_IFRAME_IS_READY_ACTION,
  parseClientToFrameAction,
  LanguageModelOption,
} from '@humeai/voice-embed';

export type {
  AssistantTranscriptMessage,
  EmbeddedVoiceConfig,
  SocketConfig,
  FrameToClientAction,
  JSONMessage,
  UserTranscriptMessage,
  WindowDimensions,
  EmotionScores,
  ToolCall,
  ToolResponse,
  ToolError,
  ChatMetadataMessage,
} from '@humeai/voice-embed';
