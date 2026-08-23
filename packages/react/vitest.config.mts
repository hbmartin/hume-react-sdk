import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    watch: false,
    // Mock state does not leak between tests: call history is cleared and
    // implementations are restored before each test, so a mock declared at
    // module scope cannot make one test depend on another test having run.
    clearMocks: true,
    restoreMocks: true,
  },
});
