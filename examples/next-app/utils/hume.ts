import { resolveHumeHostname } from './hume-hostname';

const voiceHostnameResolution = resolveHumeHostname(
  process.env.NEXT_PUBLIC_HUME_VOICE_HOSTNAME,
  'NEXT_PUBLIC_HUME_VOICE_HOSTNAME',
);

export const HUME_VOICE_HOSTNAME = voiceHostnameResolution.hostname;
export const HUME_VOICE_HOSTNAME_ERROR = voiceHostnameResolution.error;

export const HUME_ACCESS_TOKEN_ENDPOINT = '/api/access-token';
