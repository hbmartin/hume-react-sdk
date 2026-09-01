export const DEFAULT_HUME_HOSTNAME = 'api.hume.ai';

export type HumeHostnameResolution =
  | { error: null; hostname: string }
  | { error: string; hostname: null };

/**
 * Accept a hostname with an optional port and return its URL-canonical form.
 * Schemes, credentials, paths, and encoded delimiters are deliberately rejected
 * so callers can safely add their own HTTPS/WSS scheme and path.
 */
export const normalizeHumeHostname = (value: string): string | null => {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f);
  });
  if (
    value === '' ||
    value.includes('%') ||
    value.includes('@') ||
    hasControlCharacter
  ) {
    return null;
  }

  try {
    const url = new URL(`https://${value}/`);
    return url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
      ? url.host
      : null;
  } catch {
    return null;
  }
};

/** Resolve an optional Hume hostname without silently accepting invalid input. */
export const resolveHumeHostname = (
  value: string | undefined,
  environmentVariableName: string,
): HumeHostnameResolution => {
  const configuredHostname = value?.trim();
  if (configuredHostname === undefined || configuredHostname === '') {
    return { error: null, hostname: DEFAULT_HUME_HOSTNAME };
  }

  const hostname = normalizeHumeHostname(configuredHostname);
  if (hostname === null) {
    return {
      error: `${environmentVariableName} must be a hostname with an optional port and without a scheme, credentials, path, query, or fragment.`,
      hostname: null,
    };
  }

  return { error: null, hostname };
};
