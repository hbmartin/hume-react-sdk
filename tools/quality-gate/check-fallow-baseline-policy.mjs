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
  const listing = run('git', ['ls-tree', '--name-only', revision, '--', path], {
    capture: true,
  });
  if (listing.status !== 0) {
    throw new Error(`Unable to inspect ${path} at ${revision}.`);
  }
  if (listing.stdout.trim() === '') return null;
  const result = run('git', ['show', `${revision}:${path}`], { capture: true });
  if (result.status !== 0) {
    throw new Error(`Unable to read ${path} at ${revision}.`);
  }
  return result.stdout;
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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
const isStringArray = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * @param {HealthBaseline | null} baseline
 * @param {string} label
 * @param {string[]} errors
 */
const validateHealthBaseline = (baseline, label, errors) => {
  const counts = baseline?.identity_finding_counts;
  if (!isRecord(counts)) {
    errors.push(`${label} health baseline must use identity mode`);
    return false;
  }
  let valid = true;
  for (const [identity, categories] of Object.entries(counts)) {
    if (!isRecord(categories)) {
      errors.push(
        `${label} health identity has invalid categories: ${identity}`,
      );
      valid = false;
      continue;
    }
    for (const [category, value] of Object.entries(categories)) {
      if (
        !isRecord(value) ||
        typeof value['count'] !== 'number' ||
        !Number.isSafeInteger(value['count']) ||
        value['count'] < 0
      ) {
        errors.push(
          `${label} health identity has invalid count: ${identity.replace('\0', ':')} ${category}`,
        );
        valid = false;
      }
    }
  }
  return valid;
};

/**
 * @param {DupesBaseline | null} baseline
 * @param {string} label
 * @param {string[]} errors
 */
const validateDupesBaseline = (baseline, label, errors) => {
  if (!isStringArray(baseline?.normalized_clone_fingerprints)) {
    errors.push(
      `${label} duplicate baseline is missing normalized fingerprints`,
    );
    return false;
  }
  return true;
};

/**
 * @param {FallowConfig | null} config
 * @param {string} label
 * @param {string[]} errors
 */
const validateFallowConfig = (config, label, errors) => {
  if (!isRecord(config)) {
    errors.push(`${label} Fallow config is missing`);
    return false;
  }
  let valid = true;
  if (config.health !== undefined && !isRecord(config.health)) {
    errors.push(`${label} health config must be an object`);
    valid = false;
  }
  if (config.duplicates !== undefined && !isRecord(config.duplicates)) {
    errors.push(`${label} duplicates config must be an object`);
    valid = false;
  }
  const ignoreCollections = /** @type {Array<[string, unknown]>} */ ([
    ['ignorePatterns', config['ignorePatterns']],
    [
      'health.ignore',
      isRecord(config['health']) ? config['health']['ignore'] : undefined,
    ],
    [
      'duplicates.ignore',
      isRecord(config['duplicates'])
        ? config['duplicates']['ignore']
        : undefined,
    ],
  ]);
  for (const [name, value] of ignoreCollections) {
    if (value !== undefined && !isStringArray(value)) {
      errors.push(`${label} ${name} must be an array of strings`);
      valid = false;
    }
  }
  return valid;
};

const coverageMetrics = /** @type {const} */ ([
  'statements',
  'branches',
  'functions',
  'lines',
]);

/**
 * @param {CoveragePolicy | null} policy
 * @param {string} label
 * @param {string[]} errors
 */
const validateCoveragePolicy = (policy, label, errors) => {
  if (!isRecord(policy)) {
    errors.push(`${label} coverage policy is missing`);
    return false;
  }
  let valid = true;
  if (!isStringArray(policy.include)) {
    errors.push(`${label} coverage include must be an array of strings`);
    valid = false;
  }
  if (!isStringArray(policy.exclude)) {
    errors.push(`${label} coverage exclude must be an array of strings`);
    valid = false;
  }
  if (!isRecord(policy.thresholds)) {
    errors.push(`${label} coverage thresholds must be an object`);
    return false;
  }
  for (const [workspace, floors] of Object.entries(policy.thresholds)) {
    if (!isRecord(floors)) {
      errors.push(`${label} coverage floors are invalid for ${workspace}`);
      valid = false;
      continue;
    }
    for (const metric of coverageMetrics) {
      const floor = floors[metric];
      if (
        typeof floor !== 'number' ||
        !Number.isFinite(floor) ||
        floor < 0 ||
        floor > 100
      ) {
        errors.push(
          `${label} coverage floor is invalid for ${workspace} ${metric}`,
        );
        valid = false;
      }
    }
  }
  return valid;
};

/**
 * @template T
 * @param {T | null} base
 * @param {T | null} current
 * @param {(value: T | null, label: string, errors: string[]) => boolean} validate
 * @param {string[]} errors
 * @returns {[T, T] | null}
 */
const getValidatedPair = (base, current, validate, errors) => {
  const baseValid = validate(base, 'base', errors);
  const currentValid = validate(current, 'current', errors);
  return baseValid && currentValid && base !== null && current !== null
    ? [base, current]
    : null;
};

/**
 * @template T
 * @param {T | null} base
 * @param {T | null} current
 * @param {(value: T | null, label: string, errors: string[]) => boolean} validate
 * @param {(base: T, current: T) => Array<{ base: string[], current: string[], label: string }>} getCollections
 * @param {string[]} errors
 */
const compareValidatedStringCollections = (
  base,
  current,
  validate,
  getCollections,
  errors,
) => {
  const pair = getValidatedPair(base, current, validate, errors);
  if (pair === null) return;
  for (const collection of getCollections(...pair)) {
    assertSubset(collection.current, collection.base, collection.label, errors);
  }
};

/**
 * @param {Record<string, FindingCategories>} baseCounts
 * @param {Record<string, FindingCategories>} currentCounts
 * @param {string[]} errors
 */
const compareHealthCounts = (baseCounts, currentCounts, errors) => {
  for (const [identity, categories] of Object.entries(currentCounts)) {
    const baseCategories = baseCounts[identity];
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
};

/**
 * @param {HealthBaseline | null} base
 * @param {HealthBaseline | null} current
 * @param {string[]} errors
 */
const compareHealth = (base, current, errors) => {
  const pair = getValidatedPair(base, current, validateHealthBaseline, errors);
  if (pair === null) return;
  const [validBase, validCurrent] = pair;
  compareHealthCounts(
    validBase.identity_finding_counts ?? {},
    validCurrent.identity_finding_counts ?? {},
    errors,
  );
};

/**
 * @param {DupesBaseline | null} base
 * @param {DupesBaseline | null} current
 * @param {string[]} errors
 */
const compareDupes = (base, current, errors) =>
  compareValidatedStringCollections(
    base,
    current,
    validateDupesBaseline,
    (validBase, validCurrent) => [
      {
        base: validBase.normalized_clone_fingerprints ?? [],
        current: validCurrent.normalized_clone_fingerprints ?? [],
        label: 'duplicate baseline fingerprint',
      },
    ],
    errors,
  );

/**
 * @param {CoveragePolicy} base
 * @param {CoveragePolicy} current
 * @param {string[]} errors
 */
const compareCoverageThresholds = (base, current, errors) => {
  for (const [workspace, floors] of Object.entries(current.thresholds)) {
    const baseFloors = base.thresholds[workspace];
    if (!baseFloors) {
      errors.push(
        `coverage thresholds added a workspace without prior policy: ${workspace}`,
      );
      continue;
    }
    for (const metric of coverageMetrics) {
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
};

/**
 * @param {CoveragePolicy | null} base
 * @param {CoveragePolicy | null} current
 * @param {string[]} errors
 */
const compareCoverage = (base, current, errors) => {
  const pair = getValidatedPair(base, current, validateCoveragePolicy, errors);
  if (pair === null) return;
  const [validBase, validCurrent] = pair;
  compareCoverageThresholds(validBase, validCurrent, errors);
  assertSubset(
    validBase.include,
    validCurrent.include,
    'coverage include',
    errors,
  );
  assertSubset(
    validCurrent.exclude,
    validBase.exclude,
    'coverage exclusion',
    errors,
  );
};

/**
 * @param {FallowConfig | null} base
 * @param {FallowConfig | null} current
 * @param {string[]} errors
 */
const compareFallowIgnores = (base, current, errors) =>
  compareValidatedStringCollections(
    base,
    current,
    validateFallowConfig,
    (validBase, validCurrent) => [
      {
        base: validBase.ignorePatterns ?? [],
        current: validCurrent.ignorePatterns ?? [],
        label: 'Fallow ignore pattern',
      },
      {
        base: validBase.health?.ignore ?? [],
        current: validCurrent.health?.ignore ?? [],
        label: 'health ignore pattern',
      },
      {
        base: validBase.duplicates?.ignore ?? [],
        current: validCurrent.duplicates?.ignore ?? [],
        label: 'duplicate ignore pattern',
      },
    ],
    errors,
  );

/**
 * During the one-time identity-baseline migration, protect ignore collections
 * that already existed while allowing newly introduced analyzer sections to be
 * reviewed as part of the bootstrap marker change.
 *
 * @param {FallowConfig | null} base
 * @param {FallowConfig | null} current
 * @param {string[]} errors
 */
const compareBootstrapFallowIgnores = (base, current, errors) => {
  if (
    !validateFallowConfig(base, 'base', errors) ||
    !validateFallowConfig(current, 'current', errors)
  ) {
    return;
  }
  if (!base || !current) return;
  if (base.ignorePatterns !== undefined) {
    assertSubset(
      current.ignorePatterns ?? [],
      base.ignorePatterns,
      'Fallow ignore pattern',
      errors,
    );
  }
  if (base.health?.ignore !== undefined) {
    assertSubset(
      current.health?.ignore ?? [],
      base.health.ignore,
      'health ignore pattern',
      errors,
    );
  }
  if (base.duplicates?.ignore !== undefined) {
    assertSubset(
      current.duplicates?.ignore ?? [],
      base.duplicates.ignore,
      'duplicate ignore pattern',
      errors,
    );
  }
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
    validateHealthBaseline(current.health, 'bootstrap', errors);
    validateDupesBaseline(current.dupes, 'bootstrap', errors);
    validateCoveragePolicy(current.coverage, 'bootstrap', errors);
    compareBootstrapFallowIgnores(base.fallow, current.fallow, errors);

    // A missing marker can also represent an interrupted marker read. If the
    // base already uses the identity schema, treat it as fully compatible and
    // enforce every existing ceiling instead of granting bootstrap semantics.
    if (isRecord(base.health?.identity_finding_counts)) {
      compareHealth(base.health, current.health, errors);
      compareDupes(base.dupes, current.dupes, errors);
      if (base.coverage !== null) {
        compareCoverage(base.coverage, current.coverage, errors);
      }
    }
    return errors;
  }

  if (JSON.stringify(current.marker) !== JSON.stringify(base.marker)) {
    errors.push('baseline bootstrap marker changed after migration');
  }
  compareHealth(base.health, current.health, errors);
  compareDupes(base.dupes, current.dupes, errors);
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
