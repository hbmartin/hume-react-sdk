---
description: 'Runnable applications built with the Hume Voice SDK packages.'
---

# Examples

Three applications live in this repository, and two more are maintained
elsewhere. They serve different purposes, and it is worth knowing which is which.

**The in-repo examples exist to exercise the SDK during development.** They are
workspace members, built and typechecked on every CI run, and they deliberately
cover edge cases rather than showing the shortest path. **The starter template is
what you fork for a real project.**

| Example                             | Package                     | Shows                                                      | Where               |
| ----------------------------------- | --------------------------- | ---------------------------------------------------------- | ------------------- |
| [Next.js reference app](./next-app) | `@humeai/voice-react`       | The full surface: tools, devices, lifecycle, visualization | in repo, port 3003  |
| [Embedded widget](./vite-embed)     | `@humeai/voice-embed-react` | The smallest working widget embed                          | in repo, port 3002  |
| [Raw EVI client](./raw-client)      | none                        | What the SDK does for you, by omission                     | in repo, port 3001  |
| [EVI Next.js Starter][starter]      | `@humeai/voice-react`       | A deployable production template                           | separate repository |
| [hume-api-examples][api-examples]   | various                     | Hume's canonical cross-SDK collection                      | separate repository |

[`hume-api-examples`][api-examples] is the collection Hume maintains across all
its SDKs, and this repository's CI builds `@humeai/voice-react` against its
`evi-next-js-app-router-quickstart` on every pull request — so that example is
the SDK's integration target, not just a sample.

## Running them

Clone the repository, then from its root:

```sh
pnpm install
pnpm dev            # every package and example
pnpm dev:iframe     # the packages and the embed example only
```

Each example needs its own credentials. Copy the `.env.example` in its directory
to `.env.local` and fill it in first.

| Example                   | Workspace name           | URL                     |
| ------------------------- | ------------------------ | ----------------------- |
| `examples/next-app`       | `example-next-app`       | `http://127.0.0.1:3003` |
| `examples/vite-app-embed` | `example-vite-app-embed` | `http://localhost:3002` |
| `examples/vite-app`       | `example-vite-app`       | `http://localhost:3001` |

Ports are fixed, and port 3000 is left free for a locally running widget
renderer. To start one example alone, use
`pnpm --filter <workspace-name> dev`.

[starter]: https://github.com/humeai/hume-evi-next-js-starter
[api-examples]: https://github.com/HumeAI/hume-api-examples
