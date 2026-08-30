---
description: 'What the SDK does for you, shown by an example that does none of it.'
---

# Raw EVI client (no SDK)

[`examples/vite-app`][source] uses **none of the packages in this repository**.
It talks to the Empathic Voice Interface directly through the
[`hume`][ts-sdk] TypeScript client, in about sixty lines of plain DOM code.

It is here as a contrast, because it answers a question the rest of these docs
cannot: what is `@humeai/voice-react` actually doing for you?

## What it does

`src/main.ts` builds a few DOM nodes, constructs a `HumeClient`, opens a socket
with `empathicVoice.chat.connect()`, and appends a timestamped line for each
`open`, `message`, and `close` event. That is the whole application.

## What it does not do

Every item below is something the SDK packages handle, and every item is work
you would otherwise write yourself:

- Requesting microphone permission and capturing audio
- Decoding and playing the assistant's audio output
- Queuing playback so chunks play in order
- Stopping playback when the user interrupts
- Enumerating audio devices, or switching them mid-call
- Keeping message history, and replacing interim transcripts in place
- Tracking connection state, classifying errors, and tearing down cleanly on
  disconnect — including when a disconnect races a failing connection

That list is the case for the SDK. If you want your own interface, use
[`@humeai/voice-react`](../guide/voice-react); if Hume's widget will do, use
[`@humeai/voice-embed`](../guide/voice-embed).

## A note on the API key

This example passes a raw API key from the browser, which is acceptable for a
local experiment and wrong for anything else — a Hume API key is a long-lived
secret that can bill your account. Production applications mint a short-lived
access token on a server; see [token authentication][token-auth], and the
[Next.js reference app](./next-app), which does exactly that.

[source]: https://github.com/HumeAI/hume-react-sdk/tree/main/examples/vite-app
[ts-sdk]: https://github.com/HumeAI/hume-typescript-sdk
[token-auth]: https://dev.hume.ai/docs/introduction/api-key#token-authentication
