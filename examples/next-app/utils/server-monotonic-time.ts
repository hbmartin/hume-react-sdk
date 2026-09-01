import 'server-only';

/** Monotonic process-local time for server cache deadlines. */
export const getServerMonotonicTime = () => performance.now();
