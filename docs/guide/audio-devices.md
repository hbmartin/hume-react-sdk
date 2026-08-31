---
description: 'Enumerate microphones and speakers, and switch them during a live call.'
---

# Audio devices

Use `useAudioDevices` to enumerate microphones and speakers. The hook does not
request microphone permission on mount by default; call `requestPermission` from
a user gesture to reveal device labels and selectable device identifiers.

## A device picker

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

## The empty `deviceId`

Before permission is granted, browsers may expose a privacy-redacted default
device with an empty `deviceId`. The hook leaves that device unselected so a call
can safely fall back to the browser default — which is why the example above
filters it out of the list rather than offering it as a choice.

## Requested versus active

`useVoice` publishes `requestedInputDeviceId`, `activeInputDeviceId`,
`requestedOutputDeviceId`, and `activeOutputDeviceId`.

The requested input can differ from the active microphone when the browser grants
a fallback device. **Render `activeInputDeviceId` during a connected call** so
device controls reflect what is actually capturing, not what you asked for.

## Switching during a call

`setInputDevice(deviceId)` and `setOutputDevice(deviceId)` switch the live
devices without reconnecting. Pass `null` to either to select the browser or
system default.

Live switching requires a connected session. Failures reject with an
`AudioDeviceSwitchError` and leave the call and the current working device
intact — a failed switch never interrupts a conversation.

| `reason`            | What happened                                                                    |
| ------------------- | -------------------------------------------------------------------------------- |
| `not_connected`     | No live session; connect first, or set the device through `connect({ devices })` |
| `permission_denied` | The user denied access or a browser/document policy blocked the microphone       |
| `device_not_found`  | The requested device is gone, or its constraints cannot be met                   |
| `unsupported`       | The browser does not implement output selection (`AudioContext.setSinkId`)       |
| `interrupted`       | The call or device changed while the switch was in flight                        |
| `switch_failed`     | Anything else — inspect `cause`                                                  |

Narrow with `isAudioDeviceSwitchError(error)` before reading `reason`.

## Browser caveats

- Microphone switching can prompt for permission.
- Output switching depends on `AudioContext.setSinkId`. Browsers without it can
  still use their default output, but reject non-default output switches with
  the `unsupported` reason.
- Device enumeration and output selection may require HTTPS as well as
  browser-granted media permission.

## Reference

- [`useAudioDevices`](/reference/api/voice-react.useaudiodevices)
- [`UseAudioDevicesReturn`](/reference/api/voice-react.useaudiodevicesreturn)
- [`AudioDeviceSwitchError`](/reference/api/voice-react.audiodeviceswitcherror)
- [`AudioDeviceSwitchErrorReason`](/reference/api/voice-react.audiodeviceswitcherrorreason)
- [`DeviceOptions`](/reference/api/voice-react.deviceoptions)
- Standalone helpers:
  [`getAllAudioDevices`](/reference/api/voice-react.getallaudiodevices),
  [`getInputDevices`](/reference/api/voice-react.getinputdevices),
  [`getOutputDevices`](/reference/api/voice-react.getoutputdevices),
  [`requestAudioDevicePermission`](/reference/api/voice-react.requestaudiodevicepermission)
