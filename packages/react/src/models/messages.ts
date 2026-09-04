import { type Hume } from 'hume';

/**
 * An EVI wire message stamped with the time the SDK received it.
 *
 * Every message type the SDK surfaces carries this `receivedAt` stamp, which
 * the EVI API itself does not provide.
 */
export type WithReceivedAt<T> = T & { receivedAt: Date };

/** An `assistant_end` message marking the end of an assistant turn. */
export type AssistantEndMessage =
  WithReceivedAt<Hume.empathicVoice.AssistantEnd>;
/** A transcript of what the assistant said. */
export type AssistantTranscriptMessage =
  WithReceivedAt<Hume.empathicVoice.AssistantMessage>;
/** Prosody scores for a segment of assistant speech. */
export type AssistantProsodyMessage =
  WithReceivedAt<Hume.empathicVoice.AssistantProsody>;
/** A chunk of captured microphone audio sent to EVI. */
export type AudioMessage = WithReceivedAt<Hume.empathicVoice.AudioInput>;
/** A chunk of assistant audio received from EVI for playback. */
export type AudioOutputMessage = WithReceivedAt<Hume.empathicVoice.AudioOutput>;
/** Metadata for the chat, including chat, chat group, and request IDs. */
export type ChatMetadataMessage =
  WithReceivedAt<Hume.empathicVoice.ChatMetadata>;
/** An error reported by EVI over the socket. */
export type JSONErrorMessage =
  WithReceivedAt<Hume.empathicVoice.WebSocketError>;
/** Any non-audio message received over the EVI socket. */
export type JSONMessage = WithReceivedAt<Hume.empathicVoice.JsonMessage>;
/** A request from the assistant to invoke one of your tools. */
export type ToolCall = WithReceivedAt<Hume.empathicVoice.ToolCallMessage>;
/** A failure returned to the assistant in place of a tool result. */
export type ToolError = WithReceivedAt<Hume.empathicVoice.ToolErrorMessage>;
/** A successful tool result returned to the assistant. */
export type ToolResponse =
  WithReceivedAt<Hume.empathicVoice.ToolResponseMessage>;
/** A notice that the user interrupted the assistant. */
export type UserInterruptionMessage =
  WithReceivedAt<Hume.empathicVoice.UserInterruption>;
/** A transcript of what the user said. */
export type UserTranscriptMessage =
  WithReceivedAt<Hume.empathicVoice.UserMessage>;
