/** Return a monotonic timestamp when the host exposes the Performance API. */
export const getMonotonicTime = () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- older embedded browsers can omit the typed Performance global
  return globalThis.performance?.now() ?? Date.now();
};
