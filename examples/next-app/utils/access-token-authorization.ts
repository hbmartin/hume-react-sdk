import 'server-only';

/**
 * This repository does not know which users a consuming application authorizes.
 * Keep the local example convenient, but fail closed when somebody deploys it.
 * Replace this function with a server-verified session and authorization check
 * before enabling the access-token route in production.
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
