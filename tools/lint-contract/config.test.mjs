import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const oxlint = resolve(repositoryRoot, 'node_modules/.bin/oxlint');
const fallow = resolve(repositoryRoot, 'node_modules/.bin/fallow');
const oxlintConfig = resolve(import.meta.dirname, '.oxlintrc.json');

const expectOxlintRule = (fixture, rule) => {
  const result = spawnSync(
    oxlint,
    [
      '--config',
      oxlintConfig,
      '--type-aware',
      '--format',
      'json',
      resolve(import.meta.dirname, 'fixtures/oxlint', fixture),
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0, `${fixture} unexpectedly passed Oxlint`);
  assert.match(`${result.stdout}${result.stderr}`, new RegExp(rule));
};

void test('type-aware Oxlint rejects representative violations', () => {
  expectOxlintRule('floating-promise.ts', 'no-floating-promises');
  expectOxlintRule('focused.test.ts', 'no-focused-tests');
  expectOxlintRule('hook-dependency.tsx', 'exhaustive-deps');
  expectOxlintRule('unsafe-assignment.ts', 'no-unsafe-assignment');
});

void test('Fallow rejects unresolved imports', () => {
  const fixtureRoot = resolve(import.meta.dirname, 'fixtures/unresolved');
  const result = spawnSync(
    fallow,
    [
      '--root',
      fixtureRoot,
      '--config',
      resolve(fixtureRoot, '.fallowrc.json'),
      'dead-code',
      '--unresolved-imports',
      '--fail-on-issues',
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0, 'unresolved import unexpectedly passed');
  assert.match(`${result.stdout}${result.stderr}`, /unresolved import/i);
});
