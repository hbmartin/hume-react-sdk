const sharedVitestConfig = {
  test: {
    // Load-bearing for React packages: React Testing Library registers its
    // automatic cleanup against the global `afterEach` hook at import time.
    globals: true,
    environment: 'jsdom',
    watch: false,
    // Mock state does not leak between tests: call history is cleared and
    // implementations are restored before each test, so a mock declared at
    // module scope cannot make one test depend on another test having run.
    clearMocks: true,
    restoreMocks: true,
  },
};

export default sharedVitestConfig;
