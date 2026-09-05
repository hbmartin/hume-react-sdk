---
description: 'Structured, correlated events for debugging a voice call, and how to route them.'
---

# Diagnostics and logging

`VoiceProvider` emits structured, correlated events for connection, socket,
microphone, playback, device, message, and tool-call lifecycles.

**Diagnostics are local only.** The SDK does not send telemetry to Hume or to
any other service. Where the events go is entirely your choice.

## Levels

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

## Forwarding to your own observability tooling

You can forward filtered events to an existing vendor without also logging them
to the console:

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

A custom `logger` can also implement the exported `VoiceLogger` interface. The
selected `level` filters both the logger and `onEvent`, and failures in either
sink are isolated from the voice call and from your existing callbacks — a
throwing logger cannot break a conversation.

## What events never contain

Events exclude transcript and tool content by default. Set `includeContent: true`
only when your data-handling policy permits forwarding user and assistant text,
tool arguments, tool results, and tool errors.

Even with content enabled, diagnostics never emit:

- authentication values of any kind
- raw audio, or PCM and base64 payloads
- session-setting values such as prompts
- audio device identifiers or labels

## Event shape

Every event carries `schemaVersion: 1`, `sdkVersion`, an `instanceId`, a
monotonically increasing `sequence`, and connection and chat correlation when
available — so events from two overlapping connection attempts can be told
apart.

Schema version 1 keeps existing event meanings and fields stable, but future
minor releases may add event names. **Consumers should ignore names they do not
recognize.**

## Categories

Each event carries a `category`, useful for filtering before forwarding:

| Category       | Covers                                                         |
| -------------- | -------------------------------------------------------------- |
| `connection`   | Connection attempts, their outcomes, and disconnects           |
| `socket`       | The EVI WebSocket opening and closing                          |
| `microphone`   | Permission, MIME-type selection, recording, capture, and flush |
| `audio_player` | Playback queue and drain lifecycle                             |
| `audio_device` | Live microphone and speaker switches                           |
| `message`      | Messages sent to and received from EVI                         |
| `tool`         | Tool-call handler lifecycle                                    |
| `consumer`     | Failures inside callbacks you supplied                         |

## Event names

The complete catalogue for schema version 1:

| Event family   | Names                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection     | `connection.attempt_started`, `connection.attempt_ignored`, `connection.attempt_cancelled`, `connection.connected`, `connection.disconnect_started`, `connection.disconnected`                                                                                      |
| Socket         | `socket.opened`, `socket.closed`                                                                                                                                                                                                                                    |
| Resource       | `resource.initialization_started`, `resource.initialized`, `resource.stop_started`, `resource.stopped`, `resource.cleanup_failed`                                                                                                                                   |
| Microphone     | `microphone.permission_requested`, `microphone.permission_resolved`, `microphone.mime_type_selected`, `microphone.recording_started`, `microphone.recording_stopped`, `microphone.audio_chunk_captured`, `microphone.flush_completed`, `microphone.analyzer_failed` |
| Audio playback | `audio.chunk_received`, `audio.queue_changed`, `audio.worklet_message_ignored`, `audio.playback_started`, `audio.playback_ended`, `audio.drain_completed`                                                                                                           |
| Audio devices  | `audio_device.switch_started`, `audio_device.switch_completed`, `audio_device.switch_failed`, `audio_device.switch_ignored`                                                                                                                                         |
| Messages       | `message.sent`, `message.received`, `message.skipped`                                                                                                                                                                                                               |
| Tools          | `tool.handler_started`, `tool.handler_completed`, `tool.handler_failed`, `tool.handler_skipped`                                                                                                                                                                     |
| Consumer       | `consumer.callback_failed`                                                                                                                                                                                                                                          |
| Controls       | `control.changed`, `control.change_failed`                                                                                                                                                                                                                          |
| SDK errors     | `sdk.error`, `sdk.error_cleared`                                                                                                                                                                                                                                    |

Event families are naming groups, not categories. Cross-cutting events use the
category of the affected subsystem: for example, `control.changed` can be
`message`, `microphone`, or `audio_player`, while SDK errors use the category of
the error they report.

These potentially high-volume names are debug-only to keep routine diagnostics
manageable: `microphone.audio_chunk_captured`, `audio.chunk_received`,
`audio.queue_changed`, `audio.worklet_message_ignored`, and `message.received`.

## Reference

- [`VoiceDiagnosticsOptions`](/reference/api/voice-react.voicediagnosticsoptions)
- [`VoiceDiagnosticEvent`](/reference/api/voice-react.voicediagnosticevent)
- [`VoiceDiagnosticEventName`](/reference/api/voice-react.voicediagnosticeventname)
- [`VoiceDiagnosticCategory`](/reference/api/voice-react.voicediagnosticcategory)
- [`VoiceLogger`](/reference/api/voice-react.voicelogger)
