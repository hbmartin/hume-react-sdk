<div align="center">
  <img src="https://storage.googleapis.com/hume-public-logos/hume/hume-banner.png" alt="Hume AI">
  <h1>@humeai/voice-react</h1>
  <p>
    <strong>Integrate Hume's Empathic Voice Interface in your React application</strong>
  </p>
</div>

## Overview

This package streamlines all of the required state management for building client side applications using the [EVI Chat WebSocket](https://dev.hume.ai/reference/empathic-voice-interface-evi/chat/chat) through a `<VoiceProvider>` component and `useVoice()` hook. It provides a WebSocket, Microphone Interface, Audio Playback Queue, and Message History that are all designed to work closely together.

> [!NOTE]
> This package uses Web APIs for microphone input and audio playback that are not compatible with React Native.

## Prerequisites

> [!IMPORTANT]
> This package is built for use within modern web based React applications using a bundler like `Next.js`, `Webpack`, or `Vite`

Before installing this package, please ensure your development environment meets the following requirement:

- Node.js (`v18.0.0` or higher).

To verify your Node.js version, run this command in your terminal:

```sh
node --version
```

If your Node.js version is below `18.0.0`, update it to meet the requirement. For updating Node.js, visit [Node.js' official site](https://nodejs.org/) or use a version management tool like nvm for a more seamless upgrade process.

## Installation

Add `@humeai/voice-react` to your project by running this command in your project directory:

```bash
npm install @humeai/voice-react
```

This will download and include the package in your project, making it ready for import and use within your React components.

```tsx
import { VoiceProvider } from '@humeai/voice-react';
```

## Usage

> :rocket: Visit our [Next.js quickstart](https://dev.hume.ai/docs/speech-to-speech-evi/quickstart/nextjs) for step-by-step setup instructions and example code to jumpstart your development.

### Context Provider

To use the SDK, wrap your components in the `VoiceProvider`, which will enable your components to access available voice methods. Here's a simple example to get you started:

```tsx
import { VoiceProvider } from '@humeai/voice-react';

function Page() {
  return <VoiceProvider>{/* ... */}</VoiceProvider>;
}
```

### Configuring `VoiceProvider`

`VoiceProvider` takes lifecycle callbacks (`onMessage`, `onError`, `onOpen`,
`onClose`, `onToolCall`, and the audio and recording callbacks), plus
`clearMessagesOnDisconnect`, `messageHistoryLimit`, `enableAudioWorklet`, and
`diagnostics`. Connection settings such as `auth` and `configId` belong on
`connect` instead, because they describe a session rather than the component.

Every prop is documented with its exact type in the
[`VoiceProviderProps` reference](https://humeai.github.io/hume-react-sdk/reference/api/voice-react.voiceproviderprops).

## Connecting to EVI

After you have set up your voice provider, you will be able to access various properties and methods to use the voice in your application. In any component that is a child of `VoiceProvider`, access these methods by importing the `useVoice` custom hook.

For example, to include a button to start a call, you could create a button like this:

```tsx
'use client';
import { useVoice } from '@humeai/voice-react';

export function StartCall({ accessToken }: { accessToken: string }) {
  const { connect } = useVoice();

  return (
    <>
      <button
        onClick={() => {
          void connect({
            auth: { type: 'accessToken', value: accessToken },
            configId: '<YOUR_CONFIG_ID>',
            // other configuration props go here
          });
        }}
      >
        Start Call
      </button>
    </>
  );
}
```

> **Keep your API key off the client.** The credential you pass to `connect` is sent from the browser as part of the WebSocket handshake, so anything you put there is visible to your end users. Your Hume API key is a long-lived secret that can bill your account, so for production apps always use `{ type: 'accessToken' }` with a short-lived token that your server mints with your API key and secret key (see [token authentication](https://dev.hume.ai/docs/introduction/api-key#token-authentication)). Reserve `{ type: 'apiKey' }` for local prototyping. `connect` rejects an empty or missing credential up front, before requesting microphone access, and surfaces it through `onError` as a `socket_error`.

<!-- Separate security and browser-platform callouts. -->

> [!IMPORTANT]
> Under the hood, the React SDK uses the AudioContext API, which [must be initialized by a user gesture](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices#autoplay_policy).
>
> :white_check_mark: CORRECT: call `connect` on a button click.
>
> :x: INCORRECT: call `connect` in a `useEffect` to start a call on component mount.

### Diagnostics and logging

`VoiceProvider` emits structured, correlated events for connection, socket,
microphone, playback, device, message, and tool-call lifecycles. Diagnostics
are local only: the SDK does not send telemetry to Hume or any other service.

By default, only sanitized warnings and errors are written to `console`. To
silence diagnostics completely:

```tsx
<VoiceProvider diagnostics={false}>{children}</VoiceProvider>
```

To log the complete diagnostic lifecycle, including high-volume message and
audio queue metadata:

```tsx
<VoiceProvider diagnostics={{ level: 'debug' }}>{children}</VoiceProvider>
```

You can forward filtered events to an existing observability vendor without
also logging them to the console:

```tsx
import type { VoiceDiagnosticEvent } from '@humeai/voice-react';

function recordVoiceEvent(event: VoiceDiagnosticEvent) {
  observability.capture('hume_voice_diagnostic', event);
}

<VoiceProvider
  diagnostics={{
    level: 'info',
    logger: false,
    onEvent: recordVoiceEvent,
  }}
>
  {children}
</VoiceProvider>;
```

A custom `logger` can also implement the exported `VoiceLogger` interface.
The selected `level` filters both the logger and `onEvent`, and failures in
either sink are isolated from the voice call and existing callbacks.

Events exclude transcript and tool content by default. Set
`includeContent: true` only when your data-handling policy permits forwarding
user and assistant text, tool arguments, tool results, and tool errors. Even
with content enabled, diagnostics never emit authentication values, raw audio,
PCM/base64 payloads, session-setting values such as prompts, or audio device
IDs and labels.

Every event includes `schemaVersion: 1`, `sdkVersion`, an `instanceId`, a
monotonically increasing `sequence`, and connection/chat correlation when
available. Schema version 1 keeps existing event meanings and fields stable,
but future minor releases may add event names. Consumers should ignore names
they do not recognize.

### Selecting audio devices

Use `useAudioDevices` to enumerate microphones and speakers. The hook does not
request microphone permission on mount by default; call `requestPermission`
from a user gesture to reveal device labels and selectable device identifiers.

```tsx
import {
  isAudioDeviceSwitchError,
  useAudioDevices,
  useVoice,
} from '@humeai/voice-react';

export function DevicePicker({ accessToken }: { accessToken: string }) {
  const { activeInputDeviceId, connect, setInputDevice, status } = useVoice();
  const {
    inputDevices,
    selectedInputDeviceId,
    setSelectedInputDeviceId,
    requestPermission,
  } = useAudioDevices();

  return (
    <>
      <button onClick={() => void requestPermission()}>
        Refresh microphones
      </button>
      <select
        value={
          (status.value === 'connected'
            ? activeInputDeviceId
            : selectedInputDeviceId) ?? ''
        }
        onChange={async (event) => {
          const deviceId = event.target.value || null;
          try {
            if (status.value === 'connected') {
              await setInputDevice(deviceId);
            }
            // Commit the selection only after a live switch succeeds. Before
            // connecting, it remains the selection passed to connect below.
            setSelectedInputDeviceId(deviceId);
          } catch (error) {
            if (isAudioDeviceSwitchError(error)) {
              console.error(error.reason, error.message);
            }
          }
        }}
      >
        <option value="">Browser default</option>
        {inputDevices
          .filter((device) => device.deviceId !== '')
          .map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
      </select>
      <button
        onClick={() =>
          void connect({
            auth: { type: 'accessToken', value: accessToken },
            devices: {
              microphoneDeviceId: selectedInputDeviceId ?? undefined,
            },
          })
        }
      >
        Start call
      </button>
    </>
  );
}
```

Before permission is granted, browsers may expose a privacy-redacted default
device with an empty `deviceId`. The hook leaves that device unselected so a
call can safely fall back to the browser default. During an active connection,
`setInputDevice(deviceId)` and `setOutputDevice(deviceId)` switch the live
devices without reconnecting; pass `null` to either method to select the
browser/system default.

`useVoice` publishes `requestedInputDeviceId`, `activeInputDeviceId`,
`requestedOutputDeviceId`, and `activeOutputDeviceId`. The requested input can
differ from the active microphone when the browser grants a fallback device;
render `activeInputDeviceId` during a connected call so device controls reflect
what is actually capturing.

Live switching requires a connected session. Failures reject with an
`AudioDeviceSwitchError` and leave the call and current working device intact.
Microphone switching can prompt for permission, and output switching depends on
the browser's `AudioContext.setSinkId` support. Browsers that do not implement
output selection can still use their default output, but reject non-default
output switches with the `unsupported` reason. Device enumeration and output
selection may also require HTTPS and browser-granted media permission.

### Methods and properties

`useVoice()` returns the connection controls (`connect`, `disconnect`,
`setInputDevice`, `setOutputDevice`), the message senders (`sendUserInput`,
`sendAssistantInput`, `sendSessionSettings`, `sendToolMessage`), the audio
controls (`mute`, `unmute`, `muteAudio`, `unmuteAudio`, `setVolume`,
`pauseAssistant`, `resumeAssistant`), and the current state (`status`, `error`,
`messages`, `chatMetadata`, `toolStatusStore`, `readyState`, and friends).

Each one is documented with its exact signature and behavior in the
[`VoiceContextType` reference](https://humeai.github.io/hume-react-sdk/reference/api/voice-react.voicecontexttype).

### Granular Hooks

These hooks subscribe directly to high-frequency data via `useSyncExternalStore`, bypassing the main `VoiceContext`, so only the components that read FFT or call-duration data rerender when it changes. They replace the `fft`, `micFft`, and `callDurationTimestamp` properties that `useVoice()` carried before 0.3.0 (see the [migration guide](./MIGRATION.md)).

#### `usePlayerFft()`: readonly number[]

Returns live FFT values for the assistant audio output, updated at display refresh rate (~60Hz).

```tsx
import { usePlayerFft } from '@humeai/voice-react';

function Waveform() {
  const fft = usePlayerFft();
  // render visualization using fft values
}
```

#### `useMicFft()`: readonly number[]

Returns live FFT values for microphone input, updated at display refresh rate (~60Hz).

```tsx
import { useMicFft } from '@humeai/voice-react';

function MicWaveform() {
  const micFft = useMicFft();
  // render visualization using micFft values
}
```

#### `useCallDurationTimestamp()`: string | null

Returns the formatted call duration timestamp, updated ~1Hz during an active call.

```tsx
import { useCallDurationTimestamp } from '@humeai/voice-react';

function CallTimer() {
  const timestamp = useCallDurationTimestamp();
  return <span>{timestamp ?? '0:00'}</span>;
}
```

## Types

`ConnectOptions`, `AudioConstraints`, `DeviceOptions`, `VoiceError`,
`VoiceStatus`, and every message type are documented in the
[API reference](https://humeai.github.io/hume-react-sdk/reference/api/voice-react),
generated from the package's own type declarations.

## Changelog

Release notes for every version live in the repository's
[CHANGELOG](https://github.com/HumeAI/hume-react-sdk/blob/main/CHANGELOG.md).

## Support

If you have questions or require assistance pertaining to this package, [reach out to us on Discord](https://hume.ai/discord)!
