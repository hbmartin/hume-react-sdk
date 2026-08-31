const DEFAULT_HUME_VOICE_HOSTNAME = 'api.hume.ai';

const configuredVoiceHostname =
  process.env.NEXT_PUBLIC_HUME_VOICE_HOSTNAME?.trim();

export const HUME_VOICE_HOSTNAME =
  configuredVoiceHostname === undefined || configuredVoiceHostname === ''
    ? DEFAULT_HUME_VOICE_HOSTNAME
    : configuredVoiceHostname;

export const HUME_ACCESS_TOKEN_ENDPOINT = '/api/access-token';
