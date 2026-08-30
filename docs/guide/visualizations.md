---
description: 'Render waveforms and a call timer without rerendering the rest of your app.'
---

# Audio visualizations

Three hooks expose high-frequency display data: FFT values for the assistant's
audio output and for the microphone, plus a formatted call duration.

They subscribe directly through `useSyncExternalStore`, **bypassing the main
voice context**. Only the components that call them rerender when the data
changes — so a 60 Hz waveform does not rerender your transcript, your controls,
or anything else reading `useVoice()`.

These replaced the `fft`, `micFft`, and `callDurationTimestamp` properties that
`useVoice()` carried before 0.3.0. See the [migration guide](./migration).

## `usePlayerFft(): readonly number[]`

Live FFT values for the assistant's audio output, updated at display refresh
rate (about 60 Hz).

```tsx
import { usePlayerFft } from '@humeai/voice-react';

function Waveform() {
  const fft = usePlayerFft();
  // render a visualization from fft
}
```

## `useMicFft(): readonly number[]`

Live FFT values for microphone input, at the same rate.

```tsx
import { useMicFft } from '@humeai/voice-react';

function MicWaveform() {
  const micFft = useMicFft();
  // render a visualization from micFft
}
```

## `useCallDurationTimestamp(): string | null`

The formatted call duration, updated about once a second during an active call,
and `null` when there is no call.

```tsx
import { useCallDurationTimestamp } from '@humeai/voice-react';

function CallTimer() {
  const timestamp = useCallDurationTimestamp();
  return <span>{timestamp ?? '0:00'}</span>;
}
```

## Notes

- All three must be called inside a `VoiceProvider`.
- The FFT hooks return `readonly number[]`, because the arrays are shared and
  must not be mutated. If you pass the values into a component whose prop is
  typed `number[]`, widen it to `readonly number[]`.
- On the server these render as `[]` and `null` respectively — the underlying
  stores implement `getServerSnapshot`, so there is no hydration mismatch.
- Put each hook in the smallest component that needs it. Calling `useMicFft()`
  in a large component reintroduces exactly the rerender cost the hooks exist to
  avoid.

`examples/next-app/components/Waveform.tsx` renders both FFT hooks; see the
[Next.js reference app](../examples/next-app).

## Reference

- [`usePlayerFft`](/reference/api/voice-react.useplayerfft)
- [`useMicFft`](/reference/api/voice-react.usemicfft)
- [`useCallDurationTimestamp`](/reference/api/voice-react.usecalldurationtimestamp)
- [`FftSnapshot`](/reference/api/voice-react.fftsnapshot)
