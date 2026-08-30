---
description: 'Configure a session at connect time or mid-call, and resume an earlier conversation.'
---

# Session settings and resuming chats

Session settings configure one conversation: the system prompt, the language
model, template variables, built-in tools, and audio encoding. They are separate
from your EVI configuration, which lives on the Hume dashboard — think of
session settings as per-call overrides.

## At connect time

```tsx
void connect({
  auth: { type: 'accessToken', value: accessToken },
  configId: '<YOUR_CONFIG_ID>',
  sessionSettings: {
    systemPrompt: 'You are helping a customer track a package.',
    variables: { customerName: 'Ada' },
    builtinTools: [{ name: 'web_search' }],
  },
});
```

These apply from the first turn, which matters for a system prompt — sending it
after the conversation starts means the first response was generated without it.

## Mid-call

`sendSessionSettings` updates a live session:

```tsx
const { sendSessionSettings } = useVoice();

sendSessionSettings({
  variables: { cartTotal: '42.00' },
});
```

Useful when something in your application changes that the assistant should know
about. Settings you do not include are left alone.

Session settings you send appear in `messages`, so they show up in a transcript
view unless you filter them out.

## Resuming a conversation

EVI groups related chats into a **chat group**. Passing a previous group's
identifier restores the assistant's context from the earlier conversation.

Read it from `chatMetadata` once connected, and persist it:

```tsx
const { chatMetadata } = useVoice();

useEffect(() => {
  if (chatMetadata?.chatGroupId) {
    localStorage.setItem('hume-chat-group', chatMetadata.chatGroupId);
  }
}, [chatMetadata?.chatGroupId]);
```

Then pass it on the next connect:

```tsx
void connect({
  auth: { type: 'accessToken', value: accessToken },
  resumedChatGroupId: localStorage.getItem('hume-chat-group') ?? undefined,
});
```

::: warning The transcript does not come back
Resuming restores context **server-side**. The `messages` array starts empty
again — it only ever holds messages from the current connection. If you want to
show earlier turns, persist them yourself, or fetch them from the Hume API.

`clearMessagesOnDisconnect` (default `true`) controls whether `messages` is
cleared when a call ends. Setting it to `false` keeps the previous call's
messages in the array across a reconnect, which is a different thing from
resuming a chat group and is often what people actually want visually.
:::

## Support and debugging

`chatMetadata` also carries `chatId` and `requestId`. Log them — they are what
Hume support needs to look up a specific conversation.

## Reference

- [`ConnectOptions`](/reference/api/voice-react.connectoptions)
- [`SessionSettingsUpdate`](/reference/api/voice-react.sessionsettingsupdate)
- [`ChatMetadataMessage`](/reference/api/voice-react.chatmetadatamessage)
- [`VoiceProviderProps.clearMessagesOnDisconnect`](/reference/api/voice-react.voiceproviderprops.clearmessagesondisconnect)
