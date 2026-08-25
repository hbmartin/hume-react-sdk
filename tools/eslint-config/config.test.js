/* eslint-env commonjs */
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const { ESLint, Linter } = require('eslint');

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
let reactConfig;

try {
  baseConfig = require('./base');
  nextConfig = require('./nextjs');
  reactConfig = require('./react');
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

test('React config enforces exhaustive hook dependencies', () => {
  assert.equal(reactConfig.rules['react-hooks/exhaustive-deps'], 'error');
  assert.ok(reactConfig.extends.includes('plugin:react/recommended'));
  assert.ok(reactConfig.extends.includes('plugin:react/jsx-runtime'));
  assert.ok(reactConfig.extends.includes('plugin:react-hooks/recommended'));
});

test('Next.js config inherits the shared React config', async () => {
  assert.ok(nextConfig.extends.includes(require.resolve('./react.js')));

  const repositoryRoot = path.resolve(__dirname, '../..');
  const eslint = new ESLint({
    cwd: repositoryRoot,
    useEslintrc: false,
    overrideConfig: {
      extends: [require.resolve('./nextjs.js')],
    },
  });
  const effectiveConfig = await eslint.calculateConfigForFile(
    path.join(repositoryRoot, 'examples/next-app/app/page.tsx'),
  );

  assert.deepEqual(effectiveConfig.rules['react-hooks/exhaustive-deps'], [
    'error',
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
