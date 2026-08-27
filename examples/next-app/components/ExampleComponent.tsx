'use client';

import {
  isAudioDeviceSwitchError,
  useAudioDevices,
  useCallDurationTimestamp,
  useVoice,
} from '@humeai/voice-react';
import { useState } from 'react';
import { match } from 'ts-pattern';

import { ChatConnected } from './ChatConnected';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './Select';

const BROWSER_DEFAULT_DEVICE_VALUE = 'browser-default';
const DEVICE_VALUE_PREFIX = 'device:';
const toDeviceValue = (deviceId: string | null) =>
  deviceId === null
    ? BROWSER_DEFAULT_DEVICE_VALUE
    : `${DEVICE_VALUE_PREFIX}${deviceId}`;
const fromDeviceValue = (value: string) =>
  value === BROWSER_DEFAULT_DEVICE_VALUE
    ? null
    : value.slice(DEVICE_VALUE_PREFIX.length);

export const ExampleComponent = ({
  accessToken,
  configId,
}: {
  accessToken: string;
  configId?: string;
}) => {
  const {
    activeInputDeviceId,
    activeOutputDeviceId,
    connect,
    disconnect,
    setInputDevice,
    setOutputDevice,
    status,
  } = useVoice();
  const callDurationTimestamp = useCallDurationTimestamp();
  const [isSwitchingInput, setIsSwitchingInput] = useState(false);
  const [isSwitchingOutput, setIsSwitchingOutput] = useState(false);
  const [deviceSwitchError, setDeviceSwitchError] = useState<Error | null>(
    null,
  );
  const {
    inputDevices: audioInputDevices,
    outputDevices: audioOutputDevices,
    selectedInputDeviceId: selectedMicrophoneId,
    selectedOutputDeviceId: selectedSpeakerId,
    setSelectedInputDeviceId: setSelectedMicrophoneId,
    setSelectedOutputDeviceId: setSelectedSpeakerId,
    requestPermission: requestDevicePermission,
    isLoading: areDevicesLoading,
    error: deviceError,
    permissionDenied,
    permissionError,
  } = useAudioDevices();
  const selectableInputDevices = audioInputDevices.filter(
    (device) => device.deviceId !== '',
  );
  const selectableOutputDevices = audioOutputDevices.filter(
    (device) => device.deviceId !== '',
  );
  const displayedDeviceError = permissionError ?? deviceError;
  const displayedMicrophoneId =
    status.value === 'connected' ? activeInputDeviceId : selectedMicrophoneId;
  const displayedSpeakerId =
    status.value === 'connected' ? activeOutputDeviceId : selectedSpeakerId;

  const selectInputDevice = async (value: string) => {
    const deviceId = fromDeviceValue(value);
    if (status.value !== 'connected') {
      setSelectedMicrophoneId(deviceId);
      return;
    }

    setIsSwitchingInput(true);
    setDeviceSwitchError(null);
    try {
      await setInputDevice(deviceId);
      setSelectedMicrophoneId(deviceId);
    } catch (error) {
      setDeviceSwitchError(
        isAudioDeviceSwitchError(error)
          ? error
          : new Error('The microphone could not be switched.'),
      );
    } finally {
      setIsSwitchingInput(false);
    }
  };

  const selectOutputDevice = async (value: string) => {
    const deviceId = fromDeviceValue(value);
    if (status.value !== 'connected') {
      setSelectedSpeakerId(deviceId);
      return;
    }

    setIsSwitchingOutput(true);
    setDeviceSwitchError(null);
    try {
      await setOutputDevice(deviceId);
      setSelectedSpeakerId(deviceId);
    } catch (error) {
      setDeviceSwitchError(
        isAudioDeviceSwitchError(error)
          ? error
          : new Error('The speaker could not be switched.'),
      );
    } finally {
      setIsSwitchingOutput(false);
    }
  };

  const connectArgs = {
    auth: {
      type: 'accessToken' as const,
      value: accessToken,
    },
    hostname:
      process.env['NEXT_PUBLIC_HUME_VOICE_HOSTNAME'] === undefined ||
      process.env['NEXT_PUBLIC_HUME_VOICE_HOSTNAME'] === ''
        ? 'api.hume.ai'
        : process.env['NEXT_PUBLIC_HUME_VOICE_HOSTNAME'],
    ...(configId !== undefined && configId !== ''
      ? {
          configId,
          sessionSettings: {
            type: 'session_settings' as const,
            builtinTools: [{ name: 'web_search' as const }],
          },
        }
      : {}),
    devices: {
      ...(selectedMicrophoneId === null
        ? {}
        : { microphoneDeviceId: selectedMicrophoneId }),
      ...(selectedSpeakerId === null
        ? {}
        : { speakerDeviceId: selectedSpeakerId }),
    },
  };

  const deviceSelectors = (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Microphone</div>
        <Select
          disabled={isSwitchingInput}
          value={toDeviceValue(displayedMicrophoneId)}
          onValueChange={(value) => void selectInputDevice(value)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select microphone" />
          </SelectTrigger>
          <SelectContent className="max-h-60 overflow-y-auto rounded-md border bg-white shadow-lg">
            <SelectItem
              value={BROWSER_DEFAULT_DEVICE_VALUE}
              className="cursor-pointer px-8 py-2 hover:bg-gray-100"
            >
              Browser default
            </SelectItem>
            {selectableInputDevices.length === 0 ? (
              <div className="px-3 py-2 text-sm text-neutral-500">
                Grant microphone permission to choose a device.
              </div>
            ) : (
              selectableInputDevices.map((device) => (
                <SelectItem
                  key={device.deviceId}
                  value={toDeviceValue(device.deviceId)}
                  className="cursor-pointer px-8 py-2 hover:bg-gray-100"
                >
                  {device.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Speaker</div>
        <Select
          disabled={isSwitchingOutput}
          value={toDeviceValue(displayedSpeakerId)}
          onValueChange={(value) => void selectOutputDevice(value)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select speaker" />
          </SelectTrigger>
          <SelectContent className="max-h-60 overflow-y-auto rounded-md border bg-white shadow-lg">
            <SelectItem
              value={BROWSER_DEFAULT_DEVICE_VALUE}
              className="cursor-pointer px-8 py-2 hover:bg-gray-100"
            >
              Browser default
            </SelectItem>
            {selectableOutputDevices.length === 0 ? (
              <div className="px-3 py-2 text-sm text-neutral-500">
                Grant microphone permission to choose a device.
              </div>
            ) : (
              selectableOutputDevices.map((device) => (
                <SelectItem
                  key={device.deviceId}
                  value={toDeviceValue(device.deviceId)}
                  className="cursor-pointer px-8 py-2 hover:bg-gray-100"
                >
                  {device.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      <button
        className="max-w-sm rounded border border-neutral-500 p-2 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={areDevicesLoading}
        onClick={() => {
          void requestDevicePermission();
        }}
      >
        {areDevicesLoading
          ? 'Refreshing devices...'
          : 'Enable device selection'}
      </button>
      {permissionDenied ? (
        <div className="text-sm text-amber-700">
          Microphone permission was denied. You can still connect using the
          browser default device.
        </div>
      ) : null}
      {displayedDeviceError ? (
        <div className="text-sm text-red-500">
          {displayedDeviceError.message}
        </div>
      ) : null}
      {status.value === 'connected' && deviceSwitchError ? (
        <div className="text-sm text-red-500">
          {deviceSwitchError.message} The call is still connected.
        </div>
      ) : null}
    </div>
  );

  const connectButton = (
    <button
      className="max-w-sm rounded border border-neutral-500 p-2"
      onClick={() => {
        setDeviceSwitchError(null);
        void connect(connectArgs);
      }}
    >
      Connect to voice
    </button>
  );

  const callDuration = (
    <div>
      <div className={'text-sm font-medium uppercase'}>Call duration</div>
      <div>{callDurationTimestamp ?? 'n/a'}</div>
    </div>
  );

  return (
    <div>
      <div className={'flex flex-col gap-4 font-light'}>
        <div>
          <div className={'text-sm font-medium uppercase'}>Status</div>
          <div>{status.value}</div>
        </div>
        <div className="flex flex-col gap-4">
          {match(status.value)
            .with('connected', () => (
              <div className="flex flex-col gap-4">
                <ChatConnected />
                {deviceSelectors}
              </div>
            ))
            .with('disconnected', () => (
              <div className="flex flex-col gap-4">
                {(configId === undefined || configId === '') && (
                  <div className="rounded border border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-800">
                    Tool use is disabled. Please provide the HUME_CONFIG_ID
                    environment variable to enable tool use.
                  </div>
                )}
                {callDuration}
                {deviceSelectors}
                {connectButton}
              </div>
            ))
            .with('connecting', () => (
              <div className="flex max-w-sm flex-col gap-4">
                {callDuration}

                <button
                  className="cursor-not-allowed rounded border border-neutral-500 p-2"
                  disabled
                >
                  Connecting...
                </button>
                <button
                  className="rounded border border-red-500 p-2 text-red-500"
                  onClick={() => {
                    void disconnect();
                  }}
                >
                  Disconnect
                </button>
              </div>
            ))
            .with('error', () => (
              <div className="flex flex-col gap-4">
                {(configId === undefined || configId === '') && (
                  <div className="rounded border border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-800">
                    Tool use is disabled. Please provide the HUME_CONFIG_ID
                    environment variable to enable tool use.
                  </div>
                )}
                {callDuration}
                {deviceSelectors}
                {connectButton}
                <div>
                  <span className="text-red-500">{status.reason}</span>
                </div>
              </div>
            ))
            .exhaustive()}
        </div>
      </div>
    </div>
  );
};
