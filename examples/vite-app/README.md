# Raw EVI client example (`hume` TypeScript SDK, no React SDK)

**This example deliberately uses none of the packages in this repository.** It
talks to the Empathic Voice Interface directly through the
[`hume`](https://github.com/HumeAI/hume-typescript-sdk) TypeScript client, in
about sixty lines of plain DOM code.

It exists as a contrast. It answers the question the rest of the documentation
cannot: what is `@humeai/voice-react` actually doing for you?

## Running it

```sh
cp .env.example .env.local   # then set VITE_HUME_API_KEY
```

From the repository root:

```sh
pnpm --filter example-vite-app dev
```

Then open <http://localhost:3001>.

| Variable            | Required | Notes                                                |
| ------------------- | -------- | ---------------------------------------------------- |
| `VITE_HUME_API_KEY` | yes      | Sent from the browser. Prototyping only — see below. |

> [!WARNING]
> This example passes a raw API key from the browser, which is fine for a local
> experiment and wrong for anything else. A Hume API key is a long-lived secret
> that can bill your account. Production applications mint a short-lived access
> token on a server; see
> [token authentication](https://dev.hume.ai/docs/introduction/api-key#token-authentication).

## What it does

Opens a WebSocket with `HumeClient.empathicVoice.chat.connect()` and appends a
timestamped line to the page for each `open`, `message`, and `close` event.

## What it does not do

Everything in this list is what the SDK packages provide:

- Capture the microphone, or ask for permission
- Decode and play the assistant's audio
- Queue playback so chunks play in order
- Stop playback when the user interrupts
- Enumerate or switch audio devices
- Keep message history, or reconcile interim transcripts
- Manage connection state, teardown, or error classification

If you want those, use [`@humeai/voice-react`](../../packages/react) for your own
interface, or [`@humeai/voice-embed`](../../packages/embed) for Hume's prebuilt
widget. See [examples/next-app](../next-app) for a complete application.
