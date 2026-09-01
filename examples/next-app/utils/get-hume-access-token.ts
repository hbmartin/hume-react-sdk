import 'server-only';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { DEFAULT_HUME_HOSTNAME, normalizeHumeHostname } from './hume-hostname';
import { getServerMonotonicTime } from './server-monotonic-time';

const TOKEN_REUSE_NUMERATOR = 5;
const TOKEN_REUSE_DENOMINATOR = 6;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const HUME_ACCESS_TOKEN_LIFETIME_SECONDS = 30 * 60;
const OAuthAccessTokenSchema = z.object({
  access_token: z.string().trim().min(1),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(HUME_ACCESS_TOKEN_LIFETIME_SECONDS),
});

type HumeCredentials = {
  apiKey: string;
  secretKey: string;
};

export type HumeAccessToken = {
  accessToken: string;
  expiresAfterMs: number;
  refreshAfterMs: number;
};

type CachedAccessToken = {
  accessToken: string;
  credentialIdentity: string;
  expiresAt: number;
  reuseUntil: number;
};

let cachedAccessToken: CachedAccessToken | undefined;
const pendingAccessTokens = new Map<string, Promise<CachedAccessToken>>();

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

const readHumeTokenHostname = () => {
  const configuredHostname = process.env['HUME_TOKEN_HOSTNAME']?.trim();
  if (configuredHostname === undefined || configuredHostname === '') {
    return DEFAULT_HUME_HOSTNAME;
  }

  const normalizedHostname = normalizeHumeHostname(configuredHostname);
  if (normalizedHostname === null) {
    throw new Error(
      'HUME_TOKEN_HOSTNAME must be a hostname with an optional port and without a scheme, credentials, path, query, or fragment.',
    );
  }
  return normalizedHostname;
};

const getCredentialIdentity = (
  { apiKey, secretKey }: HumeCredentials,
  tokenHostname: string,
) =>
  createHash('sha256')
    .update(apiKey)
    .update('\0')
    .update(secretKey)
    .update('\0')
    .update(tokenHostname)
    .digest('base64url');

const toAccessTokenResponse = (
  token: CachedAccessToken,
  now: number,
): HumeAccessToken => ({
  accessToken: token.accessToken,
  expiresAfterMs: Math.max(0, token.expiresAt - now),
  refreshAfterMs: Math.max(0, token.reuseUntil - now),
});

const fetchHumeAccessToken = async (
  credentials: HumeCredentials,
  credentialIdentity: string,
  tokenHostname: string,
): Promise<CachedAccessToken> => {
  const requestedAt = getServerMonotonicTime();
  const auth = Buffer.from(
    `${credentials.apiKey}:${credentials.secretKey}`,
    'utf8',
  ).toString('base64');
  const response = await fetch(`https://${tokenHostname}/oauth2-cc/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
    }).toString(),
    cache: 'no-store',
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Hume rejected the access-token request with status ${response.status}.`,
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error('Hume returned an invalid access-token response.');
  }

  const tokenResponse = OAuthAccessTokenSchema.safeParse(responseBody);
  if (!tokenResponse.success) {
    throw new Error(
      'Hume returned an access token without a valid expiration duration.',
    );
  }

  const expiresInMs = tokenResponse.data.expires_in * 1000;
  const reuseForMs = Math.max(
    1,
    Math.floor((expiresInMs * TOKEN_REUSE_NUMERATOR) / TOKEN_REUSE_DENOMINATOR),
  );

  return {
    accessToken: tokenResponse.data.access_token,
    credentialIdentity,
    expiresAt: requestedAt + expiresInMs,
    reuseUntil: requestedAt + reuseForMs,
  };
};

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
  const tokenHostname = readHumeTokenHostname();
  const credentialIdentity = getCredentialIdentity(credentials, tokenHostname);
  const now = getServerMonotonicTime();

  if (
    cachedAccessToken !== undefined &&
    cachedAccessToken.credentialIdentity === credentialIdentity &&
    cachedAccessToken.reuseUntil > now
  ) {
    return toAccessTokenResponse(cachedAccessToken, now);
  }

  const pendingAccessToken = pendingAccessTokens.get(credentialIdentity);
  if (pendingAccessToken !== undefined) {
    return toAccessTokenResponse(
      await pendingAccessToken,
      getServerMonotonicTime(),
    );
  }

  const request = fetchHumeAccessToken(
    credentials,
    credentialIdentity,
    tokenHostname,
  );
  pendingAccessTokens.set(credentialIdentity, request);

  try {
    const result = await request;
    cachedAccessToken = result;
    return toAccessTokenResponse(result, getServerMonotonicTime());
  } finally {
    pendingAccessTokens.delete(credentialIdentity);
  }
};
