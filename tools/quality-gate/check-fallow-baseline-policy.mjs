import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseJsonc,
  repositoryRoot,
  resolveAuditBase,
  run,
} from './quality-gate-utils.mjs';

const protectedPaths = [
  '.fallow-baselines/policy.json',
  '.fallow-baselines/health.json',
  '.fallow-baselines/dupes.json',
  '.fallowrc.jsonc',
  'coverage-policy.json',
];

/**
 * @param {string} directory
 * @param {string} path
 */
const readDirectoryFile = (directory, path) => {
  try {
    return readFileSync(resolve(directory, path), 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
};

/**
 * @param {string} revision
 * @param {string} path
 */
const readGitFile = (revision, path) => {
  const result = run('git', ['show', `${revision}:${path}`], { capture: true });
  return result.status === 0 ? result.stdout : null;
};

/** @param {(path: string) => string | null} readFile */
const readState = (readFile) => {
  const sources = Object.fromEntries(
    protectedPaths.map((path) => [path, readFile(path)]),
  );
  /**
   * @param {string} path
   * @param {(source: string) => unknown} [parser]
   */
  const parse = (path, parser = JSON.parse) => {
    const source = sources[path];
    return source === null || source === undefined ? null : parser(source);
  };
  return {
    coverage: /** @type {CoveragePolicy | null} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- protected policy JSON is schema-checked through every required field during comparison
      parse('coverage-policy.json')
    ),
    dupes: /** @type {DupesBaseline | null} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- protected baseline JSON is validated before counts are compared
      parse('.fallow-baselines/dupes.json')
    ),
    fallow: /** @type {FallowConfig | null} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- protected config JSONC is validated before ignore lists are compared
      parse('.fallowrc.jsonc', parseJsonc)
    ),
    health: /** @type {HealthBaseline | null} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- protected baseline JSON is validated before identity counts are compared
      parse('.fallow-baselines/health.json')
    ),
    marker: /** @type {PolicyMarker | null} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the marker version and exact bootstrap identity are checked before use
      parse('.fallow-baselines/policy.json')
    ),
  };
};

/** @param {string} directory */
const readDirectoryState = (directory) =>
  readState((path) => readDirectoryFile(directory, path));

/** @param {string} revision */
const readGitState = (revision) =>
  readState((path) => readGitFile(revision, path));

/**
 * @param {string[]} current
 * @param {string[]} base
 * @param {string} label
 * @param {string[]} errors
 */
const assertSubset = (current, base, label, errors) => {
  for (const value of current) {
    if (!base.includes(value))
      errors.push(`${label} added protected value: ${value}`);
  }
};

/**
 * @param {string} message
 * @param {string[]} errors
 */
const reportMissingPolicy = (message, errors) => {
  errors.push(message);
};

/**
 * @param {HealthBaseline | null} base
 * @param {HealthBaseline | null} current
 * @param {string[]} errors
 */
const compareHealth = (base, current, errors) => {
  const currentCounts = current?.identity_finding_counts;
  if (currentCounts === undefined) {
    reportMissingPolicy('health baseline must use identity mode', errors);
  } else {
    for (const [identity, categories] of Object.entries(currentCounts)) {
      const baseCategories = base?.identity_finding_counts?.[identity];
      if (baseCategories === undefined) {
        errors.push(
          `health baseline added identity: ${identity.replace('\0', ':')}`,
        );
      } else {
        for (const [category, value] of Object.entries(categories)) {
          const baseCount = baseCategories[category]?.count ?? 0;
          if (value.count > baseCount) {
            errors.push(
              `health baseline increased ${identity.replace('\0', ':')} ${category}: ${baseCount} -> ${value.count}`,
            );
          }
        }
      }
    }
  }
};

/**
 * @param {CoveragePolicy | null} base
 * @param {CoveragePolicy | null} current
 * @param {string[]} errors
 */
const compareCoverage = (base, current, errors) => {
  if (!base || !current) {
    reportMissingPolicy('coverage policy is missing', errors);
    return;
  }
  for (const [workspace, floors] of Object.entries(current.thresholds)) {
    const baseFloors = base.thresholds[workspace];
    if (!baseFloors) {
      errors.push(
        `coverage thresholds added a workspace without prior policy: ${workspace}`,
      );
      continue;
    }
    for (const metric of /** @type {(keyof CoverageFloors)[]} */ ([
      'statements',
      'branches',
      'functions',
      'lines',
    ])) {
      if (floors[metric] < baseFloors[metric]) {
        errors.push(
          `coverage floor reduced for ${workspace} ${metric}: ${baseFloors[metric]} -> ${floors[metric]}`,
        );
      }
    }
  }
  for (const workspace of Object.keys(base.thresholds)) {
    if (!(workspace in current.thresholds)) {
      errors.push(`coverage thresholds removed workspace: ${workspace}`);
    }
  }
  assertSubset(base.include, current.include, 'coverage include', errors);
  assertSubset(current.exclude, base.exclude, 'coverage exclusion', errors);
};

/**
 * @param {FallowConfig | null} base
 * @param {FallowConfig | null} current
 * @param {string[]} errors
 */
const compareFallowIgnores = (base, current, errors) => {
  if (!base || !current) {
    errors.push('Fallow config is missing');
    return;
  }
  assertSubset(
    current.ignorePatterns ?? [],
    base.ignorePatterns ?? [],
    'Fallow ignore pattern',
    errors,
  );
  assertSubset(
    current.health?.ignore ?? [],
    base.health?.ignore ?? [],
    'health ignore pattern',
    errors,
  );
  assertSubset(
    current.duplicates?.ignore ?? [],
    base.duplicates?.ignore ?? [],
    'duplicate ignore pattern',
    errors,
  );
};

/**
 * @param {BaselineState} base
 * @param {BaselineState} current
 */
export const compareBaselineStates = (base, current) => {
  const errors = [];
  if (!current.marker || current.marker.schemaVersion !== 1) {
    errors.push('missing strict-gate bootstrap marker version 1');
    return errors;
  }

  if (!base.marker) {
    if (current.marker.bootstrap !== 'strict-fallow-quality-gate-2026-09-04') {
      errors.push('unexpected strict-gate bootstrap marker');
    }
    if (!current.health?.identity_finding_counts) {
      errors.push('bootstrap health baseline must use identity mode');
    }
    return errors;
  }

  if (JSON.stringify(current.marker) !== JSON.stringify(base.marker)) {
    errors.push('baseline bootstrap marker changed after migration');
  }
  compareHealth(base.health, current.health, errors);

  const baseFingerprints = base.dupes?.normalized_clone_fingerprints ?? [];
  const currentFingerprints =
    current.dupes?.normalized_clone_fingerprints ?? [];
  assertSubset(
    currentFingerprints,
    baseFingerprints,
    'duplicate baseline fingerprint',
    errors,
  );
  compareCoverage(base.coverage, current.coverage, errors);
  compareFallowIgnores(base.fallow, current.fallow, errors);
  return errors;
};

const compareDirectoriesIndex = process.argv.indexOf('--compare-directories');
let baseState;
let currentState;
let comparisonLabel;

if (compareDirectoriesIndex !== -1) {
  const baseDirectory = process.argv[compareDirectoriesIndex + 1];
  const currentDirectory = process.argv[compareDirectoriesIndex + 2];
  if (
    baseDirectory === undefined ||
    baseDirectory === '' ||
    currentDirectory === undefined ||
    currentDirectory === ''
  ) {
    throw new Error(
      '--compare-directories requires BASE and CURRENT directories.',
    );
  }
  baseState = readDirectoryState(baseDirectory);
  currentState = readDirectoryState(currentDirectory);
  comparisonLabel = baseDirectory;
} else {
  const explicitBase = process.argv[2];
  const { base, mergeBase } = resolveAuditBase(explicitBase);
  baseState = readGitState(mergeBase);
  currentState = readDirectoryState(repositoryRoot);
  comparisonLabel = `${mergeBase} (${base})`;
}

const errors = compareBaselineStates(baseState, currentState);
if (errors.length > 0) {
  console.error(`Baseline policy rejected changes against ${comparisonLabel}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Baseline policy passed against ${comparisonLabel}.`);
}

/** @typedef {{ count: number }} CountEntry */
/** @typedef {Record<string, CountEntry>} FindingCategories */
/** @typedef {{ identity_finding_counts?: Record<string, FindingCategories> }} HealthBaseline */
/** @typedef {{ normalized_clone_fingerprints?: string[] }} DupesBaseline */
/** @typedef {{ statements: number, branches: number, functions: number, lines: number }} CoverageFloors */
/** @typedef {{ include: string[], exclude: string[], thresholds: Record<string, CoverageFloors> }} CoveragePolicy */
/** @typedef {{ ignorePatterns?: string[], health?: { ignore?: string[] }, duplicates?: { ignore?: string[] } }} FallowConfig */
/** @typedef {{ schemaVersion: number, bootstrap?: string }} PolicyMarker */
/** @typedef {{ coverage: CoveragePolicy | null, dupes: DupesBaseline | null, fallow: FallowConfig | null, health: HealthBaseline | null, marker: PolicyMarker | null }} BaselineState */
