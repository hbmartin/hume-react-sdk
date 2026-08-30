---
description: 'Headless hooks and components for building a custom React voice interface.'
---

# `@humeai/voice-react`

Headless React bindings for Hume's [Empathic Voice Interface][evi]. The package
ships no UI: it manages the EVI WebSocket, microphone capture, the audio
playback queue, and message history, and leaves the interface to you.

Use it when you want a voice experience that matches your product's design, or
that needs raw access to messages, tool calls, and prosody scores. If you would
rather drop in Hume's prebuilt widget, see
[`@humeai/voice-embed-react`](./voice-embed-react).

::: warning Not compatible with React Native
This package uses Web Audio and `getUserMedia` for microphone input and audio
playback. It runs in bundled web applications (Next.js, Vite, Webpack) only.
:::

## Install

::: code-group

```sh [pnpm]
pnpm add @humeai/voice-react
```

```sh [npm]
npm install @humeai/voice-react
```

```sh [yarn]
yarn add @humeai/voice-react
```

:::

## Quickstart

Two pieces: a `VoiceProvider` somewhere above your voice UI, and a component
that calls `connect()` from a user gesture.

```tsx
// app/providers.tsx
'use client';

import { VoiceProvider } from '@humeai/voice-react';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <VoiceProvider onError={(error) => console.error(error)}>
      {children}
    </VoiceProvider>
  );
}
```

```tsx
// app/call.tsx
'use client';

import { useVoice } from '@humeai/voice-react';

export function Call({ accessToken }: { accessToken: string }) {
  const { connect, disconnect, status, messages } = useVoice();

  return (
    <div>
      {status.value === 'connected' ? (
        <button onClick={() => void disconnect()}>End call</button>
      ) : (
        <button
          onClick={() =>
            void connect({
              auth: { type: 'accessToken', value: accessToken },
              configId: '<YOUR_CONFIG_ID>',
            })
          }
        >
          Start call
        </button>
      )}

      <ul>
        {messages.map((message, index) =>
          message.type === 'user_message' ||
          message.type === 'assistant_message' ? (
            <li key={index}>
              <strong>{message.message.role}:</strong> {message.message.content}
            </li>
          ) : null,
        )}
      </ul>
    </div>
  );
}
```

::: danger Keep your API key off the client
The credential you pass to `connect` is sent from the browser as part of the
WebSocket handshake, so anything you put there is visible to your end users.
Your Hume API key is a long-lived secret that can bill your account. In
production always use `{ type: 'accessToken' }` with a short-lived token minted
by your server; reserve `{ type: 'apiKey' }` for local prototyping. See
[token authentication][token-auth].
:::

::: warning Connect from a user gesture
The SDK uses the AudioContext API, which
[must be initialized by a user gesture][autoplay]. Call `connect` from a click
handler — never from a `useEffect` on mount.
:::

## `VoiceProvider` versus `connect()`

The split trips people up, and it is deliberate:

- **`VoiceProvider` props describe the component's lifetime** — the lifecycle
  callbacks (`onMessage`, `onError`, `onOpen`, `onClose`, `onToolCall`, and the
  audio and recording callbacks), plus `clearMessagesOnDisconnect`,
  `messageHistoryLimit`, `enableAudioWorklet`, and `diagnostics`.
- **`connect()` options describe one session** — `auth`, `hostname`, `configId`,
  `configVersion`, `verboseTranscription`, `resumedChatGroupId`,
  `sessionSettings`, `audioConstraints`, and `devices`.

Session settings moved off the provider in 0.2.0 precisely so that refreshing a
token or switching configs does not remount your tree. See the
[migration guide](./migration).

## Guides

| Guide                                               | Covers                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| [Authentication](./authentication)                  | Minting access tokens, and keeping your API key off the client    |
| [Tool calls](./tool-calls)                          | Implementing function tools and rendering their status            |
| [Errors and reconnection](./error-handling)         | The `VoiceError` taxonomy, what rejects, and building a reconnect |
| [Session settings and resuming](./session-settings) | Per-call configuration, and continuing an earlier conversation    |
| [Interruptions](./interruptions)                    | What happens on barge-in                                          |
| [Expression measurement](./expression-measurement)  | Reading and rendering prosody scores                              |
| [Audio devices](./audio-devices)                    | Enumerating and switching microphones and speakers                |
| [Audio visualizations](./visualizations)            | Waveforms and a call timer, without extra rerenders               |
| [Diagnostics and logging](./diagnostics)            | Structured events for debugging a call                            |
| [Next.js and server rendering](./nextjs)            | Client boundaries, server-side tokens, SSR safety                 |

## Reference

Every export is documented with its exact signature in the
[`@humeai/voice-react` API reference](/reference/api/voice-react). The entry
points most people want:

| Symbol                                                                | What it is                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`VoiceProvider`](/reference/api/voice-react.voiceprovider)           | Context provider; owns the socket, microphone, and playback     |
| [`VoiceProviderProps`](/reference/api/voice-react.voiceproviderprops) | Every provider prop and its type                                |
| [`useVoice`](/reference/api/voice-react.usevoice)                     | Connection controls, message senders, audio controls, and state |
| [`VoiceContextType`](/reference/api/voice-react.voicecontexttype)     | The full shape `useVoice()` returns                             |
| [`ConnectOptions`](/reference/api/voice-react.connectoptions)         | Everything `connect()` accepts                                  |
| [`useAudioDevices`](/reference/api/voice-react.useaudiodevices)       | Enumerate and select microphones and speakers                   |

[evi]: https://dev.hume.ai
[token-auth]: https://dev.hume.ai/docs/introduction/api-key#token-authentication
[autoplay]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices#autoplay_policy
