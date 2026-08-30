---
description: 'Read prosody scores from user and assistant messages, and render them responsibly.'
---

# Expression measurement

EVI measures vocal expression and attaches scores to messages. This is the part
of Hume that is not just speech-to-speech, and the SDK surfaces it without
interpreting it for you.

## Where the scores are

Prosody scores arrive on the messages themselves:

- `UserTranscriptMessage` carries `models.prosody.scores` for what the user said.
- `AssistantProsodyMessage` carries scores for the assistant's own speech.

`useVoice()` also exposes `lastAssistantProsodyMessage` for the most recent one,
which is usually what a live indicator wants.

```tsx
import { useVoice } from '@humeai/voice-react';

function Expression() {
  const { lastUserMessage } = useVoice();

  const scores =
    lastUserMessage?.type === 'user_message'
      ? lastUserMessage.models.prosody?.scores
      : undefined;

  if (!scores) return null;

  return <EmotionBars scores={scores} />;
}
```

## Picking the strongest few

Scores are a record of emotion name to number. Rendering all of them is noise;
the top few are usually what you want.

```tsx
export function topEmotions(
  scores: Record<string, number>,
  count = 3,
): [string, number][] {
  return Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, count);
}
```

## Rendering responsibly

::: warning Present scores as relative, not as fact
These are model outputs describing **vocal expression**, not measurements of
what someone feels. Two things follow:

- Show them relatively — a ranking or a bar chart — rather than as a verdict
  like "the user is angry".
- Do not drive consequential behavior from a single score. Expression varies
  with accent, recording conditions, and context.
  :::

Hume's [guidelines on the science][science] are worth reading before you build a
feature on top of these.

## Prosody and diagnostics

Diagnostic events exclude prosody scores along with all other message content,
unless you set `includeContent: true`. See
[Diagnostics and logging](./diagnostics).

## Reference

- [`UserTranscriptMessage`](/reference/api/voice-react.usertranscriptmessage)
- [`AssistantProsodyMessage`](/reference/api/voice-react.assistantprosodymessage)
- [`VoiceContextType.lastAssistantProsodyMessage`](/reference/api/voice-react.voicecontexttype.lastassistantprosodymessage)

[science]: https://dev.hume.ai/docs/introduction/science
