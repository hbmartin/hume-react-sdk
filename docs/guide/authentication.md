---
description: 'Mint short-lived access tokens on your server and keep your API key off the client.'
---

# Authentication

Every EVI connection is authenticated at the WebSocket handshake, using a
credential you supply from the browser. Because it travels from the browser, **it
is visible to your end users** — which decides how you should get one.

## Two strategies

| Strategy                         | Use it                 | Why                                                                  |
| -------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `{ type: 'accessToken', value }` | In production          | Short-lived, minted by your server, and safe to expose to the client |
| `{ type: 'apiKey', value }`      | Local prototyping only | A long-lived secret that can bill your account                       |

Your Hume API key and secret key must never reach the browser. Treat
`{ type: 'apiKey' }` as a convenience for a local experiment and nothing more.

## Minting a token on the server

Use `fetchAccessToken` from the `hume` package, which is a dependency of
`@humeai/voice-react`, and call it somewhere the secret key is safe — a server
component, a route handler, or your own backend.

If you use a route handler, authenticate and authorize the application user
before minting or returning a cached token. A same-origin URL, CORS policy, or
`Origin` header is not user authentication; callers that can reach an open
route can otherwise spend the Hume account associated with your credentials.

```tsx
// app/page.tsx — a React Server Component
import { fetchAccessToken } from 'hume';

import { Call } from './call';

export default async function Home() {
  const accessToken = await fetchAccessToken({
    apiKey: process.env['HUME_API_KEY'],
    secretKey: process.env['HUME_SECRET_KEY'],
  });

  return <Call accessToken={accessToken} />;
}
```

Only the token crosses into the client component. In Next.js, note that anything
prefixed `NEXT_PUBLIC_` is embedded in the client bundle — so the API key and
secret key must **not** carry that prefix.

Degrading gracefully when the keys are missing makes the app much easier to pick
up; `examples/next-app` renders a short setup screen rather than throwing. See
the [Next.js reference app](../examples/next-app).

## Passing it to `connect`

```tsx
void connect({
  auth: { type: 'accessToken', value: accessToken },
  configId: '<YOUR_CONFIG_ID>',
});
```

`auth` belongs on `connect()`, not on `VoiceProvider` — it describes one session,
so refreshing a token does not remount your tree. See
[`@humeai/voice-react`](./voice-react).

## When a credential is rejected

`connect` validates the credential **before** requesting microphone access, so a
missing or empty value fails fast without triggering a permission prompt. The
failure does not reject the promise: it surfaces through `onError` and `status`
as a `socket_error` with reason `socket_connection_failure`. See
[Errors and reconnection](./error-handling).

## Refreshing an expired token

Access tokens are short-lived. A token that expires mid-call does not interrupt
the call — the socket is already authenticated — but the next `connect` with it
will fail. Fetch a fresh token before reconnecting rather than reusing the one
you rendered with.

## Two `connect` calls at once

If a second `connect()` starts while the first is still in flight **with
different credentials**, the second is rejected with a
`ConcurrentConnectAuthError`. This is deliberate: silently keeping the first
attempt would discard the newer, probably-refreshed credentials.

```tsx
import { isConcurrentConnectAuthError } from '@humeai/voice-react';

try {
  await connect({ auth: { type: 'accessToken', value: accessToken } });
} catch (error) {
  if (isConcurrentConnectAuthError(error)) {
    // A connection attempt with different credentials is already running.
  }
}
```

A duplicate call with the _same_ credentials is harmless — it joins the attempt
already in flight.

## Reference

- [`AuthStrategy`](/reference/api/voice-react.authstrategy)
- [`ConnectOptions`](/reference/api/voice-react.connectoptions)
- [`ConcurrentConnectAuthError`](/reference/api/voice-react.concurrentconnectautherror)
- [Hume: token authentication](https://dev.hume.ai/docs/introduction/api-key#token-authentication)
