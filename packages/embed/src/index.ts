/**
 * Hume's hosted Empathic Voice Interface widget for any browser application.
 *
 * `EmbeddedVoice.create()` returns a handle you mount into the page; the
 * widget runs in an iframe that owns the EVI connection, the microphone, and
 * audio playback. React applications should prefer
 * `@humeai/voice-embed-react`.
 *
 * @packageDocumentation
 */

export * from './lib/embed';

export {
  COLLAPSE_WIDGET_ACTION,
  EXPAND_WIDGET_ACTION,
  MINIMIZE_WIDGET_ACTION,
  RESIZE_FRAME_ACTION,
  TRANSCRIPT_MESSAGE_ACTION,
  WIDGET_IFRAME_IS_READY_ACTION,
  parseClientToFrameAction,
  type ClientToFrameAction,
  type FrameToClientAction,
  type WindowDimensions,
} from './lib/embed-messages';
import { type Hume } from 'hume';

/** A transcript of what the assistant said. */
export type AssistantTranscriptMessage = Hume.empathicVoice.AssistantMessage;
/** Any non-audio message received over the EVI socket. */
export type JSONMessage = Hume.empathicVoice.SubscribeEvent;
/** A transcript of what the user said. */
export type UserTranscriptMessage = Hume.empathicVoice.UserMessage;
/** Prosody scores describing the emotional content of a message. */
export type EmotionScores = Hume.empathicVoice.EmotionScores;
/** A request from the assistant to invoke one of your tools. */
export type ToolCall = Hume.empathicVoice.ToolCallMessage;
/** A successful tool result returned to the assistant. */
export type ToolResponse = Hume.empathicVoice.ToolResponseMessage;
/** A failure returned to the assistant in place of a tool result. */
export type ToolError = Hume.empathicVoice.ToolErrorMessage;
/** Metadata for the chat, including chat, chat group, and request IDs. */
export type ChatMetadataMessage = Hume.empathicVoice.ChatMetadata;

/** Alias of the `hume` SDK's subscribe-event union. */
export type SubscribeEvent = Hume.empathicVoice.SubscribeEvent;
/** Alias of the `hume` SDK's assistant message type. */
export type AssistantMessage = Hume.empathicVoice.AssistantMessage;
/** Alias of the `hume` SDK's user message type. */
export type UserMessage = Hume.empathicVoice.UserMessage;
/** Alias of the `hume` SDK's tool call message type. */
export type ToolCallMessage = Hume.empathicVoice.ToolCallMessage;
/** Alias of the `hume` SDK's tool response message type. */
export type ToolResponseMessage = Hume.empathicVoice.ToolResponseMessage;
/** Alias of the `hume` SDK's tool error message type. */
export type ToolErrorMessage = Hume.empathicVoice.ToolErrorMessage;
/** Alias of the `hume` SDK's chat metadata type. */
export type ChatMetadata = Hume.empathicVoice.ChatMetadata;

export { LanguageModelOption } from './types';
export { type SocketConfig } from './lib/embed-messages';
