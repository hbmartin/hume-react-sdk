# API reference

The reference is generated from the public TypeScript declarations emitted by
each package. It describes the repository's latest `main` branch.

- [`@humeai/voice-react`](./api/voice-react.md) — headless React components,
  hooks, stores, messages, audio controls, and diagnostics.
- [`@humeai/voice-embed-react`](./api/voice-embed-react.md) — the React wrapper
  for Hume's hosted widget.
- [`@humeai/voice-embed`](./api/voice-embed.md) — the framework-agnostic hosted
  widget API and message types.

Internal plumbing is excluded: hooks and stores that exist only to wire
`VoiceProvider` together are marked `@internal` and do not appear here, even
though they remain importable at runtime. Treat anything absent from this
reference as unsupported.
