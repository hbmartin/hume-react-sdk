import 'server-only';

/**
 * CSRF hardening for the loopback-bound development example. The dev and start
 * scripts' 127.0.0.1 bind is the security boundary: request URLs and headers do
 * not prove that a caller is local. Do not expose this endpoint through a
 * tunnel, proxy, port forward, or non-loopback bind. Replace this function with
 * a server-verified session and authorization check before doing so or before
 * enabling the access-token route in production.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

export const isHumeAccessTokenRequestAuthorized = (request: Request) => {
  if (process.env.NODE_ENV !== 'development') return false;

  try {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get('Origin');
    const fetchSite = request.headers.get('Sec-Fetch-Site');
    return (
      LOOPBACK_HOSTNAMES.has(requestUrl.hostname) &&
      origin !== null &&
      new URL(origin).origin === requestUrl.origin &&
      (fetchSite === null || fetchSite === 'same-origin')
    );
  } catch {
    return false;
  }
};
