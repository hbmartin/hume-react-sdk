---
description: 'Client boundaries, server-side token minting, and SSR safety in Next.js.'
---

# Next.js and server rendering

`@humeai/voice-react` uses Web Audio and `getUserMedia`, so everything that
touches it runs in the browser. The interesting part of a Next.js integration is
therefore the boundary: what stays on the server, and what crosses it.

## Client boundaries

`VoiceProvider` and every component calling `useVoice`, `useAudioDevices`,
`usePlayerFft`, `useMicFft`, or `useCallDurationTimestamp` must be a **client
component**.

```tsx
// components/providers.tsx
'use client';

import { VoiceProvider } from '@humeai/voice-react';

export function VoiceProviders({ children }: { children: React.ReactNode }) {
  return <VoiceProvider>{children}</VoiceProvider>;
}
```

A server component can render that provider and pass props into it — which is
exactly how the token gets across.

## Minting the token on the server

```tsx
// app/page.tsx — a server component; no 'use client'
import { fetchAccessToken } from 'hume';

import { VoiceProviders } from '../components/providers';
import { Call } from '../components/call';
import { requireHumeAccess } from '../lib/require-hume-access';

export const dynamic = 'force-dynamic';

export default async function Home() {
  await requireHumeAccess();

  const accessToken = await fetchAccessToken({
    apiKey: process.env['HUME_API_KEY'],
    secretKey: process.env['HUME_SECRET_KEY'],
  });

  return (
    <VoiceProviders>
      <Call accessToken={accessToken} />
    </VoiceProviders>
  );
}
```

A server component is not an authorization boundary: the rendered token crosses
into the requesting browser. Here, `requireHumeAccess` represents an
application-owned helper that verifies a signed server-side session and rejects
or redirects unauthorized users. Protect the page itself and run this check
before consulting a token cache or minting a token.

<!--@include: ./snippets/request-time-token-rendering.md-->

A route handler works equally well if you would rather fetch the token from the
client on demand — useful when a page is statically rendered, or when a session
outlives the token. The same authentication and authorization requirement applies
to Server Actions, route handlers, `getServerSideProps`, and custom backends. Do
not treat same-origin fetching or CORS as authorization.

::: danger `NEXT_PUBLIC_` means public
Anything prefixed `NEXT_PUBLIC_` is inlined into the client bundle. `HUME_API_KEY`
and `HUME_SECRET_KEY` must **not** carry that prefix — they belong on the server
only. See [Authentication](./authentication).
:::

Rendering a setup screen when the keys are absent, rather than throwing, makes an
app much friendlier to clone; `examples/next-app` does this.

## Server rendering is safe

The provider and hooks render on the server without special handling. The FFT
and call-duration stores implement `getServerSnapshot`, so:

- `usePlayerFft()` and `useMicFft()` return `[]` on the server
- `useCallDurationTimestamp()` returns `null`

Those are the same values they have before a call starts, so there is no
hydration mismatch — a waveform component renders empty on the server and stays
empty until audio plays.

## Connect from a user gesture

The AudioContext must be started by a user gesture, which is a browser rule
rather than a Next.js one but bites hardest in App Router code, where it is
tempting to kick a call off in an effect.

✅ Call `connect` from an `onClick`.
❌ Do not call `connect` in a `useEffect` on mount.

## App Router versus Pages Router

Both work. In the Pages Router there are no server components, so mint the token
in `getServerSideProps` or an API route and pass it down as a prop; everything
else is the same.

## The embed packages

`@humeai/voice-embed-react` has the same constraint for the same reason:
instantiate `EmbeddedVoice` inside a client component. See
[`@humeai/voice-embed-react`](./voice-embed-react).

## See also

- [Next.js reference app](../examples/next-app) — a complete working integration
- [EVI Next.js Starter](https://github.com/humeai/hume-evi-next-js-starter) — a
  deployable template
- [Next.js: client components][next-client]

[next-client]: https://nextjs.org/docs/app/building-your-application/rendering/client-components
