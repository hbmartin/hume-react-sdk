import { defineConfig } from 'vitest/config';

import coveragePolicy from './coverage-policy.json' with { type: 'json' };

export default defineConfig({
  test: {
    projects: [
      'packages/embed/vitest.config.mts',
      'packages/embed-react/vitest.config.mts',
      'packages/react/vitest.config.mts',
      'examples/next-app/vitest.config.mts',
    ],
    coverage: {
      autoUpdate: false,
      exclude: coveragePolicy.exclude,
      include: coveragePolicy.include,
      provider: 'istanbul',
      reporter: ['text-summary', 'json'],
      reportsDirectory: 'coverage',
      thresholds: {
        autoUpdate: false,
        ...coveragePolicy.thresholds,
      },
    },
  },
});
