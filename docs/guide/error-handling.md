---
description: 'The VoiceError taxonomy, which failures reject, and how to reconnect.'
---

# Errors and reconnection

The SDK reports failures two different ways, and knowing which is which saves a
lot of confusion.

- **Call failures are reported**, through `onError` and `status`. They describe
  something that went wrong with the conversation.
- **Caller mistakes are thrown**, by rejecting the promise you awaited. These
  never reach `onError`.

## Reported failures

Everything reported is a `VoiceError`: a `type`, a `reason`, a human-readable
`message`, and sometimes the underlying `error`.

```tsx
<VoiceProvider
  onError={(error) => {
    console.error(error.type, error.reason, error.message);
  }}
>
```

The same value is on `useVoice().error`, and `status` becomes
`{ value: 'error', reason }` when a failure is fatal to the call.

### `socket_error`

| Reason                             | Typical cause                                                                       | What to do                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| `socket_connection_failure`        | Bad, empty, or expired credentials; network failure                                 | Mint a fresh token and offer to reconnect          |
| `failed_to_send_audio`             | The socket closed mid-call                                                          | Treat as a dropped call                            |
| `failed_to_send_message`           | The socket closed while sending text                                                | Retry after reconnecting                           |
| `received_assistant_error_message` | EVI reported a server-side error                                                    | Surface `message`; usually a configuration problem |
| `received_tool_call_error`         | Your tool handler threw, returned something invalid, or its reply could not be sent | See [Tool calls](./tool-calls)                     |

### `mic_error`

| Reason                       | Typical cause                                      | What to do                                                          |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `mic_permission_denied`      | User refusal or a browser/document security policy | Retry after refusal; fix the document or browser policy for a block |
| `mic_initialization_failure` | The device could not be opened                     | Suggest another input device                                        |
| `mic_closure_failure`        | Cleanup failed on disconnect                       | Log it; the call is already over                                    |
| `mime_types_not_supported`   | No supported capture format                        | The browser cannot be used                                          |

### `audio_error`

| Reason                                | Typical cause                           | What to do                              |
| ------------------------------------- | --------------------------------------- | --------------------------------------- |
| `audio_player_initialization_failure` | The AudioContext could not start        | Usually a missing user gesture          |
| `audio_worklet_load_failure`          | The worklet could not load              | Retry with `enableAudioWorklet={false}` |
| `audio_player_not_initialized`        | Playback was used before setup finished | A lifecycle bug; check ordering         |
| `malformed_audio`                     | An audio chunk could not be decoded     | Log it; usually transient               |
| `audio_player_closure_failure`        | Cleanup failed on disconnect            | Log it; the call is already over        |

### Checking the error category

Compare `error.type` when TypeScript needs to narrow a `VoiceError`. For
rendering, `useVoice()` also exposes `isError`, `isSocketError`,
`isMicrophoneError`, and `isAudioError` as convenient booleans.

```tsx
const { error } = useVoice();

if (error?.type === 'socket_error') {
  console.error(error.reason);
}
```

## Thrown failures

These reject the promise and are **not** delivered to `onError`:

| Call                                    | Rejects with                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `connect()`                             | `ConcurrentConnectAuthError`, when another attempt is in flight with different credentials |
| `setInputDevice()`, `setOutputDevice()` | `AudioDeviceSwitchError` — see [Audio devices](./audio-devices)                            |

Everything else about `connect` is reported, not thrown. In particular, **a bad
credential and a denied microphone do not reject** — `connect` resolves once the
attempt settles, and you inspect `status` and `error` to find out how it went.

`disconnect()` never rejects.

## Reconnecting

**There is no automatic reconnection**, and this is deliberate. Browsers —
Safari especially — require an explicit user gesture to start audio capture and
playback, so a silent background reconnect would produce a call with no
microphone. The `reconnectAttempts` prop was removed in 0.2.0 for this reason.

So a reconnect is a button:

```tsx
function CallStatus({ accessToken }: { accessToken: string }) {
  const { status, connect } = useVoice();

  if (status.value !== 'error') return null;

  return (
    <div role="alert">
      <p>The call ended unexpectedly: {status.reason}</p>
      <button
        onClick={() =>
          void connect({ auth: { type: 'accessToken', value: accessToken } })
        }
      >
        Reconnect
      </button>
    </div>
  );
}
```

Fetch a fresh access token before reconnecting; the one you rendered with may
have expired. See [Authentication](./authentication).

## Close codes

`onClose` receives the socket close event. A `code` other than `1000` means the
call did not end cleanly, which is worth distinguishing from a user hanging up.

```tsx
<VoiceProvider
  onClose={(event) => {
    if (event.code !== 1000) {
      reportUnexpectedDisconnect(event.code, event.reason);
    }
  }}
>
```

## Parsing failures are values, not exceptions

`parseMessageData` and `parseMessageType` never reject. They return a result
whose failure branch carries a `SocketUnknownMessageError` or
`SocketFailedToParseMessageError` — check `success` rather than wrapping the call
in `try`/`catch`.

## Reference

- [`VoiceError`](/reference/api/voice-react.voiceerror)
- [`SocketErrorReason`](/reference/api/voice-react.socketerrorreason),
  [`MicErrorReason`](/reference/api/voice-react.micerrorreason),
  [`AudioPlayerErrorReason`](/reference/api/voice-react.audioplayererrorreason)
- [`VoiceStatus`](/reference/api/voice-react.voicestatus)
- [`ConcurrentConnectAuthError`](/reference/api/voice-react.concurrentconnectautherror),
  [`AudioDeviceSwitchError`](/reference/api/voice-react.audiodeviceswitcherror)
