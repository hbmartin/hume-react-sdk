# Getting started

The SDK is split into three packages. Choose based on how much of the interface
you want Hume to provide.

| Package                                                 | Choose it when                                             | Interface ownership |
| ------------------------------------------------------- | ---------------------------------------------------------- | ------------------- |
| [`@humeai/voice-react`](/guide/voice-react)             | You use React and want complete control over the interface | Your application    |
| [`@humeai/voice-embed-react`](/guide/voice-embed-react) | You use React and want Hume's hosted widget                | Hume                |
| [`@humeai/voice-embed`](/guide/voice-embed)             | You do not use React and want Hume's hosted widget         | Hume                |

## Install a package

::: code-group

```sh [Headless React]
pnpm add @humeai/voice-react
```

```sh [Embedded React]
pnpm add @humeai/voice-embed-react
```

```sh [Framework-agnostic embed]
pnpm add @humeai/voice-embed
```

:::

Continue with the package guide for prerequisites, authentication, and working
examples. When you need exact types or signatures, use the
[generated API reference](/reference/).

## Requirements

- A modern browser for microphone input and audio playback.
- Node.js 18 or newer in applications consuming the packages.
- A Hume API key or a server-generated access token.

Do not embed a secret API key in public client-side code. For production browser
applications, mint short-lived access tokens from a trusted server.
