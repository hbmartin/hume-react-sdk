<div align="center">
  <img src="https://storage.googleapis.com/hume-public-logos/hume/hume-banner.png" alt="Hume AI">
  <h1>@humeai/voice-embed-react</h1>
  <p>
    <strong>Integrate Hume's Empathic Voice Interface directly into your web application</strong>
  </p>
</div>

## Overview

This package enables you to integrate a widget that runs Hume's Empathic Voice Interface into your React application. It abstracts away the complexities of managing websocket connections, capturing user audio via the client's microphone, and handling the playback of the interface's audio responses. The widget is embedded into your web page through an iframe.

There are two packages needed to embed your own widget. Install this package to embed the widget to your application. Code for the widget itself can be found at [https://github.com/HumeAI/empathic-voice-embed-renderer](https://github.com/HumeAI/empathic-voice-embed-renderer).

## Prerequisites

Before installing this package, please ensure your development environment meets the following requirement:

- Node.js (`v18.0.0` or higher).

To verify your Node.js version, run this command in your terminal:

```sh
node --version
```

If your Node.js version is below `18.0.0`, update it to meet the requirement. For updating Node.js, visit [Node.js' official site](https://nodejs.org/) or use a version management tool like nvm for a more seamless upgrade process.

## Installation

Add `@humeai/voice-embed-react` to your project by running this command in your project directory:

```bash
npm install @humeai/voice-embed-react
```

This will download and include the package in your project, making it ready for import and use within your React components.

```tsx
import { EmbeddedVoice } from '@humeai/voice-embed-react';
```

## Usage

### Quickstart

Here's a simple example to get you started with the `EmbeddedVoice` component:

```tsx
import React, { useState } from 'react';
import { EmbeddedVoice } from '@humeai/voice-embed-react';

function App({ accessToken }: { accessToken: string }) {
  const [isEmbedOpen, setIsEmbedOpen] = useState(false);

  return (
    <div>
      <button onClick={() => setIsEmbedOpen(true)}>Open Widget</button>
      <EmbeddedVoice
        auth={{ type: 'accessToken', value: accessToken }}
        onMessage={(msg) => console.log('Message received: ', msg)}
        onClose={() => setIsEmbedOpen(false)}
        isEmbedOpen={isEmbedOpen}
      />
    </div>
  );
}
```

**Keep your API key off the client.** The `auth` value is forwarded from the browser to the widget and used for the WebSocket handshake, so it is visible to your end users. Your Hume API key is a long-lived secret that can bill your account; for production apps use `auth={{ type: 'accessToken', value: accessToken }}` with a short-lived token minted by your server (see [token authentication](https://dev.hume.ai/docs/introduction/api-key#token-authentication)), and reserve `{ type: 'apiKey' }` for local prototyping. The widget rejects an empty or missing credential rather than attempting to connect.

**Note:** For integration within server components, instantiate `EmbeddedVoice` within a client component. For more information checkout the [Next.js documentation on client components](https://nextjs.org/docs/app/building-your-application/rendering/client-components).

### Component Props

`EmbeddedVoice` accepts all props that are accepted by the VoiceProvider in the [@humeai/voice-react package](https://github.com/HumeAI/hume-react-sdk/blob/main/packages/react).

In addition, it accepts a few other props specific to creating a widget:

| Prop          | Required | Description                                                                                                                                                                                                                                                                                                        |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isEmbedOpen` | yes      | Opens the widget when set to `true`. Changing it to `false` cancels an open request that is still waiting for the iframe to become ready, but does not collapse a widget that is already open; users close it with the widget UI. Keep this controlled state synchronized by setting it to `false` from `onClose`. |
| rendererUrl   | no       | URL where the widget itself is hosted. If blank, this defaults to the Hume AI widget at [voice-widget.hume.ai](https://voice-widget.hume.ai). An example of this widget can be found at [hume.ai](https://hume.ai).                                                                                                |
| `onMessage`   | no       | Callback function to invoke upon receiving a message through the web socket.                                                                                                                                                                                                                                       |
| `onClose`     | no       | Callback function to invoke upon the web socket connection being closed.                                                                                                                                                                                                                                           |
| `openOnMount` | no       | Boolean which indicates whether the widget should be initialized in an open or closed state. Set as `true` if you want it to be open. The default value is `false`.                                                                                                                                                |

## Support

If you have questions or require assistance pertaining to this package, [reach out to us on Discord](https://hume.ai/discord)!
