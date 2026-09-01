'use client';

import {
  isAudioDeviceSwitchError,
  useAudioDevices,
  useCallDurationTimestamp,
  useVoice,
} from '@humeai/voice-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { match } from 'ts-pattern';
import { z } from 'zod';

import {
  createAccessTokenLease,
  isAccessTokenLeaseUsable,
  type AccessTokenLease,
  type ScheduledAccessTokenLease,
} from '../utils/access-token-lifecycle';
import { HUME_ACCESS_TOKEN_ENDPOINT, HUME_VOICE_HOSTNAME } from '../utils/hume';
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

const ACCESS_TOKEN_RETRY_DELAY_MS = 60 * 1000;
const MINIMUM_ACCESS_TOKEN_REFRESH_DELAY_MS = 1000;
const AccessTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresAfterMs: z.number().int().positive(),
  refreshAfterMs: z.number().int().nonnegative(),
});
const AccessTokenErrorResponseSchema = z.object({
  error: z.string().min(1),
});

const getMonotonicTime = () => performance.now();

export const ExampleComponent = ({ configId }: { configId?: string }) => {
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
  const [accessToken, setAccessToken] = useState<AccessTokenLease | null>(null);
  const [accessTokenError, setAccessTokenError] = useState<string | null>(null);
  const [connectionAttemptError, setConnectionAttemptError] = useState<
    string | null
  >(null);
  const [isAccessTokenLoading, setIsAccessTokenLoading] = useState(true);
  const accessTokenRequestRef =
    useRef<Promise<ScheduledAccessTokenLease | null> | null>(null);
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

  const refreshAccessToken = useCallback(() => {
    if (accessTokenRequestRef.current !== null) {
      return accessTokenRequestRef.current;
    }

    setIsAccessTokenLoading(true);
    setAccessTokenError(null);

    const requestStartedAt = getMonotonicTime();
    const request = (async (): Promise<ScheduledAccessTokenLease | null> => {
      try {
        const response = await fetch(HUME_ACCESS_TOKEN_ENDPOINT, {
          method: 'POST',
          cache: 'no-store',
        });

        let responseBody: unknown;
        try {
          responseBody = await response.json();
        } catch {
          throw new Error('The access-token endpoint returned invalid JSON.');
        }

        if (!response.ok) {
          const errorResponse =
            AccessTokenErrorResponseSchema.safeParse(responseBody);
          throw new Error(
            errorResponse.success
              ? errorResponse.data.error
              : 'The server could not create a Hume access token.',
          );
        }

        const tokenResponse = AccessTokenResponseSchema.safeParse(responseBody);
        if (!tokenResponse.success) {
          throw new Error(
            'The access-token endpoint returned an invalid response.',
          );
        }

        const receivedToken = createAccessTokenLease(
          tokenResponse.data,
          requestStartedAt,
          getMonotonicTime(),
        );
        if (receivedToken === null) {
          throw new Error(
            'The access-token endpoint returned an expired token.',
          );
        }

        setAccessToken(receivedToken.lease);
        return receivedToken;
      } catch (error) {
        const now = getMonotonicTime();
        setAccessToken((currentToken) =>
          isAccessTokenLeaseUsable(currentToken, now) ? currentToken : null,
        );
        setAccessTokenError(
          error instanceof Error && error.message !== ''
            ? error.message
            : 'The server could not create a Hume access token.',
        );
        return null;
      }
    })();

    accessTokenRequestRef.current = request;
    void request.finally(() => {
      if (accessTokenRequestRef.current === request) {
        accessTokenRequestRef.current = null;
        setIsAccessTokenLoading(false);
      }
    });

    return request;
  }, []);

  useEffect(() => {
    if (accessToken === null) return;

    const expiringToken = accessToken;
    const expiresAfterMs = Math.max(
      0,
      expiringToken.expiresAt - getMonotonicTime(),
    );
    const expirationTimer = window.setTimeout(() => {
      setAccessToken((currentToken) =>
        currentToken === expiringToken ? null : currentToken,
      );
    }, expiresAfterMs + 1);

    return () => window.clearTimeout(expirationTimer);
  }, [accessToken]);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | undefined;

    const refreshAndSchedule = async () => {
      const tokenResponse = await refreshAccessToken();
      if (cancelled) {
        return;
      }

      const refreshDelay =
        tokenResponse === null
          ? ACCESS_TOKEN_RETRY_DELAY_MS
          : Math.max(
              tokenResponse.refreshAfterMs,
              MINIMUM_ACCESS_TOKEN_REFRESH_DELAY_MS,
            );
      refreshTimer = window.setTimeout(() => {
        void refreshAndSchedule();
      }, refreshDelay);
    };

    void refreshAndSchedule();

    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [refreshAccessToken]);

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

  const connectOptions = {
    hostname: HUME_VOICE_HOSTNAME,
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

  const connectToVoice = async () => {
    setDeviceSwitchError(null);
    setConnectionAttemptError(null);

    const usableAccessToken = isAccessTokenLeaseUsable(
      accessToken,
      getMonotonicTime(),
    )
      ? accessToken
      : ((await refreshAccessToken())?.lease ?? null);
    if (usableAccessToken === null) {
      return;
    }

    try {
      await connect({
        ...connectOptions,
        auth: {
          type: 'accessToken',
          value: usableAccessToken.accessToken,
        },
      });
    } catch (error) {
      setConnectionAttemptError(
        error instanceof Error && error.message !== ''
          ? error.message
          : 'The voice connection could not be started.',
      );
    }
  };

  const hasUsableAccessToken = isAccessTokenLeaseUsable(
    accessToken,
    getMonotonicTime(),
  );
  const connectionFeedback = (
    <>
      {accessTokenError === null ? null : (
        <div
          className={
            hasUsableAccessToken
              ? 'text-sm text-amber-700'
              : 'text-sm text-red-500'
          }
        >
          {hasUsableAccessToken
            ? `Access-token refresh failed. The existing token remains usable until it expires. ${accessTokenError}`
            : accessTokenError}
        </div>
      )}
      {connectionAttemptError === null ? null : (
        <div className="text-sm text-red-500">{connectionAttemptError}</div>
      )}
    </>
  );

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
          {permissionError !== null
            ? 'Microphone access is blocked or unavailable. '
            : null}
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
      className="max-w-sm rounded border border-neutral-500 p-2 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={isAccessTokenLoading && !hasUsableAccessToken}
      onClick={() => {
        void connectToVoice();
      }}
    >
      {isAccessTokenLoading && !hasUsableAccessToken
        ? 'Preparing access token...'
        : 'Connect to voice'}
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
                {connectionFeedback}
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
                {connectionFeedback}
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
