import { resolve } from 'node:path';

import { readJson } from './quality-gate-utils.mjs';

const reportPath = process.argv[2];
if (reportPath === undefined || reportPath === '')
  throw new Error('Pass the Fallow JSON report path to validate.');

const report =
  /** @type {{ kind?: string, findings?: unknown[], summary?: HealthSummary, complexity?: { summary?: HealthSummary } }} */ (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the validator checks every health-summary field used by the gate immediately below
    readJson(resolve(reportPath))
  );
const summary =
  report.kind === 'audit' ? report.complexity?.summary : report.summary;
if (summary === undefined)
  throw new Error('Fallow report has no health summary.');

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isPositiveSafeInteger = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const matched = summary.istanbul_matched;
const matchedFiles = summary.istanbul_files_matched;
const model = summary.coverage_model;
const consistency = summary.coverage_source_consistency;

if (
  !isPositiveSafeInteger(matched) ||
  !isPositiveSafeInteger(matchedFiles) ||
  model === 'static_estimated' ||
  consistency === 'static_estimated'
) {
  throw new Error(
    'Fallow did not consume Istanbul coverage; refusing a static-estimated health result.',
  );
}

if (report.kind !== 'audit' && model !== 'istanbul') {
  throw new Error(
    `Expected Istanbul health coverage, received ${String(model)}.`,
  );
}

if (report.kind !== 'audit') {
  if ((report.findings?.length ?? 0) > 0) {
    throw new Error(
      `Fallow health reported ${String(report.findings?.length)} findings outside the baseline.`,
    );
  }
  const staleEntries = summary.baseline_staleness?.stale_entries ?? 0;
  if (staleEntries > 0) {
    throw new Error(
      `Fallow health baseline contains ${String(staleEntries)} stale entries.`,
    );
  }
}

console.log(
  `Fallow coverage verified: ${matched} functions across ${matchedFiles} files matched Istanbul data.`,
);

/**
 * @typedef {object} HealthSummary
 * @property {string} [coverage_model]
 * @property {string} [coverage_source_consistency]
 * @property {unknown} [istanbul_matched]
 * @property {unknown} [istanbul_files_matched]
 * @property {{ stale_entries?: number }} [baseline_staleness]
 */
