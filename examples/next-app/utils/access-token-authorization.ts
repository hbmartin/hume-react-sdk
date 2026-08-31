import 'server-only';

/**
 * This repository does not know which users a consuming application authorizes.
 * Keep the local example convenient, but fail closed when somebody deploys it.
 * Replace this function with a server-verified session and authorization check
 * before enabling the access-token route in production.
 */
export const isHumeAccessTokenRequestAuthorized = (request: Request) =>
  process.env.NODE_ENV === 'development' &&
  ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(request.url).hostname);
