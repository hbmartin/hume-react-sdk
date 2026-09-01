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

Then open <http://127.0.0.1:3003>. The example binds to the IPv4 loopback interface,
so other machines cannot reach its development token endpoint. (`pnpm dev` from
the root starts this app alongside every package and the other examples.)

If the API key or secret key is missing, the app renders a short setup screen
instead of failing — so it is safe to start before filling in `.env.local`.
Once configured, the browser requests a short-lived access token from the
same-origin `/api/access-token` route. The route never exposes the API key or
secret key. It reads the OAuth response's actual expiration duration, reuses a
token for five-sixths of that duration, and tells the client when to refresh
using relative durations so server and browser clock skew cannot affect it.

This repository has no application user or session model, so the route is
deliberately local-development-only and returns `403` in production. Before
deploying, replace `isHumeAccessTokenRequestAuthorized()` with a server-verified
session and authorization check. Run that check before consulting the shared
token cache. CORS, `Origin` checks, and a secret shipped to the browser are not
substitutes for authenticating the user.

## Environment variables

| Variable                          | Required | Notes                                                             |
| --------------------------------- | -------- | ----------------------------------------------------------------- |
| `HUME_API_KEY`                    | yes      | Server-side only. Used to mint an access token.                   |
| `HUME_SECRET_KEY`                 | yes      | Server-side only. Used to mint an access token.                   |
| `HUME_TOKEN_HOSTNAME`             | no       | Trusted server-side OAuth host. Defaults to `api.hume.ai`.        |
| `HUME_CONFIG_ID`                  | no       | A non-secret EVI configuration ID. Enables tools in this example. |
| `NEXT_PUBLIC_HUME_VOICE_HOSTNAME` | no       | Defaults to `api.hume.ai`.                                        |
| `NEXT_PUBLIC_GEOCODE_API_KEY`     | no       | Only used by the weather tool.                                    |

`HUME_API_KEY` and `HUME_SECRET_KEY` are server-only secrets and must never
reach the browser. `HUME_CONFIG_ID` is not a secret: this example reads it in a
server component, exposes it to the client as a prop, and passes it to
`connect()` when configuration is required. Anything prefixed `NEXT_PUBLIC_`
is embedded in the client bundle and is public.

`NEXT_PUBLIC_HUME_VOICE_HOSTNAME` is intentionally public and controls only the
client-side EVI connection. The server sends the API key and secret key only to
`HUME_TOKEN_HOSTNAME`, which is server-only and defaults to `api.hume.ai`. When
using another trusted Hume environment, set both hosts explicitly; never
derive `HUME_TOKEN_HOSTNAME` from browser input or another public setting.

## What this demonstrates

| File                              | Shows                                                                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/page.tsx`                    | Detecting missing server credentials and rendering a setup screen without making an OAuth request                                                                                                                                                          |
| `app/api/access-token/route.ts`   | Authorizing a local request before returning a measured, short-lived access-token lease through a private, non-cacheable response                                                                                                                          |
| `components/Voice.tsx`            | `VoiceProvider` with every lifecycle callback, `messageHistoryLimit`, an `enableAudioWorklet` toggle, and a complete `ToolCallHandler` — a weather tool that resolves a location to coordinates, calls `api.weather.gov`, and validates every hop with zod |
| `components/ExampleComponent.tsx` | Access-token refresh, exhaustive `status.value` handling, live microphone and speaker switching during a call, and `AudioDeviceSwitchError` handling                                                                                                       |
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
