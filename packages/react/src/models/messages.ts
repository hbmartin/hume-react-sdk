import { type Hume } from 'hume';
import z from 'zod';

type AssistantEnd = Hume.empathicVoice.AssistantEnd;
type AssistantMessage = Hume.empathicVoice.AssistantMessage;
type AssistantProsody = Hume.empathicVoice.AssistantProsody;
type AudioInput = Hume.empathicVoice.AudioInput;
type AudioOutput = Hume.empathicVoice.AudioOutput;
type ChatMetadata = Hume.empathicVoice.ChatMetadata;
type JsonMessage = Hume.empathicVoice.JsonMessage;
type ToolCallMessage = Hume.empathicVoice.ToolCallMessage;
type ToolErrorMessage = Hume.empathicVoice.ToolErrorMessage;
type ToolResponseMessage = Hume.empathicVoice.ToolResponseMessage;
type UserInterruption = Hume.empathicVoice.UserInterruption;
type UserMessage = Hume.empathicVoice.UserMessage;
type WebSocketError = Hume.empathicVoice.WebSocketError;

/**
 * An EVI wire message stamped with the time the SDK received it.
 *
 * Every message type the SDK surfaces carries this `receivedAt` stamp, which
 * the EVI API itself does not provide.
 */
export type WithReceivedAt<T> = T & { receivedAt: Date };

/** An `assistant_end` message marking the end of an assistant turn. */
export type AssistantEndMessage = WithReceivedAt<AssistantEnd>;
/** A transcript of what the assistant said. */
export type AssistantTranscriptMessage = WithReceivedAt<AssistantMessage>;
/** Prosody scores for a segment of assistant speech. */
export type AssistantProsodyMessage = WithReceivedAt<AssistantProsody>;
/** A chunk of captured microphone audio sent to EVI. */
export type AudioMessage = WithReceivedAt<AudioInput>;
/** A chunk of assistant audio received from EVI for playback. */
export type AudioOutputMessage = WithReceivedAt<AudioOutput>;
/** Metadata for the chat, including chat, chat group, and request IDs. */
export type ChatMetadataMessage = WithReceivedAt<ChatMetadata>;
/** An error reported by EVI over the socket. */
export type JSONErrorMessage = WithReceivedAt<WebSocketError>;
/** Any non-audio message received over the EVI socket. */
export type JSONMessage = WithReceivedAt<JsonMessage>;
/** A request from the assistant to invoke one of your tools. */
export type ToolCall = WithReceivedAt<ToolCallMessage>;
/** A failure returned to the assistant in place of a tool result. */
export type ToolError = WithReceivedAt<ToolErrorMessage>;
/** A successful tool result returned to the assistant. */
export type ToolResponse = WithReceivedAt<ToolResponseMessage>;
/** A notice that the user interrupted the assistant. */
export type UserInterruptionMessage = WithReceivedAt<UserInterruption>;
/** A transcript of what the user said. */
export type UserTranscriptMessage = WithReceivedAt<UserMessage>;

/** @internal */
export const TimeSliceSchema = z.object({
  begin: z.number(),
  end: z.number(),
});

/** @internal */
export type TimeSlice = z.infer<typeof TimeSliceSchema>;
