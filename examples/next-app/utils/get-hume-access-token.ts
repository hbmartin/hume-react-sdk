import 'server-only';
import { fetchAccessToken } from 'hume';
import { z } from 'zod';

import { HUME_VOICE_HOSTNAME } from './hume';

const ACCESS_TOKEN_REUSE_MS = 25 * 60 * 1000;
const AccessTokenSchema = z.string().trim().min(1);

type HumeCredentials = {
  apiKey: string;
  secretKey: string;
};

export type HumeAccessToken = {
  accessToken: string;
  refreshAt: number;
};

type CachedAccessToken = HumeAccessToken & {
  credentialIdentity: string;
};

let cachedAccessToken: CachedAccessToken | undefined;
const pendingAccessTokens = new Map<string, Promise<HumeAccessToken>>();

const isPresent = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

const readHumeCredentials = (): HumeCredentials => {
  const apiKey = process.env['HUME_API_KEY'];
  const secretKey = process.env['HUME_SECRET_KEY'];

  if (!isPresent(apiKey) || !isPresent(secretKey)) {
    throw new MissingHumeCredentialsError();
  }

  return { apiKey, secretKey };
};

const getCredentialIdentity = ({ apiKey, secretKey }: HumeCredentials) =>
  `${apiKey}\u0000${secretKey}\u0000${HUME_VOICE_HOSTNAME}`;

export class MissingHumeCredentialsError extends Error {
  constructor() {
    super('HUME_API_KEY and HUME_SECRET_KEY must both be configured.');
    this.name = 'MissingHumeCredentialsError';
  }
}

export const hasHumeCredentials = () =>
  isPresent(process.env['HUME_API_KEY']) &&
  isPresent(process.env['HUME_SECRET_KEY']);

export const getHumeAccessToken = async (): Promise<HumeAccessToken> => {
  const credentials = readHumeCredentials();
  const credentialIdentity = getCredentialIdentity(credentials);
  const now = Date.now();

  if (
    cachedAccessToken !== undefined &&
    cachedAccessToken.credentialIdentity === credentialIdentity &&
    cachedAccessToken.refreshAt > now
  ) {
    return {
      accessToken: cachedAccessToken.accessToken,
      refreshAt: cachedAccessToken.refreshAt,
    };
  }

  const pendingAccessToken = pendingAccessTokens.get(credentialIdentity);
  if (pendingAccessToken !== undefined) {
    return pendingAccessToken;
  }

  const request = (async () => {
    const accessToken = AccessTokenSchema.parse(
      await fetchAccessToken({
        ...credentials,
        host: HUME_VOICE_HOSTNAME,
      }),
    );
    const result = {
      accessToken,
      refreshAt: Date.now() + ACCESS_TOKEN_REUSE_MS,
    };

    cachedAccessToken = { ...result, credentialIdentity };
    return result;
  })();

  pendingAccessTokens.set(credentialIdentity, request);

  try {
    return await request;
  } finally {
    pendingAccessTokens.delete(credentialIdentity);
  }
};
