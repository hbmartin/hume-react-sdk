---
description: "Hume's hosted voice widget as a React component."
---

# `@humeai/voice-embed-react`

Hume's prebuilt voice widget as a React component. `<EmbeddedVoice />` renders
the widget — hosted at [voice-widget.hume.ai][widget] — inside an iframe that
owns the EVI connection, the microphone, and audio playback. There is no UI to
build and nothing to style.

Use it when you want a working voice agent in an existing React app in minutes.
If you need the interface to match your own design, use
[`@humeai/voice-react`](./voice-react) instead.

This is a thin wrapper over [`@humeai/voice-embed`](./voice-embed): same widget,
same behavior, with a component API instead of an imperative one.

## Install

::: code-group

```sh [pnpm]
pnpm add @humeai/voice-embed-react
```

```sh [npm]
npm install @humeai/voice-embed-react
```

```sh [yarn]
yarn add @humeai/voice-embed-react
```

:::

## Quickstart

```tsx
'use client';

import { useState } from 'react';
import { EmbeddedVoice } from '@humeai/voice-embed-react';

export function App({ accessToken }: { accessToken: string }) {
  const [isEmbedOpen, setIsEmbedOpen] = useState(false);

  return (
    <>
      <button onClick={() => setIsEmbedOpen(true)}>Talk to us</button>
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: accessToken }}
        isEmbedOpen={isEmbedOpen}
        onMessage={(message) => console.log(message)}
        onClose={() => setIsEmbedOpen(false)}
      />
    </>
  );
}
```

::: danger Keep your API key off the client
The `auth` value is forwarded from the browser to the widget and used for the
WebSocket handshake, so it is visible to your end users. In production use
`{ type: 'accessToken' }` with a short-lived token minted by your server; reserve
`{ type: 'apiKey' }` for local prototyping. See [token authentication][token-auth].
The widget rejects an empty or missing credential rather than attempting to connect.
:::

## `isEmbedOpen` is not a two-way switch

This is the single most surprising thing in the API. Setting `isEmbedOpen` to
`true` opens the widget. Setting it back to `false` **cancels an open request
that is still waiting for the iframe to become ready** — but it does **not**
collapse a widget that is already open. Users close the widget through its own
UI, which fires `onClose`.

So keep your state synchronized by setting it to `false` from `onClose`, as the
quickstart above does. Treat `isEmbedOpen` as "please open", not as "is open".

## Server components

Instantiate `EmbeddedVoice` inside a client component. See the Next.js
documentation on [client components][next-client].

## Reference

| Symbol                                                                      | What it is                                 |
| --------------------------------------------------------------------------- | ------------------------------------------ |
| [`EmbeddedVoice`](/reference/api/voice-embed-react.embeddedvoice)           | The component                              |
| [`EmbeddedVoiceProps`](/reference/api/voice-embed-react.embeddedvoiceprops) | Every prop and its type                    |
| [`EmbeddedVoiceConfig`](/reference/api/voice-embed.embeddedvoiceconfig)     | The shared widget configuration it accepts |

Full signatures live in the
[`@humeai/voice-embed-react` API reference](/reference/api/voice-embed-react).

[widget]: https://voice-widget.hume.ai
[token-auth]: https://dev.hume.ai/docs/introduction/api-key#token-authentication
[next-client]: https://nextjs.org/docs/app/building-your-application/rendering/client-components
