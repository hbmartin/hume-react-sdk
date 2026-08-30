---
description: "Add Hume's hosted voice widget to any web application."
---

# Embedding the widget

Two packages render the same hosted widget — an iframe served from
`voice-widget.hume.ai` that owns the EVI connection, the microphone, and audio
playback. There is no UI to build and nothing to style.

| Package                                            | API                           | Use it when                               |
| -------------------------------------------------- | ----------------------------- | ----------------------------------------- |
| [`@humeai/voice-embed-react`](./voice-embed-react) | `<EmbeddedVoice />` component | Your app is React                         |
| [`@humeai/voice-embed`](./voice-embed)             | `create()` / `mount()`        | Vue, Svelte, Angular, or bundled plain JS |

If you need the interface to match your own design, neither is the right choice —
use [`@humeai/voice-react`](./voice-react) instead.

## Opening and closing is asymmetric

This is the single most confusing thing about the widget, in both packages.

**You can open it. You cannot close it.** Only the widget's own UI closes it,
which then invokes `onClose`.

In React, `isEmbedOpen` is a request rather than a mirror of state:

- Setting it `true` opens the widget.
- Setting it `false` **cancels an open request that has not been applied yet** —
  the iframe may still be loading. It does not collapse an open widget.

So the state must be resynchronized from `onClose`:

```tsx
const [isEmbedOpen, setIsEmbedOpen] = useState(false);

<EmbeddedVoice
  auth={{ type: 'accessToken', value: accessToken }}
  isEmbedOpen={isEmbedOpen}
  onClose={() => setIsEmbedOpen(false)}
/>;
```

The framework-agnostic package makes the same behavior explicit: `openEmbed()`
opens, and `cancelPendingOpen()` withdraws a not-yet-applied open request.

## Knowing when it is ready

The iframe loads asynchronously, so an `openEmbed()` issued immediately after
mounting is queued rather than lost. `onReady` fires once the iframe reports
readiness and any queued open request has been applied — use it to enable a
"Talk to us" button rather than letting people click into a widget that is not
listening yet.

## Transcripts

`onMessage` receives user and assistant transcripts as the conversation
proceeds. The widget owns the conversation, so this is a read-only view: there is
no equivalent of `sendUserInput`, tool handling, or device selection. Those
require [`@humeai/voice-react`](./voice-react).

## Opening from a link

Deriving `openOnMount` from a query parameter lets a link open straight into a
conversation:

```tsx
const openOnMount = new URLSearchParams(window.location.search).has(
  'launchWidget',
);
```

See the [embedded widget example](../examples/vite-embed).

## Self-hosting the renderer

`rendererUrl` points the iframe somewhere other than `voice-widget.hume.ai` — a
local build of [empathic-voice-embed-renderer][renderer], or your own deployment.

## Failure behavior

`mount()` never throws. If attaching the iframe fails it rolls back cleanly and
returns a no-op unmount, so a widget failure cannot take down the page around it.

## Authentication

Same rules as everywhere else: the credential is forwarded to the widget and used
for the handshake, so it is visible to end users. Use a server-minted access
token in production. See [Authentication](./authentication).

[renderer]: https://github.com/HumeAI/empathic-voice-embed-renderer
