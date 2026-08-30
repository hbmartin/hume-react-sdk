---
description: 'What happens when a user talks over the assistant, and how to reflect it in your UI.'
---

# Interruptions

When a user starts speaking while the assistant is talking, EVI sends a
`user_interruption` message. The SDK reacts to it whether or not you do.

## What the SDK does

On every `user_interruption`:

- **The playback queue is always cleared.** Any audio still queued is discarded
  so the assistant stops immediately.
- **`onInterruption` fires only if audio was actually playing.**

That asymmetry surprises people, so it is worth stating plainly: a
`user_interruption` that arrives when the assistant is already silent still
clears the queue, but your callback does not run. `onInterruption` means "you
cut the assistant off", not "an interruption message arrived".

```tsx
<VoiceProvider
  onInterruption={(message) => {
    // The user spoke over the assistant. Audio has already stopped.
    cancelTypewriterAnimation();
  }}
>
```

## What to do with it

The audio is already handled. `onInterruption` is for the rest of your UI:

- Stop a typewriter or streaming-text animation that is still catching up to
  audio which is no longer playing.
- Mark a half-delivered assistant message as interrupted, so the transcript does
  not imply the user heard all of it.
- Drop a "speaking" indicator.

Interruption messages also land in `messages`, so you can render them inline.

## Interruption versus pausing

These are different and both exist:

|                    | Cause                             | Effect                                                        |
| ------------------ | --------------------------------- | ------------------------------------------------------------- |
| Interruption       | The user talks over the assistant | Playback stops, the assistant yields the turn                 |
| `pauseAssistant()` | Your code                         | The assistant stops producing audio until `resumeAssistant()` |

Use `pauseAssistant` for deliberate control — a push-to-talk button, or muting
during a form step. It is not what happens on barge-in.

## Reflecting playback state

Two values from `useVoice()` help render this accurately:

- `isPlaying` — whether assistant audio is currently playing.
- `playerQueueLength` — how much audio is still queued.

After an interruption, `playerQueueLength` drops to zero, which is a reliable
signal that the assistant has genuinely stopped rather than paused between
chunks.

## Interim transcripts

Related, and often noticed at the same time: the user's transcript arrives
incrementally. An interim `user_message` is **replaced in place** in `messages`
as it is refined, rather than appended — so a transcript does not fill with
partial duplicates. Only the final version persists.

## Reference

- [`UserInterruptionMessage`](/reference/api/voice-react.userinterruptionmessage)
- [`VoiceProviderProps.onInterruption`](/reference/api/voice-react.voiceproviderprops.oninterruption)
- [`VoiceContextType.pauseAssistant`](/reference/api/voice-react.voicecontexttype.pauseassistant),
  [`resumeAssistant`](/reference/api/voice-react.voicecontexttype.resumeassistant)
- [`VoiceContextType.playerQueueLength`](/reference/api/voice-react.voicecontexttype.playerqueuelength)
