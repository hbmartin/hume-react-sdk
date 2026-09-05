import { resolve } from 'node:path';

import { readJson } from './quality-gate-utils.mjs';

const reportPath = process.argv[2];
if (reportPath === undefined || reportPath === '')
  throw new Error('Pass the Fallow JSON report path to validate.');

const report = /** @type {FallowReport} */ (
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the validator checks every health-summary field used by the gate immediately below
  readJson(resolve(reportPath))
);
const summary =
  report.kind === 'audit' ? report.complexity?.summary : report.summary;

/** @param {unknown[] | undefined} findings */
const hasNoFindings = (findings) =>
  findings === undefined || (Array.isArray(findings) && findings.length === 0);

const emptyAuditSummaryFields = {
  complexity_findings: 0,
  dead_code_has_errors: false,
  dead_code_issues: 0,
  duplication_clone_groups: 0,
  max_cyclomatic: null,
};
const emptyAuditAttributionFields = {
  complexity_inherited: 0,
  complexity_introduced: 0,
  dead_code_inherited: 0,
  dead_code_introduced: 0,
  duplication_demoted: 0,
  duplication_inherited: 0,
  duplication_introduced: 0,
  gate: 'new-only',
  styling_inherited: 0,
  styling_introduced: 0,
};

/**
 * @param {unknown} candidate
 * @param {Record<string, unknown>} expectedFields
 */
const hasExpectedFields = (candidate, expectedFields) => {
  if (typeof candidate !== 'object' || candidate === null) return false;
  return Object.entries(expectedFields).every(
    ([key, value]) => Reflect.get(candidate, key) === value,
  );
};

/** @param {unknown} value */
const isNonNegativeSafeInteger = (value) => {
  const number = typeof value === 'number' ? value : Number.NaN;
  return [Number.isSafeInteger(number), number >= 0].every(Boolean);
};

/** @param {FallowReport} candidate */
const hasEmptyAuditHeader = (candidate) =>
  [
    candidate.kind === 'audit',
    candidate.verdict === 'pass',
    isNonNegativeSafeInteger(candidate.changed_files_count),
  ].every(Boolean);

/** @param {FallowReport} candidate */
const hasNoAuditAnalysis = (candidate) =>
  [
    candidate.complexity === undefined,
    candidate.dead_code === undefined,
    candidate.duplication === undefined,
    hasNoFindings(candidate.findings),
    hasNoFindings(candidate.complexity?.findings),
  ].every(Boolean);

/** @param {FallowReport} candidate */
const isExplicitEmptyAudit = (candidate) =>
  [
    hasEmptyAuditHeader(candidate),
    hasExpectedFields(candidate.summary, emptyAuditSummaryFields),
    hasNoAuditAnalysis(candidate),
    hasExpectedFields(candidate.attribution, emptyAuditAttributionFields),
  ].every(Boolean);

const coverageSummaries = [report.summary, report.complexity?.summary].filter(
  (candidate) => candidate !== undefined,
);
if (
  coverageSummaries.some(
    (candidate) =>
      candidate.coverage_model === 'static_estimated' ||
      candidate.coverage_source_consistency === 'static_estimated',
  )
) {
  throw new Error(
    'Fallow did not consume Istanbul coverage; refusing a static-estimated health result.',
  );
}

const emptyAudit = isExplicitEmptyAudit(report);
if (emptyAudit) {
  console.log(
    'Fallow audit contains no analyzable functions; Istanbul matching is not applicable.',
  );
}
if (!emptyAudit && summary === undefined)
  throw new Error('Fallow report has no health summary.');

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isPositiveSafeInteger = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const matched = summary?.istanbul_matched;
const matchedFiles = summary?.istanbul_files_matched;
const model = summary?.coverage_model;

if (
  !emptyAudit &&
  (!isPositiveSafeInteger(matched) || !isPositiveSafeInteger(matchedFiles))
) {
  throw new Error(
    'Fallow did not consume Istanbul coverage; refusing a static-estimated health result.',
  );
}

if (!emptyAudit && report.kind !== 'audit' && model !== 'istanbul') {
  throw new Error(
    `Expected Istanbul health coverage, received ${String(model)}.`,
  );
}

if (!emptyAudit && report.kind !== 'audit') {
  if ((report.findings?.length ?? 0) > 0) {
    throw new Error(
      `Fallow health reported ${String(report.findings?.length)} findings outside the baseline.`,
    );
  }
  const staleEntries = summary?.baseline_staleness?.stale_entries ?? 0;
  if (staleEntries > 0) {
    throw new Error(
      `Fallow health baseline contains ${String(staleEntries)} stale entries.`,
    );
  }
}

if (!emptyAudit) {
  console.log(
    `Fallow coverage verified: ${String(matched)} functions across ${String(matchedFiles)} files matched Istanbul data.`,
  );
}

/**
 * @typedef {object} HealthSummary
 * @property {string} [coverage_model]
 * @property {string} [coverage_source_consistency]
 * @property {unknown} [istanbul_matched]
 * @property {unknown} [istanbul_files_matched]
 * @property {{ stale_entries?: number }} [baseline_staleness]
 * @property {number} [dead_code_issues]
 * @property {boolean} [dead_code_has_errors]
 * @property {number} [complexity_findings]
 * @property {number | null} [max_cyclomatic]
 * @property {number} [duplication_clone_groups]
 */

/**
 * @typedef {object} AuditAttribution
 * @property {string} [gate]
 * @property {number} [dead_code_introduced]
 * @property {number} [dead_code_inherited]
 * @property {number} [complexity_introduced]
 * @property {number} [complexity_inherited]
 * @property {number} [duplication_introduced]
 * @property {number} [duplication_inherited]
 * @property {number} [styling_introduced]
 * @property {number} [styling_inherited]
 * @property {number} [duplication_demoted]
 */

/**
 * @typedef {object} FallowReport
 * @property {string} [kind]
 * @property {string} [verdict]
 * @property {number} [changed_files_count]
 * @property {unknown[]} [findings]
 * @property {HealthSummary} [summary]
 * @property {{ summary?: HealthSummary, findings?: unknown[] }} [complexity]
 * @property {unknown} [dead_code]
 * @property {unknown} [duplication]
 * @property {AuditAttribution} [attribution]
 */
