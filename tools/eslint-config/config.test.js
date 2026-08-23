/* eslint-env commonjs */
const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

const { Linter } = require('eslint');

const rushstackPatch = '@rushstack/eslint-patch/modern-module-resolution';
const originalLoad = Module._load;

Module._load = (request, parent, isMain) => {
  if (request === rushstackPatch) {
    return {};
  }

  return originalLoad(request, parent, isMain);
};

let baseConfig;
let nextConfig;

try {
  baseConfig = require('./base');
  nextConfig = require('./nextjs');
} finally {
  Module._load = originalLoad;
}

const testOverride = baseConfig.overrides.find((override) =>
  override.files.includes('*.test.ts'),
);

const verifyFocusedTest = (source) => {
  const linter = new Linter();
  return linter.verify(source, {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'no-restricted-syntax': testOverride.rules['no-restricted-syntax'],
    },
  });
};

test('focused-test guard covers direct, chained, and aliased Vitest APIs', () => {
  const focusedTests = [
    "describe.only('suite', () => {});",
    "test.only.each([[1]])('case', () => {});",
    "describe.concurrent.only('suite', () => {});",
    "suite.only('suite', () => {});",
  ];

  for (const source of focusedTests) {
    assert.equal(
      verifyFocusedTest(source).filter(
        (message) => message.ruleId === 'no-restricted-syntax',
      ).length,
      1,
      source,
    );
  }
  assert.equal(verifyFocusedTest("test('case', () => {});").length, 0);
});

test('focused-test guard applies to test and spec TypeScript files', () => {
  assert.deepEqual(testOverride.files, [
    '*.test.ts',
    '*.test.tsx',
    '*.spec.ts',
    '*.spec.tsx',
  ]);
});

test('Next.js default-export exceptions cover root and src route trees', () => {
  const defaultExportOverride = nextConfig.overrides.find(
    (override) => override.rules?.['import/no-default-export'] === 'error',
  );

  for (const routePattern of [
    'app/**',
    'src/app/**',
    'pages/**',
    'src/pages/**',
  ]) {
    assert.ok(
      defaultExportOverride.excludedFiles.includes(routePattern),
      routePattern,
    );
  }
});
