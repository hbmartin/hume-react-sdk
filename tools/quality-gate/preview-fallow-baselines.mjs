import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateCoverageMap } from './check-coverage-map.mjs';
import { repositoryRoot, run } from './quality-gate-utils.mjs';

validateCoverageMap();
const previewDirectory = resolve(repositoryRoot, '.fallow-preview');
mkdirSync(previewDirectory, { recursive: true });

const health = run('pnpm', [
  'exec',
  'fallow',
  'health',
  '--no-cache',
  '--coverage',
  'coverage/coverage-final.json',
  '--baseline-mode',
  'identity',
  '--save-baseline',
  '.fallow-preview/health.candidate.json',
  '--report-only',
  '--format',
  'json',
  '--output-file',
  '.fallow-preview/health.report.json',
]);
const dupes = run('pnpm', [
  'exec',
  'fallow',
  'dupes',
  '--no-cache',
  '--save-baseline',
  '.fallow-preview/dupes.candidate.json',
  '--format',
  'json',
  '--output-file',
  '.fallow-preview/dupes.report.json',
]);

if (health.status !== 0 || dupes.status !== 0) {
  process.exitCode = 1;
} else {
  console.log('Baseline candidates written under .fallow-preview/ for review.');
}
