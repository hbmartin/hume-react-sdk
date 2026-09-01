export const DEFAULT_HUME_HOSTNAME = 'api.hume.ai';

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
  if (value === '' || value.includes('%') || hasControlCharacter) {
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
