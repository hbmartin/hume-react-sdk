# Embedded Voice Example

This Vite app demonstrates embedding the Hume voice widget in an iframe.

## Getting Started

Copy `.env.example` to `.env.local` and set `VITE_PUBLIC_HUME_API_KEY` to your
Hume API key. Then, from the repository root, run:

```bash
pnpm dev:iframe
```

Open [http://localhost:3002](http://localhost:3002) in your browser.

## Environment variables

| Variable                   | Required | Notes                                                            |
| -------------------------- | -------- | ---------------------------------------------------------------- |
| `VITE_PUBLIC_HUME_API_KEY` | yes      | Sent from the browser. Prototyping only — see the warning below. |
| `VITE_PUBLIC_HOSTNAME`     | no       | EVI hostname. Defaults to `api.hume.ai`.                         |
| `VITE_PUBLIC_RENDERER_URL` | no       | Where the widget itself is hosted. Defaults to the Hume widget.  |

The example uses the hosted Hume voice widget by default. To test against a
different renderer — a locally running one, for instance — set
`VITE_PUBLIC_RENDERER_URL` in `.env.local`:

```dotenv
VITE_PUBLIC_RENDERER_URL="http://localhost:3000"
```

> [!WARNING]
> This example passes a raw API key from the browser. A Hume API key is a
> long-lived secret that can bill your account, so production applications
> should pass a short-lived access token instead; see
> [token authentication](https://dev.hume.ai/docs/introduction/api-key#token-authentication).

Appending `?launchWidget=true` to the URL opens the widget on load, via the
`openOnMount` prop.
