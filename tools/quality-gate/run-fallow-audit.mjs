import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateCoverageMap } from './check-coverage-map.mjs';
import {
  repositoryRoot,
  resolveAuditBase,
  run,
} from './quality-gate-utils.mjs';

const { base, mergeBase } = resolveAuditBase(process.argv[2]);
const reportsDirectory = resolve(repositoryRoot, 'coverage');
const reportPath = resolve(reportsDirectory, 'fallow-audit.json');
mkdirSync(reportsDirectory, { recursive: true });
validateCoverageMap();

console.log('Verifying complete type-aware dead-code analysis before audit.');
const semanticCheck = run('pnpm', [
  'exec',
  'fallow',
  'dead-code',
  '--no-cache',
  '--type-aware',
  '--type-aware-require',
  'complete',
  '--fail-on-issues',
]);

console.log(`Running the PR audit from merge base ${mergeBase} (${base}).`);
const audit = run('pnpm', [
  'exec',
  'fallow',
  'audit',
  '--no-cache',
  '--gate',
  'new-only',
  '--dupes-baseline',
  '.fallow-baselines/dupes.json',
  '--coverage',
  'coverage/coverage-final.json',
  '--no-type-aware',
  '--changed-since',
  mergeBase,
  '--format',
  'json',
  '--output-file',
  reportPath,
]);

const coverageCheck = run('node', [
  'tools/quality-gate/check-fallow-coverage.mjs',
  reportPath,
]);
if (
  semanticCheck.status !== 0 ||
  audit.status !== 0 ||
  coverageCheck.status !== 0
)
  process.exitCode = 1;
