import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateCoverageMap } from './check-coverage-map.mjs';
import {
  readJson,
  repositoryRoot,
  resolveAuditBase,
  run,
} from './quality-gate-utils.mjs';

/** @typedef {{ path: string, name: string, line: number, severity: string, introduced?: boolean }} AuditComplexityFinding */
/** @typedef {{ file: string, start_line: number }} AuditCloneInstance */
/** @typedef {{ fingerprint: string, introduced?: boolean, instances: AuditCloneInstance[] }} AuditCloneGroup */
/** @typedef {{ attribution?: { complexity_introduced?: number, duplication_introduced?: number, dead_code_introduced?: number }, complexity?: { findings?: AuditComplexityFinding[] }, duplication?: { clone_groups?: AuditCloneGroup[] } }} AuditReport */

const { base, mergeBase } = resolveAuditBase(process.argv[2]);
const reportsDirectory = resolve(repositoryRoot, 'coverage');
const reportPath = resolve(reportsDirectory, 'fallow-audit.json');
mkdirSync(reportsDirectory, { recursive: true });
validateCoverageMap();

const printAuditFailure = () => {
  const report = /** @type {AuditReport} */ (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the formatter treats every report collection as optional and only reads documented scalar fields
    readJson(reportPath)
  );
  const attribution = report.attribution ?? {};
  console.error(
    `Fallow audit failed: ${attribution.dead_code_introduced ?? 0} dead-code, ${attribution.complexity_introduced ?? 0} complexity, and ${attribution.duplication_introduced ?? 0} duplication regressions introduced.`,
  );
  for (const finding of report.complexity?.findings ?? []) {
    if (finding.introduced !== true) continue;
    console.error(
      `- complexity: ${finding.path}:${finding.line} ${finding.name} (${finding.severity})`,
    );
  }
  for (const group of report.duplication?.clone_groups ?? []) {
    if (group.introduced !== true) continue;
    const locations = group.instances
      .map((instance) => `${instance.file}:${instance.start_line}`)
      .join(', ');
    console.error(`- duplication: ${group.fingerprint} at ${locations}`);
  }
  console.error(`Full JSON report: ${reportPath}`);
};

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
if (audit.status !== 0) {
  if (existsSync(reportPath)) {
    printAuditFailure();
  } else {
    console.error(`Fallow audit failed without writing ${reportPath}.`);
  }
}

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
