<!-- cspell:words Meyda -->

# Changelog

All notable changes to the packages in this repository are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with
one deviation: all three packages are released from a single repository tag, so
each section below is a **release**, and its `Published:` line records the
version each package actually reached npm under that tag. Those versions have
not always matched — see [Release history notes](#release-history-notes).

Releases are itemized from `v0.2.0` (2025-07-07) onward. Earlier versions
documented an API that 1.0.0 removes wholesale; see
[0.1.x and earlier](#01x-and-earlier). The many untagged prereleases published
before `v0.2.0` (`0.0.0-beta.*`, `0.2.0-beta.*`) are not itemized and have no
recoverable notes.

## [Unreleased]

### `@humeai/voice-react`

#### Added

- Audio device selection. `useAudioDevices()` enumerates microphones and
  speakers; `setInputDevice()` and `setOutputDevice()` switch them during a live
  call without reconnecting. Failures reject with `AudioDeviceSwitchError`,
  carrying one of `not_connected`, `unsupported`, `permission_denied`,
  `device_not_found`, `switch_failed`, or `interrupted`, and leave the call and
  the current working device intact.
- `connect({ devices })` selects a microphone and speaker for a new session.
  `useVoice()` publishes `requestedInputDeviceId` / `activeInputDeviceId` and
  their output counterparts, so device controls can show what is actually
  capturing when the browser grants a fallback device.
- Standalone device helpers: `getAllAudioDevices`, `getInputDevices`,
  `getOutputDevices`, `isAudioDeviceEnumerationSupported`, and
  `requestAudioDevicePermission`.
- Structured diagnostics. `VoiceProvider` accepts a `diagnostics` prop that
  emits correlated connection, socket, microphone, playback, device, message,
  and tool-call events. Diagnostics are local only — nothing is sent to Hume.
  Sanitized warnings and errors go to the console by default; `logger: false`
  plus `onEvent` forwards events to your own observability vendor instead.
  Transcript and tool content is excluded unless `includeContent: true`, and
  authentication values, raw audio, and device identifiers are never emitted.
- `ConcurrentConnectAuthError` and `isConcurrentConnectAuthError`. A second
  `connect()` with credentials that differ from the in-flight attempt is now
  rejected rather than silently discarding the newer credentials.

#### Fixed

- Extensive connection, microphone, and audio-player lifecycle hardening.
  Teardown ownership is serialized so a disconnect racing a failed connection
  cannot leave a stream open; every cleanup step is attempted independently and
  reports its own failure; a silent audio-player initialization failure now
  returns the provider to `disconnected` instead of hanging; and final
  microphone data is preserved on stop.
- Tool results sent from the client are now surfaced in `messages`.

#### Removed

- **Breaking.** Removed low-level resource APIs that duplicated the lifecycle
  owned by `VoiceProvider`: `useMicrophone`, `useMicrophoneStream`,
  `useVoiceClient`, `useCallDuration`, `MicrophonePermissionStatus`, and
  `MicrophoneProps`. Use `VoiceProvider` and `useVoice`; read elapsed time with
  `useCallDurationTimestamp`.
- **Breaking.** Removed implementation stores and connection-generation details:
  `CallDurationStore`, `useFftSubscription`, `ConnectionGenerationError`,
  `ConnectionGenerationErrorReason`, and `isConnectionGenerationError`. Use
  `useCallDurationTimestamp`, `usePlayerFft`, and `useMicFft`; connection
  generations are now managed internally.
- **Breaking.** Removed the stale `AudioEncoding`, `Channels`,
  `LanguageModelOption`, and `TTSService` constants and types. Audio and model
  configuration comes from EVI configuration and the current `hume` request
  types rather than duplicated client-side enumerations.
- **Breaking.** Removed `TimeSlice` and `TimeSliceSchema`. Read the timestamp
  fields on transcript messages instead. See the
  [migration guide](packages/react/MIGRATION.md).

### `@humeai/voice-embed` and `@humeai/voice-embed-react`

#### Added

- `onReady`, invoked once the widget iframe reports that it is ready and any
  queued open request has been applied.
- `cancelPendingOpen()`, which withdraws an open request that is still waiting
  for the iframe to become ready.

#### Fixed

- Mounting is now failure-tolerant: if attaching the iframe fails, the widget
  rolls back cleanly and returns a no-op unmount rather than throwing, so a
  widget failure cannot take down the surrounding page.

## [0.3.0-beta.6] — 2026-08-18

Published: `@humeai/voice-react` 0.3.0-beta.6, `@humeai/voice-embed` 0.2.17,
`@humeai/voice-embed-react` 0.2.17. No GitHub release was published for this
tag, and the embed packages' 0.2.17 has no tag of its own.

### Changed

- Bump `hume` to 0.16.1 ([#440]).

## [0.3.0-beta.5] — 2026-07-08

Published: `@humeai/voice-react` 0.3.0-beta.5. The embed packages stayed at
0.2.16. No GitHub release was published for this tag.

### `@humeai/voice-react`

#### Fixed

- Interrupt playback only on `user_interruption`, not on every `user_message`
  ([#438]).

## [0.3.0-beta.4] — 2026-05-20

Published: `@humeai/voice-react` 0.3.0-beta.4, `@humeai/voice-embed` 0.2.16,
`@humeai/voice-embed-react` 0.2.16 (the embed 0.2.16 release has no tag of its
own).

### Changed

- Bump `hume` to 0.15.17.

## [0.3.0-beta.3] — 2026-04-10

Published: `@humeai/voice-react` 0.3.0-beta.3, `@humeai/voice-embed` 0.2.15,
`@humeai/voice-embed-react` 0.2.15 (the embed 0.2.15 release has no tag of its
own).

### Changed

- Bump `hume` to 0.15.16, adding the
  [turn detection](https://dev.hume.ai/docs/speech-to-speech-evi/configuration/turn-detection)
  and
  [interruption](https://dev.hume.ai/docs/speech-to-speech-evi/configuration/interruption)
  configuration options.

## [0.3.0-beta.2] — 2026-02-27

Published: `@humeai/voice-react` 0.3.0-beta.2. The embed packages stayed at
0.2.14.

### Changed

- Bump `hume` to 0.15.15: adds the
  [`prompt_expansion`](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting#prompt-expansion)
  parameter for external LLMs; adds the `claude-opus-4-6`, `gpt-5.1`,
  `gpt-5.1-priority`, `gpt-5.2`, and `gpt-5.2-priority` models; makes an external
  LLM's `model_provider` optional when `model_resource` is given; and restores
  the missing `X_AI` provider.

## [0.3.0-beta.1] — 2026-02-12

Published: `@humeai/voice-react` 0.3.0-beta.1. The embed packages stayed at
0.2.14 — this is where the three packages stopped moving in lockstep.

### `@humeai/voice-react`

#### Removed

- **Breaking.** `fft`, `micFft`, and `callDurationTimestamp` were removed from
  the object `useVoice()` returns. These update at display refresh rate and
  forced every `useVoice()` consumer to rerender. Use `usePlayerFft()`,
  `useMicFft()`, and `useCallDurationTimestamp()` instead — they subscribe via
  `useSyncExternalStore`, so only the components that read them rerender
  ([#417]). See the [migration guide](packages/react/MIGRATION.md).

#### Changed

- **Breaking.** `usePlayerFft()` and `useMicFft()` return `readonly number[]`
  rather than `number[]`, reflecting that the arrays are shared and must not be
  mutated. Update component props typed `number[]` accordingly.

## [0.2.14] — 2026-02-09

Published: all three packages at 0.2.14.

### Fixed

- `systemPrompt` in `SessionSettings` ([#414]).

### Changed

- Bump `hume` to 0.15.13 ([#415]).

## [0.2.13] — 2026-02-02

Published: all three packages at 0.2.13.

### Fixed

- WebSocket `queryParams` and `voice_id` backwards-compatibility.

## [0.2.12] — 2026-01-14

Published: all three packages at 0.2.12.

### Fixed

- `@humeai/voice-embed-react` failing to install from npm ([#401]).
- React Server Components security advisories ([#399]).

### Changed

- Bump `hume` to 0.15.11 ([#403]).

## [0.2.11] — 2025-12-05

Published: all three packages at 0.2.11.

### Changed

- Bump `hume` to 0.15.9 ([#395]).

## [0.2.10] — 2025-11-24

Published: all three packages at 0.2.10.

### Fixed

- Replace `getAudioStream` with a version that honors `deviceId` ([#391],
  [#392]).

## [0.2.9] — 2025-11-18

Published: all three packages at 0.2.9.

### Fixed

- Authorization parameters are now passed through to the WebSocket correctly
  (via the `hume` 0.15.6 bump, [#389]).

## [0.2.8] — 2025-11-10

Published: all three packages at 0.2.8.

### Changed

- The system prompt is now sent as a WebSocket message rather than a query
  parameter ([#383]).

## [0.2.7] — 2025-11-07

Published: all three packages at 0.2.7.

### Added

- Device identifier options on `connect` ([#377]).

### Changed

- Session settings are appended to the `messages` array ([#378]).

## [0.2.6] — 2025-10-08

Published: all three packages at 0.2.6.

### Changed

- Bump `hume` to 0.14.1 and send the initial `session_settings` in the query
  parameter ([#376]).

## [0.2.5] — 2025-09-29

Published: all three packages at 0.2.5.

### Changed

- Bump `hume` from 0.13.3 to 0.13.8.

## [0.2.4] — 2025-09-29

Published: `@humeai/voice-embed-react` 0.2.4 only. `@humeai/voice-react` and
`@humeai/voice-embed` never published a 0.2.4 and go straight from 0.2.3 to
0.2.5.

### Changed

- Bump `hume` from 0.13.3 to 0.13.7 ([#371]).
- Repository documentation now describes all three packages ([#372]).

## [0.2.3] — 2025-08-13

Published: all three packages at 0.2.3.

### Added

- `voiceId` can be passed to `connect` to select a particular voice (via the
  `hume` 0.12.1 → 0.13.3 bump).

### Fixed

- Rare bug where audio chunks could play out of order.

### Removed

- The dependency on Meyda.

## [0.2.2] — 2025-07-25

Published: all three packages at 0.2.2.

### Added

- The last available interim user message now appears in the `messages` array.

## [0.2.1] — 2025-07-17

Published: all three packages at 0.2.1.

### Added

- Support for the `AssistantProsody` message.

## [0.2.0] — 2025-07-07

Published: all three packages at 0.2.0.

This release contains breaking changes. See the
[migration guide](packages/react/MIGRATION.md) for upgrade steps.

### `@humeai/voice-react`

#### Removed

- **Breaking.** `reconnectAttempts` was removed from `VoiceProvider` and the
  default reconnect behavior is now none. Browsers — Safari in particular —
  require an explicit user gesture to resume audio and microphone access, so
  automatic reconnection was not viable. Prompt the user to reconnect instead.

#### Changed

- **Breaking.** Session-specific options moved off `VoiceProvider` and onto the
  `connect()` call: `auth`, `hostName`, `configId`, `configVersion`,
  `verboseTranscription`, `resumedChatGroupId`, and `sessionSettings`. They
  describe one session rather than the component's lifetime, so this avoids
  remounting the tree to refresh a token or switch configs.
- **Breaking.** `disconnect()` is now asynchronous. `await` it when you need
  cleanup to finish before navigating away.
- The audio player now uses the AudioWorklet API for better playback quality.

#### Added

- `enableAudioWorklet` on `VoiceProvider`. Set it to `false` to fall back to the
  previous `AudioBuffer` player on browsers where the worklet underperforms
  (some Safari 17.5 builds). Defaults to `true`.
- A `reason` field on the `error` object, identifying where a fatal call error
  originated.

#### Fixed

- Audio player, microphone, and WebSocket connection lifecycle bugs.

## 0.1.x and earlier

Releases before `v0.2.0` are not itemized here. They document an API that 1.0.0
removes, and the notes are available on the
[releases page](https://github.com/HumeAI/hume-react-sdk/releases). The full
diff is at
[`v0.1.3...v0.2.0`](https://github.com/HumeAI/hume-react-sdk/compare/v0.1.3...v0.2.0).

## Release history notes

The mapping from repository tag to published package versions is not uniform,
and a naive walk of the tag list will get these wrong:

- **Two tags are malformed.** `0.1.7` is missing its `v` prefix and `v.0.1.19`
  has a stray dot. Both are recorded here as 0.1.7 and 0.1.19. The release
  tooling added in 1.0.0 rejects both spellings.
- **`v0.2.4` was a partial release.** Only `@humeai/voice-embed-react` reached
  npm; the other two packages skip from 0.2.3 to 0.2.5.
- **`v0.2.12` does not match its own manifests.** All three packages published
  0.2.12, but the `package.json` files at that tag still read 0.2.11. The
  tag-to-manifest matching that would have caught this was introduced later.
- **`@humeai/voice-embed` 0.2.15, 0.2.16, and 0.2.17 have no tags.** They were
  published alongside `v0.3.0-beta.3`, `v0.3.0-beta.4`, and `v0.3.0-beta.6`,
  when the packages had stopped moving in lockstep.
- **`v0.2.4`, `v0.3.0-beta.5`, and `v0.3.0-beta.6` have no GitHub release.**
  Their entries above were reconstructed from the commits in each tag range.

From 1.0.0 onward the three packages are versioned in lockstep, and one tag
publishes all three at the same version.

[#371]: https://github.com/HumeAI/hume-react-sdk/pull/371
[#372]: https://github.com/HumeAI/hume-react-sdk/pull/372
[#376]: https://github.com/HumeAI/hume-react-sdk/pull/376
[#377]: https://github.com/HumeAI/hume-react-sdk/pull/377
[#378]: https://github.com/HumeAI/hume-react-sdk/pull/378
[#383]: https://github.com/HumeAI/hume-react-sdk/pull/383
[#389]: https://github.com/HumeAI/hume-react-sdk/pull/389
[#391]: https://github.com/HumeAI/hume-react-sdk/pull/391
[#392]: https://github.com/HumeAI/hume-react-sdk/pull/392
[#395]: https://github.com/HumeAI/hume-react-sdk/pull/395
[#399]: https://github.com/HumeAI/hume-react-sdk/pull/399
[#401]: https://github.com/HumeAI/hume-react-sdk/issues/401
[#403]: https://github.com/HumeAI/hume-react-sdk/pull/403
[#414]: https://github.com/HumeAI/hume-react-sdk/pull/414
[#415]: https://github.com/HumeAI/hume-react-sdk/pull/415
[#417]: https://github.com/HumeAI/hume-react-sdk/pull/417
[#438]: https://github.com/HumeAI/hume-react-sdk/pull/438
[#440]: https://github.com/HumeAI/hume-react-sdk/pull/440
[Unreleased]: https://github.com/HumeAI/hume-react-sdk/compare/v0.3.0-beta.6...HEAD
[0.3.0-beta.6]: https://github.com/HumeAI/hume-react-sdk/compare/v0.3.0-beta.5...v0.3.0-beta.6
[0.3.0-beta.5]: https://github.com/HumeAI/hume-react-sdk/compare/v0.3.0-beta.4...v0.3.0-beta.5
[0.3.0-beta.4]: https://github.com/HumeAI/hume-react-sdk/compare/v0.3.0-beta.3...v0.3.0-beta.4
[0.3.0-beta.3]: https://github.com/HumeAI/hume-react-sdk/compare/v0.3.0-beta.2...v0.3.0-beta.3
[0.3.0-beta.2]: https://github.com/HumeAI/hume-react-sdk/compare/v0.3.0-beta.1...v0.3.0-beta.2
[0.3.0-beta.1]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.14...v0.3.0-beta.1
[0.2.14]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.3...v0.2.5
[0.2.4]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/HumeAI/hume-react-sdk/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/HumeAI/hume-react-sdk/compare/v0.1.22...v0.2.0
