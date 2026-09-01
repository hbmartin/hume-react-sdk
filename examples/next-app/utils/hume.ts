import { DEFAULT_HUME_HOSTNAME, normalizeHumeHostname } from './hume-hostname';

const configuredVoiceHostname =
  process.env.NEXT_PUBLIC_HUME_VOICE_HOSTNAME?.trim();

const resolveVoiceHostname = () => {
  if (configuredVoiceHostname === undefined || configuredVoiceHostname === '') {
    return DEFAULT_HUME_HOSTNAME;
  }

  const normalizedHostname = normalizeHumeHostname(configuredVoiceHostname);
  if (normalizedHostname === null) {
    throw new Error(
      'NEXT_PUBLIC_HUME_VOICE_HOSTNAME must be a hostname with an optional port and without a scheme, credentials, path, query, or fragment.',
    );
  }

  return normalizedHostname;
};

export const HUME_VOICE_HOSTNAME = resolveVoiceHostname();

export const HUME_ACCESS_TOKEN_ENDPOINT = '/api/access-token';
