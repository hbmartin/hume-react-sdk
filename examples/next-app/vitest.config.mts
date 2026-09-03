// fallow-ignore-next-line boundary-violation -- test configuration intentionally consumes shared workspace tooling
import sharedVitestConfig from '@humeai/vitest-config/base';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    environment: 'node',
  },
});
