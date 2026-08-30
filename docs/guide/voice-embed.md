---
description: "Hume's hosted voice widget for browser applications that do not use React."
---

# `@humeai/voice-embed`

Hume's prebuilt voice widget with an imperative API instead of a component. The
widget — hosted at [voice-widget.hume.ai][widget] — runs in an iframe that owns
the EVI connection, the microphone, and audio playback.

The package has no React dependency, so it works in Vue, Svelte, Angular, or any
bundled application that consumes npm packages. **If you are on React, prefer
[`@humeai/voice-embed-react`](./voice-embed-react)** — same widget, and it
manages the mount lifecycle for you.

## Install

::: code-group

```sh [pnpm]
pnpm add @humeai/voice-embed
```

```sh [npm]
npm install @humeai/voice-embed
```

```sh [yarn]
yarn add @humeai/voice-embed
```

:::

## Quickstart

`EmbeddedVoice.create()` builds the widget; `mount()` attaches it to the page and
returns a function that tears it down again.

```ts
import { EmbeddedVoice } from '@humeai/voice-embed';

const widget = EmbeddedVoice.create({
  auth: { type: 'accessToken', value: accessToken },
  onMessage: (message) => {
    console.log(message);
  },
  onClose: () => {
    console.log('The user closed the widget.');
  },
});

// Attach the widget. Pass an element to mount into a container of your own.
const unmount = widget.mount();

// Open it from a click handler, or pass `openOnMount: true` above.
document.querySelector('#talk')?.addEventListener('click', () => {
  widget.openEmbed();
});

// Later, when tearing down the page:
unmount();
```

::: danger Keep your API key off the client
The `auth` value is forwarded from the browser to the widget and used for the
WebSocket handshake, so it is visible to your end users. In production use
`{ type: 'accessToken' }` with a short-lived token minted by your server; reserve
`{ type: 'apiKey' }` for local prototyping. See [token authentication][token-auth].
:::

## Controlling visibility

Visibility is imperative rather than declarative:

- `openEmbed()` opens the widget.
- `cancelPendingOpen()` withdraws an open request that is still waiting for the
  iframe to become ready.
- Users close the widget through its own UI, which invokes `onClose`.

`mount()` is deliberately forgiving: if attaching the iframe fails it rolls back
cleanly and returns a no-op unmount rather than throwing, so a widget failure
never takes down the surrounding page.

## Server components

Instantiate `EmbeddedVoice` inside a client component. See the Next.js
documentation on [client components][next-client].

## Reference

| Symbol                                                                  | What it is                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`EmbeddedVoice`](/reference/api/voice-embed.embeddedvoice)             | The widget handle: `create`, `mount`, `openEmbed`, `cancelPendingOpen` |
| [`EmbeddedVoiceConfig`](/reference/api/voice-embed.embeddedvoiceconfig) | Authentication and session options                                     |
| [`SocketConfig`](/reference/api/voice-embed.socketconfig)               | Connection settings forwarded to EVI                                   |

Full signatures live in the
[`@humeai/voice-embed` API reference](/reference/api/voice-embed).

[widget]: https://voice-widget.hume.ai
[token-auth]: https://dev.hume.ai/docs/introduction/api-key#token-authentication
[next-client]: https://nextjs.org/docs/app/building-your-application/rendering/client-components
