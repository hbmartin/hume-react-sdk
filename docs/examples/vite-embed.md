---
description: "The smallest working embed of Hume's hosted voice widget."
---

# Embedded widget (Vite)

[`examples/vite-app-embed`][source] is the shortest path to a working voice
agent: one `<EmbeddedVoice />` component and a button, in about forty lines.

For setup and environment variables, see the [example's README][readme].

## What it shows

`src/App.tsx` renders a single `<EmbeddedVoice />` with:

- `auth` — an API key here, because it is a local example. Production
  applications pass a server-minted access token instead.
- `isEmbedOpen` — driven by a button. Remember that this opens the widget but
  cannot close it: only the widget's own UI does that, which is why `onClose`
  sets the state back to `false`. See
  [`@humeai/voice-embed-react`](../guide/voice-embed-react).
- `onMessage` and `onClose` — transcripts and the close signal.
- `rendererUrl` and `hostname` — both overridable from the environment.
- `openOnMount` — derived from a `?launchWidget=true` query parameter, so the
  widget can be opened by link.

## Testing against a local renderer

The widget itself is a separate application, hosted by default at
`voice-widget.hume.ai`. Point `VITE_PUBLIC_RENDERER_URL` at
`http://localhost:3000` to run this example against a local build of
[empathic-voice-embed-renderer][renderer]. Port 3000 is deliberately left free
across this repository's examples for exactly that.

[source]: https://github.com/HumeAI/hume-react-sdk/tree/main/examples/vite-app-embed
[readme]: https://github.com/HumeAI/hume-react-sdk/blob/main/examples/vite-app-embed/README.md
[renderer]: https://github.com/HumeAI/empathic-voice-embed-renderer
