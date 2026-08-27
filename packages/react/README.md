<div align="center">
  <img src="https://storage.googleapis.com/hume-public-logos/hume/hume-banner.png">
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

### Configuring [VoiceProvider](https://github.com/HumeAI/empathic-voice-api-js/blob/8a4f9b87870c68650cde73a818edd093716c59fd/packages/react/src/lib/VoiceProvider.tsx)

See a complete list of props accepted by `VoiceProvider` below:

#### `enableAudioWorklet?`: boolean

(_Optional_) A flag to toggle the audio player implementation between AudioWorklet and AudioBuffer. AudioWorklet is recommended for best audio quality results on most browsers, but has degraded performance on Safari 17. Defaults to `true`.

#### `onMessage?`: (message: [JsonMessage](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/JsonMessage.ts) & { receivedAt: Date;}) => void

(_Optional_) Callback function to invoke upon receiving a message through the
web socket. Locally sent ToolResponse and ToolError messages are also emitted
after they are successfully passed to the socket so they stay in sync with
`messages` and `toolStatusStore`.

#### `onToolCall?`: [ToolCallHandler](https://github.com/HumeAI/empathic-voice-api-js/blob/8a4f9b87870c68650cde73a818edd093716c59fd/packages/react/src/lib/useVoiceClient.ts#L28)

(_Optional_) Callback function to invoke upon receiving a ToolCallMessage through the web socket. It will send the string returned as a the content of a ToolResponseMessage. This is where you should add logic that handles your custom tool calls.

#### `onAudioReceived?`: (message: AudioOutputMessage) => void

(_Optional_) Callback function to invoke when an audio output message is received from the websocket.

#### `onAudioStart?`: (clipId: string) => void

(_Optional_) Callback function to invoke when an audio clip from the assistant starts playing.

#### `onAudioEnd?`: (clipId: string) => void

(_Optional_) Callback function to invoke when an audio clip from the assistant stops playing.

#### `onStartRecording?`: () => void

(_Optional_) Callback function to invoke when microphone recording starts.

#### `onStopRecording?`: () => void

(_Optional_) Callback function to invoke when microphone recording stops.

#### `onInterruption?`: (clipId: string) => void

(_Optional_) Callback function to invoke when the assistant is interrupted.

#### `onClose?`: (event: [CloseEvent](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/core/websocket/events.ts#L20)) => void

(_Optional_) Callback function to invoke upon the web socket connection being closed.

#### `clearMessagesOnDisconnect?`: boolean

(_Optional_) Boolean which indicates whether you want to clear message history when the call ends.

#### `messageHistoryLimit?`: number

(_Optional_) Set the number of messages that you wish to keep over the course of the conversation. The default value is 100.

#### `diagnostics?`: false | VoiceDiagnosticsOptions

(_Optional_) Configure structured diagnostic events. When omitted, sanitized
`warn` and `error` events are written to the browser console. Pass `false` to
disable all diagnostic output. See [Diagnostics and logging](#diagnostics-and-logging)
for configuration and privacy details.

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

### Methods

#### `connect`: (options?: ConnectOptions) => Promise

Opens a socket connection to the voice API and initializes the microphone.
The promise resolves after that attempt settles; inspect `status` and `error`
to determine whether it connected successfully. A call made while another
connection attempt is still running joins that attempt without starting a
second set of resources; the later call's options are ignored. Calling
`connect()` while already connected is a no-op that resolves.

| Parameter | Type             | Description                           |
| --------- | ---------------- | ------------------------------------- |
| `options` | `ConnectOptions` | Optional settings for the connection. |

#### `disconnect`: () => Promise<void>

Disconnect from the voice API and microphone. After cleanup completes, an
explicit call clears the provider error that was current when the call began
and returns `status` to `disconnected`. If teardown raises a newer error, that
error is preserved and `status` remains `error`. Calling `disconnect()` inside
`onError` acknowledges that reported error after cleanup.

#### `setInputDevice`: (deviceId: string | null) => Promise<void>

Switches the microphone for an active connection. Pass `null` for the browser
default; selecting it again reacquires the current browser/OS default. Selecting
an explicit device that is already capturing updates the requested-device state
without rebuilding the recorder.

#### `setOutputDevice`: (deviceId: string | null) => Promise<void>

Switches the speaker for an active connection without rebuilding the playback
graph or clearing queued audio. Pass `null` for the browser/system default.
Selecting the already-active device is a no-op.

#### `clearMessages`: () => void

Clear transcript messages from history.

#### `mute`: () => void

Mute the microphone

#### `unmute`: () => void

Unmute the microphone

#### `muteAudio`: () => void

Mute the assistant audio

#### `unmuteAudio`: () => void

Unmute the assistant audio

#### `setVolume`: (level: number) => void

Sets the playback volume for audio generated by the assistant. Input values are clamped between `0.0` (silent) and `1.0` (full volume).

#### `sendSessionSettings`: (message: Omit<[SessionSettings](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/SessionSettings.ts), 'type'>) => void

Send new session settings to the assistant. This overrides any session settings
that were passed as props to the VoiceProvider. Do not provide the wire-level
`type` field; the SDK adds `type: 'session_settings'` automatically.

#### `sendUserInput`: (text: string) => void

Send a user input message.

#### `sendAssistantInput`: (text: string) => void

Send a text string for the assistant to read out loud.

#### `sendToolMessage`: (toolMessage: [ToolResponse](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/ToolResponseMessage.ts) \| [ToolError](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/ToolErrorMessage.ts)) => void

Send a tool response or tool error message to the EVI backend. Successfully
sent tool messages are emitted through `onMessage`, appended to `messages`, and
recorded in `toolStatusStore`.

#### `pauseAssistant`: () => void

Pauses responses from EVI. Chat history is still saved and sent after resuming.

#### `resumeAssistant`: () => void

Resumes responses from EVI. Chat history sent while paused will now be sent.

### Properties

#### `isMuted`: boolean

Boolean that describes whether the microphone is muted.

#### `isAudioMuted`: boolean

Boolean that describes whether the assistant audio is muted.

#### `volume`: number

The current playback volume level for the assistant's voice, ranging from `0.0` (silent) to `1.0` (full volume). Defaults to `1.0`.

#### `isPlaying`: boolean

Describes whether the assistant audio is currently playing.

#### `isPaused`: boolean

Boolean that describes whether the assistant is paused. When paused, the assistant will still be listening, but will not send a response until it is resumed.

#### `messages`: [UserTranscriptMessage](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/UserMessage.ts) | [AssistantTranscriptMessage](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/AssistantMessage.ts) | [ConnectionMessage](https://github.com/HumeAI/empathic-voice-api-js/blob/8a4f9b87870c68650cde73a818edd093716c59fd/packages/react/src/lib/connection-message.ts) | [UserInterruptionMessage](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/UserInterruption.ts) | [JSONErrorMessage](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/WebSocketError.ts)

Message history of the current conversation. By default, `messages` does not include interim user messages when `verboseTranscription` is set to true on the `VoiceProvider` (`verboseTranscription` is true by default). To access interim messages, you can define a custom `onMessage` callback on your `VoiceProvider`.

#### `lastVoiceMessage`: [AssistantTranscriptMessage](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/AssistantMessage.ts) | null

The last transcript message received from the assistant.

#### `lastUserMessage`: [UserTranscriptMessage](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/UserMessage.ts) | null

The last transcript message received from the user.

#### `readyState`: [VoiceReadyState](https://github.com/HumeAI/empathic-voice-api-js/blob/8a4f9b87870c68650cde73a818edd093716c59fd/packages/react/src/lib/useVoiceClient.ts#L21)

The current readyState of the websocket connection.

#### `status`: [VoiceStatus](https://github.com/HumeAI/empathic-voice-api-js/blob/8a4f9b87870c68650cde73a818edd093716c59fd/packages/react/src/lib/VoiceProvider.tsx#L41)

The current status of the voice connection. Informs you of whether the voice is connected, disconnected, connecting, or error. If the voice is in an error state, it will automatically disconnect from the websocket and microphone.

#### `error`: [VoiceError](https://github.com/HumeAI/empathic-voice-api-js/blob/8a4f9b87870c68650cde73a818edd093716c59fd/packages/react/src/lib/VoiceProvider.tsx#L36)

Provides more detailed error information if the voice is in an error state.

#### `isError`: boolean

If true, the voice is in an error state.

#### `isAudioError`: boolean

If true, an audio playback error has occurred.

#### `isMicrophoneError`: boolean

If true, a microphone error has occurred.

#### `isSocketError`: boolean

If true, there was an error connecting to the websocket.

#### `toolStatusStore`: Record<string, { call?: [ToolCall](); resolved?: [ToolResponse]() | [ToolError]() }>

A map of tool call IDs to their associated tool messages.

#### `chatMetadata`: [ChatMetadataMessage](https://github.com/HumeAI/hume-typescript-sdk/blob/ac89e41e45a925f9861eb6d5a1335ab51d5a1c94/src/api/resources/empathicVoice/types/ChatMetadata.ts) | null

Metadata about the current chat, including chat ID, chat group ID, and request ID.

#### `playerQueueLength`: number

The number of assistant audio clips that are queued up, including the clip that is currently playing.

### Granular Hooks

These hooks subscribe directly to high-frequency data via `useSyncExternalStore`, bypassing the main `VoiceContext`. Use them instead of the deprecated `useVoice()` properties for FFT and call duration data.

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

### `ConnectOptions`

```ts
export type ConnectOptions = {
  /** Authentication strategy and corresponding value. Authentication is required to establish the web socket connection with Hume's Voice API. See our [documentation](https://dev.hume.ai/docs/quick-start#getting-your-api-key) on obtaining your `API key` or `access token`.
   */
  auth: AuthStrategy;
  /** Hostname of the Hume API. If not provided this value will default to `"api.hume.ai"`. */
  hostname?: string;
  /** If you have a configuration ID with voice presets, pass the config ID here. */
  configId?: string;
  /** If you wish to use a specific version of your config, pass in the version ID here. */
  configVersion?: string;
  /** A flag to enable verbose transcription. When `true`, unfinalized user transcripts are sent to the client as interim UserMessage messages, which makes the assistant more sensitive to interruptions. Defaults to `true`. */
  verboseTranscription?: boolean;
  /** Include a chat group ID, which enables the chat to continue from a previous chat group. */
  resumedChatGroupId?: string;
  /** Custom audio constraints passed to navigator.getUserMedia to get the microphone stream */
  audioConstraints?: AudioConstraints;
  /** Session settings to be sent immediately once the connection to EVI is established. See documentation for details: https://dev.hume.ai/docs/empathic-voice-interface-evi/configuration/session-settings */
  sessionSettings?: Hume.empathicVoice.SessionSettings;
  /** Device IDs for microphone and speaker selection */
  devices?: DeviceOptions;
};
```

### `AudioConstraints`

````ts
export type AudioConstraints = {
  /** Reduce echo from the input (if supported). Defaults to `true`. */
  echoCancellation?: boolean;
  /** Suppress background noise (if supported). Defaults to `true`.*/
  noiseSuppression?: boolean;
  /** Automatically adjust microphone gain (if supported). Defaults to `true`. */
  autoGainControl?: boolean;
};

### `DeviceOptions`

```ts
export type DeviceOptions = {
  /** Device ID of the microphone/audio input to use. Uses the default microphone if not specified. */
  microphoneDeviceId?: string;
  /** Device ID of the speaker/audio output to use for playback. Uses the default audio output if not specified. */
  speakerDeviceId?: string;
};
````

## Support

If you have questions or require assistance pertaining to this package, [reach out to us on Discord](https://hume.ai/discord)!
