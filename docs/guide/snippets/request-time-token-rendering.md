The page must perform authorization and decide which token to return at request
time; do not cache its rendered output. A server-side token cache may reuse a
Hume token after the per-request authorization check. For the App Router caching
model used by the reference app, `dynamic = 'force-dynamic'` guarantees
request-time rendering. If your application enables Next.js Cache Components,
that segment option is no longer needed or supported; keep authorization and any
token-bearing result request-bound and do not place them behind `use cache`.
