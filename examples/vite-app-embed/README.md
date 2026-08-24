# Embedded Voice Example

This Vite app demonstrates embedding the Hume voice widget in an iframe.

## Getting Started

Copy `.env.example` to `.env.local` and set `VITE_PUBLIC_HUME_API_KEY` to your
Hume API key. Then, from the repository root, run:

```bash
pnpm dev:iframe
```

Open [http://localhost:3002](http://localhost:3002) in your browser.

The example uses the hosted Hume voice widget by default. To test against a
different renderer, set `VITE_PUBLIC_RENDERER_URL` in `.env.local`; for example:

```dotenv
VITE_PUBLIC_RENDERER_URL="http://localhost:3000"
```
