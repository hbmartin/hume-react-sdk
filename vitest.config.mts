import { defineConfig } from 'vitest/config';

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
      exclude: [
        '**/*.d.ts',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        'packages/react/src/worklets/audio-worklet-20250702.js',
      ],
      include: [
        'packages/embed/src/**/*.{ts,tsx}',
        'packages/embed-react/src/**/*.{ts,tsx}',
        'packages/react/src/**/*.{ts,tsx}',
        'examples/next-app/{app,components,utils}/**/*.{ts,tsx}',
        'examples/vite-app/src/**/*.{ts,tsx}',
        'examples/vite-app-embed/src/**/*.{ts,tsx}',
      ],
      provider: 'istanbul',
      reporter: ['text-summary', 'json'],
      reportsDirectory: 'coverage',
      thresholds: {
        autoUpdate: false,
        'examples/next-app/**': {
          branches: 23,
          functions: 16,
          lines: 26,
          statements: 26,
        },
        'examples/vite-app-embed/src/**': {
          branches: 0,
          functions: 0,
          lines: 0,
          statements: 0,
        },
        'examples/vite-app/src/**': {
          branches: 0,
          functions: 0,
          lines: 0,
          statements: 0,
        },
        'packages/embed-react/src/**': {
          branches: 95,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        'packages/embed/src/**': {
          branches: 78,
          functions: 87,
          lines: 90,
          statements: 90,
        },
        'packages/react/src/**': {
          branches: 79,
          functions: 89,
          lines: 89,
          statements: 88,
        },
      },
    },
  },
});
