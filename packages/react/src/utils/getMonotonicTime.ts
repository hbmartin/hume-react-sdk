/** Return a monotonic timestamp when the host exposes the Performance API. */
export const getMonotonicTime = () => {
  try {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- older embedded browsers can omit the typed Performance global
    return globalThis.performance?.now() ?? Date.now();
  } catch {
    // A host-provided Performance implementation must not make diagnostic
    // timing fatal. Fall through to the wall clock.
  }

  try {
    return Date.now();
  } catch {
    // Preserve the helper's number-only contract even in a damaged host where
    // both clocks have been replaced with throwing implementations.
    return 0;
  }
};
