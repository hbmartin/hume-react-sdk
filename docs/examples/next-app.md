---
description: 'An annotated tour of the full-surface Next.js reference application.'
---

# Next.js reference app

[`examples/next-app`][source] is the most complete application in the
repository. It exercises nearly all of `@humeai/voice-react` in one Next.js App
Router app — connection lifecycle, tool calling, live audio device switching,
message history, and FFT visualization.

This page is a tour of what each part demonstrates and which guide covers it.
For setup and environment variables, see the [example's README][readme].

## Minting and refreshing a token on the server

`app/page.tsx` is a server component. It checks that the API key and secret key
exist and renders a setup screen when they do not, which is why the app is safe
to start before filling in `.env.local`.

The credentials themselves live behind a module marked `server-only`.
`app/api/access-token/route.ts` calls `fetchAccessToken`, validates the result,
and returns only the short-lived token through a private, non-cacheable
response. The server reuses a token for at most 25 minutes, while
`components/ExampleComponent.tsx` calls the route again before that window
ends. A tab can therefore reconnect after the original token expires without
ever receiving the long-lived API key or secret key.

→ [`@humeai/voice-react` guide](../guide/voice-react)

## Provider configuration

`components/Voice.tsx` mounts `VoiceProvider` with every lifecycle callback
wired (`onOpen`, `onMessage`, `onError`, `onAudioStart`, `onAudioEnd`,
`onInterruption`, and `onClose`, which checks the close code), plus
`messageHistoryLimit` and a checkbox that toggles `enableAudioWorklet` at
runtime.

## Tool calling

The most substantial part of the example, also in `components/Voice.tsx`: a
complete `ToolCallHandler` implementing a `weather_tool`. It resolves a location to coordinates
through `geocode.maps.co`, fetches a forecast from `api.weather.gov`, and
validates every hop with zod before returning `response.success(...)` — or
`response.error({ code, level, content })` when a step fails. Unrecognized tool
names fall through to a `tool_not_found` error.

Note that `toolCall.parameters` arrives as a **JSON string**, so the handler
parses it before validating.

Tool calling requires an EVI configuration that defines the tool, so the example
gates this UI on `HUME_CONFIG_ID`. It also sets
`sessionSettings.builtinTools: [{ name: 'web_search' }]` when a config is
present.

## Connection state

`components/ExampleComponent.tsx` matches exhaustively over `status.value` with
`ts-pattern`'s `.exhaustive()`, so a new status becomes a type error rather than
a silently unhandled branch. It also validates token-route responses and shows
token or connection failures beside the connect control rather than allowing an
unhandled promise rejection.

## Audio devices

The same file drives `useAudioDevices()` for enumeration and permission, and
switches microphone and speaker mid-call with `setInputDevice` and
`setOutputDevice`, tracking in-flight state and catching failures with
`isAudioDeviceSwitchError`.

## Call controls and conversation state

`components/ChatConnected.tsx` covers the rest of `useVoice()`: mute and unmute
for both microphone and playback, `pauseAssistant` and `resumeAssistant`,
`setVolume`, sending text as either the user or the assistant, and reading
`messages`, `chatMetadata`, `readyState`, `playerQueueLength`, and
`lastAssistantProsodyMessage`.

## Visualization

`components/Waveform.tsx` renders `useMicFft()` and `usePlayerFft()`. Both
update at display refresh rate and bypass the main voice context, so only this
component rerenders as audio plays.

[source]: https://github.com/HumeAI/hume-react-sdk/tree/main/examples/next-app
[readme]: https://github.com/HumeAI/hume-react-sdk/blob/main/examples/next-app/README.md
