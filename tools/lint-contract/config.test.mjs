import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

import {
  getCoveragePolicyErrors,
  getTrackedCoverageInputs,
} from '../quality-gate/check-coverage-map.mjs';
import { compareBaselineStates } from '../quality-gate/check-fallow-baseline-policy.mjs';
import {
  parseJsonc,
  resolveAuditBase,
} from '../quality-gate/quality-gate-utils.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const oxlint = resolve(repositoryRoot, 'node_modules/.bin/oxlint');
const fallow = resolve(repositoryRoot, 'node_modules/.bin/fallow');
const oxlintConfig = resolve(repositoryRoot, '.oxlintrc.json');
const baselinePolicy = resolve(
  repositoryRoot,
  'tools/quality-gate/check-fallow-baseline-policy.mjs',
);

/**
 * @param {string} root
 * @param {Record<string, string>} files
 */
const writeFixtureFiles = (root, files) => {
  for (const [path, contents] of Object.entries(files)) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
};

/**
 * @param {import('node:test').TestContext} t
 * @param {string} name
 * @param {Record<string, string>} files
 * @param {string} [parent]
 */
const createFixture = (
  t,
  name,
  files,
  parent = resolve(repositoryRoot, 'tools/lint-contract'),
) => {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, `${name}-`));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFixtureFiles(root, files);
  return root;
};

/**
 * @param {string} path
 * @param {string} tsconfig
 * @param {OxlintRunOptions} [options]
 */
const runOxlint = (
  path,
  tsconfig,
  { config = oxlintConfig, cwd = repositoryRoot } = {},
) => {
  const result = spawnSync(
    oxlint,
    [
      '--disable-nested-config',
      '--config',
      config,
      '--tsconfig',
      tsconfig,
      '--type-aware',
      '--deny-warnings',
      '--report-unused-disable-directives',
      '--format',
      'json',
      path,
    ],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    assert.fail(
      `Oxlint wrote no valid JSON for ${path}:\n${result.stdout}${result.stderr}`,
    );
  }
  const report =
    /** @type {{ diagnostics: { code: string }[], number_of_files: number }} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Oxlint owns this stable JSON reporter schema and the assertions below validate the consumed fields
      parsed
    );
  return { report, result };
};

/**
 * @param {string} path
 * @param {string} tsconfig
 * @param {string} expectedRule
 * @param {OxlintRunOptions} [options]
 */
const expectOxlintRule = (path, tsconfig, expectedRule, options) => {
  const { report, result } = runOxlint(path, tsconfig, options);
  assert.notEqual(result.status, 0, `${path} unexpectedly passed Oxlint`);
  assert.ok(
    report.diagnostics.some(({ code }) => code === expectedRule),
    `${path} did not report ${expectedRule}; received ${report.diagnostics
      .map(({ code }) => code)
      .join(', ')}`,
  );
};

/**
 * @param {string} path
 * @param {string} tsconfig
 * @param {OxlintRunOptions} [options]
 */
const expectOxlintPass = (path, tsconfig, options) => {
  const { report, result } = runOxlint(path, tsconfig, options);
  assert.equal(
    result.status,
    0,
    `${path} unexpectedly failed:\n${result.stdout}${result.stderr}`,
  );
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.number_of_files, 1);
};

/** @param {FallowFixtureConfig} [options] */
const fallowConfig = ({
  entry = ['src/index.ts'],
  projects = ['tsconfig.json'],
  rules = {},
  boundaries,
  duplicates,
} = {}) =>
  JSON.stringify({
    minimumVersion: '3.22.0',
    sealed: true,
    entry,
    typeAware: { enabled: true, projects, require: 'complete' },
    rules,
    ...(boundaries === undefined ? {} : { boundaries }),
    ...(duplicates === undefined ? {} : { duplicates }),
  });

const baseTypeScriptFixture = {
  'package.json': JSON.stringify({
    name: 'lint-contract-fixture',
    private: true,
    type: 'module',
  }),
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      target: 'ES2022',
    },
    include: ['src/**/*.ts'],
  }),
};

/**
 * @param {string} root
 * @param {'dead-code' | 'dupes' | 'health'} command
 * @param {string[]} [extraArgs]
 */
const runFallow = (root, command, extraArgs = []) => {
  const reportPath = resolve(root, `${command}-report.json`);
  const result = spawnSync(
    fallow,
    [
      '--root',
      root,
      '--config',
      resolve(root, '.fallowrc.json'),
      command,
      '--no-cache',
      '--format',
      'json',
      '--output-file',
      reportPath,
      ...extraArgs,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (!existsSync(reportPath)) {
    throw new Error(
      `Fallow ${command} wrote no report:\n${result.stdout}${result.stderr}`,
    );
  }
  const report = readFileSync(reportPath, 'utf8');
  const parsed = /** @type {FallowFixtureReport} */ (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture assertions validate each stable Fallow JSON field before relying on it
    JSON.parse(report)
  );
  return { result, report, parsed };
};

void test('production Oxlint config enforces every promoted rule with passing controls', (t) => {
  const cases = [
    {
      name: 'catch-callback',
      rule: 'typescript(use-unknown-in-catch-callback-variable)',
      failing: 'void Promise.resolve().catch((_error: Error) => {});',
      passing: 'void Promise.resolve().catch((_error: unknown) => {});',
    },
    {
      name: 'only-throw-error',
      rule: 'typescript(only-throw-error)',
      failing: "export function fail(): never { throw 'failure'; }",
      passing: "export function fail(): never { throw new Error('failure'); }",
    },
    {
      name: 'promise-reject-error',
      rule: 'typescript(prefer-promise-reject-errors)',
      failing:
        "export const rejected = Promise.reject('failure'); void rejected;",
      passing:
        "export const rejected = Promise.reject(new Error('failure')); void rejected;",
    },
    {
      name: 'floating-promise',
      rule: 'typescript(no-floating-promises)',
      failing: 'async function run() {} run();',
      passing: 'async function run() {} void run();',
    },
    {
      name: 'unsafe-assignment',
      rule: 'typescript(no-unsafe-assignment)',
      failing:
        'declare const unsafeValue: any; export const result = unsafeValue;',
      passing:
        'declare const value: unknown; export const result = typeof value === "string" ? value : "";',
    },
    {
      name: 'unnecessary-assertion',
      rule: 'typescript(no-unnecessary-type-assertion)',
      failing:
        "const value: string = 'value'; export const result = value as string;",
      passing: "export const result: string = 'value';",
    },
    {
      name: 'unsafe-assertion',
      rule: 'typescript(no-unsafe-type-assertion)',
      failing:
        'const value: unknown = {}; export const result = value as { name: string };',
      passing:
        "const value: unknown = {}; export const result = typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string' ? value.name : '';",
    },
    {
      name: 'manual-memoization.tsx',
      rule: 'react(preserve-manual-memoization)',
      failing:
        "import { useCallback, useRef } from 'react'; type Reporter = { emit: (input: { error: unknown; muted: boolean }) => void }; function useLatest<T>(value: T): { readonly current: T } { const latest = useRef(value); /* oxlint-disable-next-line react/refs -- fixture synchronizes an event ref */ latest.current = value; return latest; } export function useReportFailure(reporter: Reporter) { const latest = useLatest(reporter); return useCallback((muted: boolean, error: unknown) => { latest.current.emit({ error, muted }); }, [latest]); }",
      passing:
        "import { useMemo } from 'react'; export function Component({ value }: { value: { text: string } }) { return useMemo(() => value.text, [value]); }",
    },
    {
      name: 'exhaustive-deps.tsx',
      rule: 'react-hooks(exhaustive-deps)',
      failing:
        "import { useEffect } from 'react'; export function Component({ value }: { value: string }) { useEffect(() => { value.trim(); }, []); return null; }",
      passing:
        "import { useEffect } from 'react'; export function Component({ value }: { value: string }) { useEffect(() => { value.trim(); }, [value]); return null; }",
    },
    {
      name: 'throw-message.test',
      rule: 'vitest(require-to-throw-message)',
      failing:
        "import { expect, it } from 'vitest'; it('throws', () => { expect(() => { throw new Error('boom'); }).toThrow(); });",
      passing:
        "import { expect, it } from 'vitest'; it('throws', () => { expect(() => { throw new Error('boom'); }).toThrow('boom'); });",
    },
    {
      name: 'conditional-expect.test',
      rule: 'vitest(no-conditional-expect)',
      failing:
        "import { expect, it } from 'vitest'; it('checks', () => { if (Math.random() > 0.5) expect(true).toBe(true); });",
      passing:
        "import { expect, it } from 'vitest'; it('checks', () => { expect(true).toBe(true); });",
    },
    {
      name: 'explicit-any',
      rule: 'typescript(no-explicit-any)',
      failing: 'export const identity = (value: any) => value;',
      passing: 'export const identity = (value: unknown) => value;',
    },
    {
      name: 'base-to-string',
      rule: 'typescript(no-base-to-string)',
      failing: 'export const label = String({ value: 1 });',
      passing: "export const label = 'value';",
    },
    {
      name: 'restrict-plus',
      rule: 'typescript(restrict-plus-operands)',
      failing: 'declare const value: string; export const result = value + 1;',
      passing: 'declare const value: number; export const result = value + 1;',
    },
    {
      name: 'restrict-template',
      rule: 'typescript(restrict-template-expressions)',
      failing: 'declare const value: object; export const result = `${value}`;',
      passing:
        'declare const value: string; export const result = `value: ${value}`;',
    },
    {
      name: 'disabled.test',
      rule: 'vitest(no-disabled-tests)',
      failing:
        "import { it } from 'vitest'; it.skip('disabled', () => undefined);",
      passing:
        "import { expect, it } from 'vitest'; it('enabled', () => { expect(true).toBe(true); });",
    },
    {
      name: 'focused.test',
      rule: 'vitest(no-focused-tests)',
      failing:
        "import { it } from 'vitest'; it.only('focused', () => undefined);",
      passing:
        "import { expect, it } from 'vitest'; it('ordinary', () => { expect(true).toBe(true); });",
    },
    {
      name: 'conditional.test',
      rule: 'vitest(no-conditional-tests)',
      failing:
        "import { it } from 'vitest'; if (Math.random() > 0.5) it('conditional', () => undefined);",
      passing:
        "import { expect, it } from 'vitest'; it('unconditional', () => { expect(true).toBe(true); });",
    },
    {
      name: 'test-return.test',
      rule: 'vitest(no-test-return-statement)',
      failing:
        "import { expect, test } from 'vitest'; test('returns', () => { return expect(1).toBe(1); });",
      passing:
        "import { expect, it } from 'vitest'; it('awaits', async () => { await expect(Promise.resolve(1)).resolves.toBe(1); });",
    },
    {
      name: 'suspicious-category',
      rule: 'eslint(use-isnan)',
      failing:
        'declare const value: number; export const result = value === NaN;',
      passing:
        'declare const value: number; export const result = Number.isNaN(value);',
    },
    {
      name: 'unnecessary-condition',
      rule: 'typescript(no-unnecessary-condition)',
      failing:
        'declare const value: string; export const result = value !== undefined;',
      passing:
        'declare const value: string | undefined; export const result = value !== undefined;',
    },
    {
      name: 'refs.tsx',
      rule: 'react(refs)',
      failing:
        "import { useRef } from 'react'; export const useValue = () => { const ref = useRef(0); return ref.current; };",
      passing:
        "import { useRef } from 'react'; export const useIncrement = () => { const ref = useRef(0); return () => { ref.current += 1; }; };",
    },
  ];
  /** @type {Record<string, string>} */
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        jsx: 'react-jsx',
        lib: ['DOM', 'ES2022'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        target: 'ES2022',
      },
      include: ['**/*.ts', '**/*.tsx'],
    }),
    'react.d.ts':
      "declare module 'react' { export function useCallback<T>(callback: T, dependencies: readonly unknown[]): T; export function useEffect(effect: () => void, dependencies: readonly unknown[]): void; export function useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T; export function useRef<T>(value: T): { current: T }; }",
  };
  for (const fixture of cases) {
    const extension = fixture.name.endsWith('.tsx') ? '' : '.ts';
    files[`fail-${fixture.name}${extension}`] = fixture.failing;
    files[`pass-${fixture.name}${extension}`] = fixture.passing;
  }
  const root = createFixture(t, 'oxlint-rules', files);
  const tsconfig = resolve(root, 'tsconfig.json');
  for (const fixture of cases) {
    const extension = fixture.name.endsWith('.tsx') ? '' : '.ts';
    expectOxlintRule(
      resolve(root, `fail-${fixture.name}${extension}`),
      tsconfig,
      fixture.rule,
    );
    expectOxlintPass(
      resolve(root, `pass-${fixture.name}${extension}`),
      tsconfig,
    );
  }
});

void test('unused underscore exemptions apply only to parameters and caught errors', (t) => {
  const root = createFixture(t, 'oxlint-unused', {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
      },
      include: ['*.ts'],
    }),
    'local.ts': 'const _local = 1; export const used = 2;',
    'parameter.ts': 'export const fn = (_parameter: string) => 1;',
    'caught.ts':
      'try { throw new Error("boom"); } catch (_error) { exportValue(); } function exportValue() {}',
    'plain-parameter.ts': 'export const fn = (parameter: string) => 1;',
    'plain-caught.ts':
      'try { throw new Error("boom"); } catch (error) { exportValue(); } function exportValue() {}',
  });
  const tsconfig = resolve(root, 'tsconfig.json');
  expectOxlintRule(
    resolve(root, 'local.ts'),
    tsconfig,
    'eslint(no-unused-vars)',
  );
  expectOxlintPass(resolve(root, 'parameter.ts'), tsconfig);
  expectOxlintPass(resolve(root, 'caught.ts'), tsconfig);
  expectOxlintRule(
    resolve(root, 'plain-parameter.ts'),
    tsconfig,
    'eslint(no-unused-vars)',
  );
  expectOxlintRule(
    resolve(root, 'plain-caught.ts'),
    tsconfig,
    'eslint(no-unused-vars)',
  );
});

void test('production paths receive separated browser and Node environments', (t) => {
  const root = createFixture(
    t,
    'hume-production-environments',
    {
      '.oxlintrc.json': readFileSync(oxlintConfig, 'utf8'),
      'packages/react/tsconfig.json': JSON.stringify({
        compilerOptions: {
          lib: ['DOM', 'ES2022'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          target: 'ES2022',
        },
        include: ['src/**/*.ts'],
      }),
      'packages/react/src/browser.ts':
        'export const href = window.location.href;',
      'packages/react/src/node.ts': 'export const cwd = process.cwd();',
      'tools/quality-gate/tsconfig.json': JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          target: 'ES2022',
          typeRoots: [resolve(repositoryRoot, 'node_modules/@types')],
          types: ['node'],
        },
        include: ['*.mjs'],
      }),
      'tools/quality-gate/browser.mjs':
        'export const href = window.location.href;',
      'tools/quality-gate/node.mjs': 'export const cwd = process.cwd();',
    },
    tmpdir(),
  );
  const options = {
    config: resolve(root, '.oxlintrc.json'),
    cwd: repositoryRoot,
  };
  const browserTsconfig = resolve(root, 'packages/react/tsconfig.json');
  const nodeTsconfig = resolve(root, 'tools/quality-gate/tsconfig.json');
  expectOxlintPass(
    resolve(root, 'packages/react/src/browser.ts'),
    browserTsconfig,
    options,
  );
  expectOxlintRule(
    resolve(root, 'packages/react/src/node.ts'),
    browserTsconfig,
    'eslint(no-undef)',
    options,
  );
  expectOxlintPass(
    resolve(root, 'tools/quality-gate/node.mjs'),
    nodeTsconfig,
    options,
  );
  expectOxlintRule(
    resolve(root, 'tools/quality-gate/browser.mjs'),
    nodeTsconfig,
    'eslint(no-undef)',
    options,
  );
});

void test('tracked declarations are linted while generated declarations stay ignored', () => {
  const declarations = [
    'examples/next-app/types/environment.d.ts',
    'examples/next-app/types/promise-with-resolvers.d.ts',
    'examples/next-app/types/styles.d.ts',
    'examples/vite-app-embed/src/vite-env.d.ts',
    'examples/vite-app/src/vite-env.d.ts',
    'tools/typescript-config/hume-compat.d.ts',
  ];
  for (const declaration of declarations) {
    const absolutePath = resolve(repositoryRoot, declaration);
    const { report, result } = runOxlint(
      absolutePath,
      resolve(repositoryRoot, 'tsconfig.json'),
    );
    assert.equal(result.status, 0, `${declaration} failed lint`);
    assert.equal(report.number_of_files, 1, `${declaration} was ignored`);
  }

  const generated = spawnSync(
    oxlint,
    [
      '--disable-nested-config',
      '--config',
      oxlintConfig,
      '--format',
      'json',
      '--no-error-on-unmatched-pattern',
      resolve(repositoryRoot, 'examples/next-app/next-env.d.ts'),
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(generated.status, 0);
  assert.match(generated.stdout, /"number_of_files": 0/);
});

void test('ordinary dead-code analysis rejects private type leaks with complete semantics', (t) => {
  const root = createFixture(t, 'fallow-private-type', {
    ...baseTypeScriptFixture,
    '.fallowrc.json': fallowConfig({
      rules: {
        'private-type-leaks': 'error',
        'unused-exports': 'error',
      },
    }),
    'src/index.ts':
      "import './candidate.js'; type Hidden = { secret: string }; export const reveal = (): Hidden => ({ secret: 'value' });",
    'src/candidate.ts': 'export const semanticCandidate = 1;',
  });
  const { result, parsed } = runFallow(root, 'dead-code', ['--fail-on-issues']);
  assert.notEqual(result.status, 0, 'private type leak unexpectedly passed');
  assert.ok(
    parsed.private_type_leaks.length > 0,
    'private type diagnostic missing',
  );
  assert.equal(parsed._meta.type_aware.executed, true);
  assert.ok(
    parsed._meta.type_aware.projects.every(
      ({ status }) => status === 'complete',
    ),
    'semantic companion did not report complete project metadata',
  );
});

void test('required complete semantic analysis rejects an unavailable project', (t) => {
  const root = createFixture(t, 'fallow-incomplete', {
    ...baseTypeScriptFixture,
    '.fallowrc.json': fallowConfig({
      projects: ['missing-tsconfig.json'],
      rules: { 'unused-exports': 'error' },
    }),
    'src/index.ts': "import './candidate.js'; export const value = 1;",
    'src/candidate.ts': 'export const semanticCandidate = 1;',
  });
  const result = spawnSync(
    fallow,
    [
      '--root',
      root,
      '--config',
      resolve(root, '.fallowrc.json'),
      'dead-code',
      '--no-cache',
      '--fail-on-issues',
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.notEqual(
    result.status,
    0,
    'missing semantic project unexpectedly passed',
  );
  assert.match(
    `${result.stdout}${result.stderr}`,
    /complete|project|tsconfig/i,
  );
});

void test('Fallow rejects files outside zones, missing reasons, and unresolved imports', (t) => {
  const outsideZoneRoot = createFixture(t, 'fallow-outside-zone', {
    ...baseTypeScriptFixture,
    '.fallowrc.json': fallowConfig({
      entry: ['orphan.ts'],
      boundaries: {
        zones: [{ name: 'source', patterns: ['src/**'] }],
        rules: [{ from: 'source', allow: ['source'] }],
        coverage: { requireAllFiles: true },
      },
    }),
    'orphan.ts': 'export const value = 1;',
  });
  const outsideZone = runFallow(outsideZoneRoot, 'dead-code', [
    '--fail-on-issues',
  ]);
  assert.notEqual(
    outsideZone.result.status,
    0,
    'file outside every zone unexpectedly passed',
  );
  assert.ok(outsideZone.parsed.boundary_coverage_violations.length > 0);

  const suppressionRoot = createFixture(t, 'fallow-suppression', {
    ...baseTypeScriptFixture,
    '.fallowrc.json': fallowConfig({
      rules: {
        'unused-exports': 'error',
        'require-suppression-reason': 'error',
      },
    }),
    'src/index.ts': "import { used } from './lib.js'; export { used };",
    'src/lib.ts':
      '// fallow-ignore-next-line unused-exports\nexport const unused = 1;\nexport const used = 2;',
  });
  const suppression = runFallow(suppressionRoot, 'dead-code', [
    '--fail-on-issues',
  ]);
  assert.notEqual(
    suppression.result.status,
    0,
    'reasonless suppression unexpectedly passed',
  );
  assert.match(suppression.report, /suppression|reason/i);

  const unresolvedRoot = createFixture(t, 'fallow-unresolved', {
    ...baseTypeScriptFixture,
    '.fallowrc.json': fallowConfig({
      rules: { 'unresolved-imports': 'error' },
    }),
    'src/index.ts': "export { missing } from './missing.js';",
  });
  const unresolved = runFallow(unresolvedRoot, 'dead-code', [
    '--fail-on-issues',
  ]);
  assert.notEqual(unresolved.result.status, 0, 'unresolved import passed');
  assert.ok(unresolved.parsed.unresolved_imports.length > 0);
});

void test('semantic duplication detects exact and near-miss clones', (t) => {
  /**
   * @param {string} name
   * @param {string} secondBody
   */
  const runCloneFixture = (name, secondBody) => {
    const root = createFixture(t, name, {
      ...baseTypeScriptFixture,
      '.fallowrc.json': fallowConfig({
        entry: ['src/first.ts', 'src/second.ts'],
        duplicates: {
          mode: 'semantic',
          near: true,
          minTokens: 8,
          minLines: 3,
          threshold: 0.1,
        },
      }),
      'src/first.ts':
        'export function summarize(values: number[]) {\n  const positive = values.filter((value) => value > 0);\n  const sorted = [...positive].sort((left, right) => left - right);\n  const total = sorted.reduce((sum, value) => sum + value, 0);\n  const count = Math.max(sorted.length, 1);\n  const average = total / count;\n  const minimum = sorted[0] ?? 0;\n  const maximum = sorted.at(-1) ?? 0;\n  return { average, count, maximum, minimum, total };\n}',
      'src/second.ts': secondBody,
    });
    const result = runFallow(root, 'dupes', ['--fail-on-issues']);
    assert.notEqual(
      result.result.status,
      0,
      `${name} clone unexpectedly passed: ${result.report}`,
    );
    assert.ok(
      result.parsed.clone_groups.length > 0,
      `${name} clone missing: ${result.report}`,
    );
  };

  runCloneFixture(
    'fallow-semantic-clone',
    'export function summarize(values: number[]) {\n  const positive = values.filter((value) => value > 0);\n  const sorted = [...positive].sort((left, right) => left - right);\n  const total = sorted.reduce((sum, value) => sum + value, 0);\n  const count = Math.max(sorted.length, 1);\n  const average = total / count;\n  const minimum = sorted[0] ?? 0;\n  const maximum = sorted.at(-1) ?? 0;\n  return { average, count, maximum, minimum, total };\n}',
  );
  runCloneFixture(
    'fallow-near-clone',
    'export function summarize(values: number[]) {\n  const positive = values.filter((value) => value >= 0);\n  const sorted = [...positive].sort((left, right) => right - left);\n  const total = sorted.reduce((sum, value) => sum + value, 0);\n  const count = Math.max(sorted.length, 1);\n  const average = total / count;\n  const minimum = sorted.at(-1) ?? 0;\n  const maximum = sorted[0] ?? 0;\n  return { average, count, maximum, minimum, total };\n}',
  );
});

/** @param {string[]} identities @returns {Record<string, FindingCategories>} */
const aggregateFixtureCounts = (identities) => {
  /** @type {Record<string, FindingCategories>} */
  const counts = {};
  for (const identity of identities) {
    const path = identity.replace('\\u0000', '\0').split('\0')[0];
    if (path === undefined) throw new Error('Invalid fixture identity');
    counts[path] = { complexity_high: { count: 1 } };
  }
  return counts;
};

/**
 * @param {PolicyFixtureOptions} [options]
 * @returns {Record<string, string>}
 */
const policyStateFiles = ({
  identities = ['src/index.ts\\u0000work'],
  fingerprints = ['dup:stable:2'],
  statements = 80,
} = {}) => ({
  '.fallow-baselines/policy.json': JSON.stringify({
    schemaVersion: 1,
    bootstrap: 'strict-fallow-quality-gate-2026-09-04',
  }),
  '.fallow-baselines/health.json': JSON.stringify({
    finding_counts: aggregateFixtureCounts(identities),
    identity_finding_counts: Object.fromEntries(
      identities.map((identity) => [
        identity.replace('\\u0000', '\0'),
        { complexity_high: { count: 1 } },
      ]),
    ),
  }),
  '.fallow-baselines/dupes.json': JSON.stringify({
    normalized_clone_fingerprints: fingerprints,
  }),
  '.fallowrc.jsonc': JSON.stringify({
    ignorePatterns: ['dist/**'],
    health: { ignore: ['**/*.test.ts'] },
    duplicates: { ignore: ['vendor/**'] },
  }),
  'coverage-policy.json': JSON.stringify({
    include: ['src/**'],
    exclude: ['**/*.test.ts'],
    thresholds: {
      'src/**': { statements, branches: 70, functions: 75, lines: 80 },
    },
  }),
});

/**
 * @param {string} base
 * @param {string} current
 */
const runPolicyComparison = (base, current) =>
  spawnSync(
    process.execPath,
    [baselinePolicy, '--compare-directories', base, current],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

void test('baseline policy rejects growth and lower floors but permits shrinkage', (t) => {
  const base = createFixture(t, 'policy-base', policyStateFiles());
  const growth = createFixture(
    t,
    'policy-growth',
    policyStateFiles({
      identities: ['src/index.ts\\u0000work', 'src/new.ts\\u0000newWork'],
      fingerprints: ['dup:stable:2', 'dup:new:2'],
    }),
  );
  const growthResult = runPolicyComparison(base, growth);
  assert.notEqual(
    growthResult.status,
    0,
    'baseline growth unexpectedly passed',
  );
  assert.match(
    `${growthResult.stdout}${growthResult.stderr}`,
    /added identity/,
  );
  assert.match(`${growthResult.stdout}${growthResult.stderr}`, /fingerprint/);

  const lowerFloor = createFixture(
    t,
    'policy-lower-floor',
    policyStateFiles({ statements: 79 }),
  );
  const lowerResult = runPolicyComparison(base, lowerFloor);
  assert.notEqual(
    lowerResult.status,
    0,
    'lower coverage floor unexpectedly passed',
  );
  assert.match(
    `${lowerResult.stdout}${lowerResult.stderr}`,
    /coverage floor reduced/,
  );

  const shrink = createFixture(
    t,
    'policy-shrink',
    policyStateFiles({ identities: [], fingerprints: [], statements: 81 }),
  );
  const shrinkResult = runPolicyComparison(base, shrink);
  assert.equal(
    shrinkResult.status,
    0,
    `${shrinkResult.stdout}${shrinkResult.stderr}`,
  );
});

void test('baseline policy rejects missing coverage metrics', (t) => {
  const base = createFixture(t, 'policy-metric-base', policyStateFiles());
  const currentFiles = policyStateFiles();
  const coverageSource = currentFiles['coverage-policy.json'];
  if (coverageSource === undefined) throw new Error('Missing coverage policy');
  const coverage =
    /** @type {{ thresholds: Record<string, Partial<Record<'branches' | 'functions' | 'lines' | 'statements', number>>> }} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this fixture intentionally removes a field from a known policy shape
      JSON.parse(coverageSource)
    );
  const sourceFloors = coverage.thresholds['src/**'];
  assert.notEqual(sourceFloors, undefined);
  if (sourceFloors !== undefined) delete sourceFloors.branches;
  currentFiles['coverage-policy.json'] = JSON.stringify(coverage);
  const current = createFixture(t, 'policy-metric-current', currentFiles);

  const result = runPolicyComparison(base, current);

  assert.notEqual(
    result.status,
    0,
    'missing coverage metric unexpectedly passed',
  );
  assert.match(
    `${result.stdout}${result.stderr}`,
    /coverage floor is invalid for src\/\*\* branches/,
  );
});

void test('bootstrap still protects compatible baseline state', (t) => {
  const baseFiles = policyStateFiles();
  delete baseFiles['.fallow-baselines/policy.json'];
  const base = createFixture(t, 'policy-bootstrap-base', baseFiles);
  const current = createFixture(
    t,
    'policy-bootstrap-current',
    policyStateFiles({
      identities: ['src/index.ts\\u0000work', 'src/new.ts\\u0000newWork'],
      fingerprints: ['dup:stable:2', 'dup:new:2'],
    }),
  );

  const result = runPolicyComparison(base, current);

  assert.notEqual(
    result.status,
    0,
    'bootstrap baseline growth unexpectedly passed',
  );
  assert.match(`${result.stdout}${result.stderr}`, /added identity/);
  assert.match(`${result.stdout}${result.stderr}`, /fingerprint/);
});

void test('bootstrap protects each independently compatible policy subsystem', (t) => {
  const baseFiles = policyStateFiles();
  delete baseFiles['.fallow-baselines/policy.json'];
  baseFiles['.fallow-baselines/health.json'] = JSON.stringify({
    finding_counts: { complexity_high: 1 },
  });
  const base = createFixture(t, 'policy-independent-base', baseFiles);
  const current = createFixture(
    t,
    'policy-independent-current',
    policyStateFiles({
      fingerprints: ['dup:stable:2', 'dup:new:2'],
      statements: 79,
    }),
  );

  const result = runPolicyComparison(base, current);
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(
    result.status,
    0,
    'compatible policy growth unexpectedly passed',
  );
  assert.match(output, /fingerprint/);
  assert.match(output, /coverage floor reduced/);
});

void test('bootstrap preserves compatible legacy health totals', (t) => {
  const baseFiles = policyStateFiles();
  delete baseFiles['.fallow-baselines/policy.json'];
  const baseHealthSource = baseFiles['.fallow-baselines/health.json'];
  if (baseHealthSource === undefined)
    throw new Error('Missing health baseline');
  const baseHealth = /** @type {{ finding_counts: unknown }} */ (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fixture deliberately projects the generated aggregate section into a legacy baseline
    JSON.parse(baseHealthSource)
  );
  baseFiles['.fallow-baselines/health.json'] = JSON.stringify({
    finding_counts: baseHealth.finding_counts,
  });
  const base = createFixture(t, 'policy-legacy-health-base', baseFiles);
  const current = createFixture(
    t,
    'policy-legacy-health-current',
    policyStateFiles({
      identities: ['src/index.ts\\u0000work', 'src/new.ts\\u0000newWork'],
    }),
  );

  const result = runPolicyComparison(base, current);

  assert.notEqual(result.status, 0, 'legacy health growth unexpectedly passed');
  assert.match(
    `${result.stdout}${result.stderr}`,
    /legacy health baseline increased/,
  );
});

void test('baseline policy module is import-safe', () => {
  assert.equal(typeof compareBaselineStates, 'function');
});

void test('Fallow coverage validation rejects nonnumeric match counts', (t) => {
  const validator = resolve(
    repositoryRoot,
    'tools/quality-gate/check-fallow-coverage.mjs',
  );
  for (const field of ['istanbul_matched', 'istanbul_files_matched']) {
    const root = createFixture(t, `fallow-coverage-${field}`, {
      'report.json': JSON.stringify({
        findings: [],
        kind: 'health',
        summary: {
          baseline_staleness: { stale_entries: 0 },
          coverage_model: 'istanbul',
          istanbul_files_matched: 2,
          istanbul_matched: 10,
          [field]: 'invalid',
        },
      }),
    });
    const result = spawnSync(
      process.execPath,
      [validator, resolve(root, 'report.json')],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0, `${field} unexpectedly passed`);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /Fallow did not consume Istanbul coverage/,
    );
  }
});

void test('Fallow coverage validation accepts an audit with no functions', (t) => {
  const validator = resolve(
    repositoryRoot,
    'tools/quality-gate/check-fallow-coverage.mjs',
  );
  const root = createFixture(t, 'fallow-coverage-empty-audit', {
    'report.json': JSON.stringify({ kind: 'audit', findings: [] }),
  });
  const result = spawnSync(
    process.execPath,
    [validator, resolve(root, 'report.json')],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /no analyzable functions/);
});

void test('coverage policy rejects missing maps, empty globs, and zero floors', () => {
  const policy = {
    include: ['src/**/*.ts', 'renamed/**/*.ts'],
    exclude: ['**/*.test.ts'],
    thresholds: {
      'src/**': { branches: 0, functions: 0, lines: 0, statements: 0 },
      'removed/**': { branches: 50, functions: 50, lines: 50, statements: 50 },
    },
  };
  const errors = getCoveragePolicyErrors(
    policy,
    ['src/index.ts', 'src/worker.ts'],
    ['src/index.ts'],
  );

  assert.ok(errors.some((error) => error.includes('renamed/**/*.ts')));
  assert.ok(errors.some((error) => error.includes('src/worker.ts')));
  assert.ok(errors.some((error) => error.includes('removed/**')));
  assert.equal(
    errors.filter((error) => error.includes('threshold must be positive'))
      .length,
    4,
  );
});

void test('JSONC parsing preserves strings and supports both comment forms', () => {
  assert.deepEqual(
    parseJsonc(`{
      // Keep commas and brackets inside quoted values.
      "value": ", }",
      /* Block comments are valid JSONC. */
      "items": ["x,]",],
    }`),
    { items: ['x,]'], value: ', }' },
  );
  assert.throws(
    () => parseJsonc('{ /* unterminated'),
    /Unterminated JSONC block comment/,
  );
});

void test('the implicit audit base resolves to the target branch', () => {
  const { base, mergeBase } = resolveAuditBase(undefined);
  assert.ok(base === 'origin/main' || base === 'main', base);
  assert.notEqual(mergeBase, '');
});

void test('scripts encode the complete gate and cannot casually bless debt', () => {
  const packageJson = /** @type {{ scripts: Record<string, string> }} */ (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the repository manifest is version-controlled and every consumed script key is asserted below
    JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
  );
  const scripts = packageJson.scripts;
  /** @param {string} name */
  const requireScript = (name) => {
    const script = scripts[name];
    if (script === undefined)
      throw new Error(`Missing package script: ${name}`);
    return script;
  };
  const check = requireScript('check');
  const coverageIndex = check.indexOf('test:coverage');
  const fallowIndex = check.indexOf('check:fallow');
  assert.ok(coverageIndex >= 0, 'check script must run test:coverage');
  assert.ok(fallowIndex >= 0, 'check script must run check:fallow');
  assert.ok(coverageIndex < fallowIndex);
  assert.match(requireScript('check:fallow'), /dead-code.*health.*dupes/);
  assert.equal(
    Object.values(scripts).some((script) =>
      script.includes(['best', 'effort'].join('-')),
    ),
    false,
  );
  assert.equal('check:fallow:private-types' in scripts, false);
  assert.equal('check:fallow:baselines:update' in scripts, false);
  assert.match(requireScript('check:fallow:baselines:preview'), /preview/);

  const auditScript = readFileSync(
    resolve(repositoryRoot, 'tools/quality-gate/run-fallow-audit.mjs'),
    'utf8',
  );
  assert.doesNotMatch(auditScript, /health-baseline/);
  assert.match(auditScript, /dupes-baseline/);
  assert.match(auditScript, /changed-since/);
  assert.match(auditScript, /type-aware-require/);
  assert.match(auditScript, /complete/);
  assert.match(auditScript, /Fallow audit failed/);
  assert.match(auditScript, /runPnpm/);
  assert.doesNotMatch(auditScript, /run\('pnpm'/);

  const previewScript = readFileSync(
    resolve(repositoryRoot, 'tools/quality-gate/preview-fallow-baselines.mjs'),
    'utf8',
  );
  assert.match(previewScript, /\.fallow-preview/);
  assert.match(previewScript, /'--complexity'/);
  assert.match(previewScript, /'--score'/);
  assert.doesNotMatch(previewScript, /\.fallow-baselines\/health\.json/);
  assert.match(previewScript, /runPnpm/);
  assert.doesNotMatch(previewScript, /run\('pnpm'/);
  assert.ok(
    getTrackedCoverageInputs().includes('tools/vitest-config/base.mjs'),
    'shared Vitest config must invalidate stale coverage',
  );
  const vitestConfig = readFileSync(
    resolve(repositoryRoot, 'vitest.config.mts'),
    'utf8',
  );
  assert.match(vitestConfig, /packages\/\*\/vitest\.config\.mts/);
  assert.match(vitestConfig, /examples\/\*\/vitest\.config\.mts/);

  const config = /** @type {OxlintContractConfig} */ (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the production config is schema-validated by Oxlint and the consumed fields are asserted below
    parseJsonc(readFileSync(resolve(repositoryRoot, '.oxlintrc.json'), 'utf8'))
  );
  assert.equal(config.categories.suspicious, 'error');
  assert.equal(config.rules['typescript/no-unnecessary-condition'], 'error');
  assert.equal(config.rules['react/refs'], 'error');
  assert.equal(
    config.overrides.some(
      (override) =>
        override.rules?.['typescript/no-unnecessary-condition'] === 'off' ||
        override.rules?.['react/refs'] === 'off',
    ),
    false,
  );
});

/** @typedef {{ entry?: string[], projects?: string[], rules?: Record<string, string>, boundaries?: unknown, duplicates?: unknown }} FallowFixtureConfig */
/** @typedef {{ count: number }} CountEntry */
/** @typedef {Record<string, CountEntry>} FindingCategories */
/** @typedef {{ private_type_leaks: unknown[], boundary_coverage_violations: unknown[], unresolved_imports: unknown[], clone_groups: unknown[], _meta: { type_aware: { executed: boolean, projects: { status: string }[] } } }} FallowFixtureReport */
/** @typedef {{ config?: string, cwd?: string }} OxlintRunOptions */
/** @typedef {{ identities?: string[], fingerprints?: string[], statements?: number }} PolicyFixtureOptions */
/** @typedef {{ categories: { suspicious: string }, rules: Record<string, string>, overrides: { rules?: Record<string, string> }[] }} OxlintContractConfig */
