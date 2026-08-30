# Hume EVI React example (Next.js)

The full-surface reference application for
[`@humeai/voice-react`](../../packages/react). It exercises nearly every part of
the package — connection lifecycle, tool calling, live audio device switching,
message history, and FFT visualization — in one Next.js App Router app.

For an annotated tour of what each file demonstrates, see the
[Examples section of the documentation site](https://humeai.github.io/hume-react-sdk/examples/next-app).

## Prerequisites

- A [Hume account](https://platform.hume.ai) with an API key and a secret key.
- Optionally, an EVI configuration that defines a `weather_tool` function tool.
  Without it the app runs normally and tool calling is disabled.
- Optionally, a [geocode.maps.co](https://geocode.maps.co) API key, used only by
  the weather tool.

## Running it

```sh
cp .env.example .env.local   # then fill in your keys
```

From the repository root:

```sh
pnpm install
pnpm --filter example-next-app dev
```

Then open <http://localhost:3003>. (`pnpm dev` from the root starts this app
alongside every package and the other examples.)

If the API key or secret key is missing, the app renders a short setup screen
instead of failing — so it is safe to start before filling in `.env.local`.

## Environment variables

| Variable                          | Required | Notes                                                             |
| --------------------------------- | -------- | ----------------------------------------------------------------- |
| `HUME_API_KEY`                    | yes      | Server-side only. Used to mint an access token.                   |
| `HUME_SECRET_KEY`                 | yes      | Server-side only. Used to mint an access token.                   |
| `HUME_CONFIG_ID`                  | no       | An EVI configuration ID. Enables tool calling and built-in tools. |
| `NEXT_PUBLIC_HUME_VOICE_HOSTNAME` | no       | Defaults to `api.hume.ai`.                                        |
| `NEXT_PUBLIC_GEOCODE_API_KEY`     | no       | Only used by the weather tool.                                    |

`HUME_API_KEY`, `HUME_SECRET_KEY`, and `HUME_CONFIG_ID` deliberately have no
`NEXT_PUBLIC_` prefix: they are read in a server component and must never reach
the browser. Anything prefixed `NEXT_PUBLIC_` is embedded in the client bundle
and is public.

## What this demonstrates

| File                              | Shows                                                                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/page.tsx`                    | Minting a short-lived access token server-side with `fetchAccessToken`, and degrading gracefully when keys are absent                                                                                                                                      |
| `components/Voice.tsx`            | `VoiceProvider` with every lifecycle callback, `messageHistoryLimit`, an `enableAudioWorklet` toggle, and a complete `ToolCallHandler` — a weather tool that resolves a location to coordinates, calls `api.weather.gov`, and validates every hop with zod |
| `components/ExampleComponent.tsx` | Exhaustive `status.value` handling, live microphone and speaker switching during a call, and `AudioDeviceSwitchError` handling                                                                                                                             |
| `components/ChatConnected.tsx`    | Mute, pause and resume, volume, text input as user or assistant, `chatMetadata`, `readyState`, and prosody                                                                                                                                                 |
| `components/Waveform.tsx`         | Rendering `useMicFft()` and `usePlayerFft()`                                                                                                                                                                                                               |

## Without a configuration ID

The app runs without `HUME_CONFIG_ID`. Tool calling and built-in tools are
disabled and the UI says so — the rest of the conversation works normally.

## See also

- [`@humeai/voice-react` guide](https://humeai.github.io/hume-react-sdk/guide/voice-react)
- [API reference](https://humeai.github.io/hume-react-sdk/reference/api/voice-react)
- [EVI Next.js Starter](https://github.com/humeai/hume-evi-next-js-starter) — the
  deployable template to fork for a real project
