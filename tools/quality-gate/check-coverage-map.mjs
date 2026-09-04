import { parse } from '@babel/parser';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson, repositoryRoot } from './quality-gate-utils.mjs';

const coveragePath = resolve(repositoryRoot, 'coverage/coverage-final.json');

/** @param {string} path */
const normalizePath = (path) => path.replaceAll('\\', '/');

const getTrackedFiles = () => {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('Unable to list tracked coverage inputs.');
  return result.stdout.split('\0').filter(Boolean).map(normalizePath);
};

/**
 * @param {string} path
 * @param {CoveragePolicy} policy
 */
const isCoveredSource = (path, policy) =>
  policy.include.some((pattern) => matchesGlob(path, pattern)) &&
  !policy.exclude.some((pattern) => matchesGlob(path, pattern));

/**
 * Coverage generation inputs include excluded tests and support modules. A
 * change to any tracked file selected by an include glob can alter the map,
 * even when that file is not itself required to appear in the map.
 *
 * @param {string} path
 * @param {CoveragePolicy} policy
 */
const isCoverageInput = (path, policy) =>
  policy.include.some((pattern) => matchesGlob(path, pattern));

/**
 * @param {{ type: string, declare?: boolean | null, declaration?: null | { type: string, declare?: boolean | null } }} node
 * @returns {boolean}
 */
const isCoverageCounterFreeNode = (node) => {
  if (node.declare === true) return true;
  if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportAllDeclaration' ||
    node.type === 'TSInterfaceDeclaration' ||
    node.type === 'TSTypeAliasDeclaration' ||
    node.type === 'TSDeclareFunction' ||
    node.type === 'EmptyStatement'
  ) {
    return true;
  }
  if (
    node.type !== 'ExportNamedDeclaration' &&
    node.type !== 'ExportDefaultDeclaration'
  ) {
    return false;
  }
  return (
    node.declaration === null ||
    (node.declaration !== undefined &&
      isCoverageCounterFreeNode(node.declaration))
  );
};

/**
 * Istanbul omits modules that cannot receive a statement, branch, or function
 * counter. Recognize only syntax that TypeScript erases or that merely links
 * modules; everything else must still appear in the coverage map.
 *
 * @param {string} path
 * @param {string} source
 */
export const isCoverageCounterFreeSource = (path, source) => {
  try {
    const file = parse(source, {
      plugins: path.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
      sourceFilename: path,
      sourceType: 'module',
    });
    return file.program.body.every(isCoverageCounterFreeNode);
  } catch {
    return false;
  }
};

/**
 * @param {CoveragePolicy} policy
 * @param {string[]} trackedFiles
 * @param {string[]} coverageFiles
 * @param {ReadonlySet<string>} [counterFreeFiles]
 */
export const getCoveragePolicyErrors = (
  policy,
  trackedFiles,
  coverageFiles,
  counterFreeFiles = new Set(),
) => {
  const errors = [];
  for (const pattern of policy.include) {
    if (!trackedFiles.some((path) => matchesGlob(path, pattern))) {
      errors.push(`coverage include matches no tracked files: ${pattern}`);
    }
  }

  const expectedFiles = trackedFiles.filter((path) =>
    isCoveredSource(path, policy),
  );
  const coveredFiles = new Set(coverageFiles.map(normalizePath));
  for (const path of expectedFiles) {
    if (!coveredFiles.has(path) && !counterFreeFiles.has(path)) {
      errors.push(`coverage map is missing tracked source: ${path}`);
    }
  }

  for (const [pattern, floors] of Object.entries(policy.thresholds)) {
    if (!expectedFiles.some((path) => matchesGlob(path, pattern))) {
      errors.push(`coverage threshold matches no tracked sources: ${pattern}`);
    }
    for (const metric of /** @type {const} */ ([
      'branches',
      'functions',
      'lines',
      'statements',
    ])) {
      const floor = floors[metric];
      if (typeof floor !== 'number' || !Number.isFinite(floor) || floor <= 0) {
        errors.push(
          `coverage threshold must be positive: ${pattern} ${metric}`,
        );
      }
    }
  }

  for (const path of expectedFiles) {
    if (
      !Object.keys(policy.thresholds).some((pattern) =>
        matchesGlob(path, pattern),
      )
    ) {
      errors.push(`tracked coverage source has no threshold: ${path}`);
    }
  }
  return errors;
};

export const getTrackedCoverageInputs = () => {
  const policy = /** @type {CoveragePolicy} */ (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- policy shape is validated through glob and numeric field use below
    readJson(resolve(repositoryRoot, 'coverage-policy.json'))
  );
  return getTrackedFiles().filter(
    (path) =>
      isCoverageInput(path, policy) ||
      path === 'vitest.config.mts' ||
      path === 'tools/vitest-config/base.mjs' ||
      path === 'coverage-policy.json' ||
      path === 'pnpm-lock.yaml' ||
      path === 'package.json' ||
      path === 'tsconfig.json' ||
      path.endsWith('/tsconfig.json') ||
      /\/tsconfig\.[^/]+\.json$/.test(path) ||
      path.endsWith('/vitest.config.mts'),
  );
};

export const validateCoverageMap = () => {
  if (!existsSync(coveragePath)) {
    throw new Error(
      'Coverage map is missing. Run `pnpm test:coverage` before the Fallow gates.',
    );
  }

  const coverage =
    /** @type {Record<string, { s?: Record<string, number> }>} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the validator checks the Istanbul file map and numeric statement counters before accepting it
      readJson(coveragePath)
    );
  const files = Object.values(coverage);
  if (files.length === 0) throw new Error('Coverage map is empty.');

  const policy = /** @type {CoveragePolicy} */ (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- policy fields are validated by getCoveragePolicyErrors before use by the gate
    readJson(resolve(repositoryRoot, 'coverage-policy.json'))
  );
  const coverageFiles = Object.keys(coverage).map((path) =>
    normalizePath(isAbsolute(path) ? relative(repositoryRoot, path) : path),
  );
  const trackedFiles = getTrackedFiles();
  const counterFreeFiles = new Set(
    trackedFiles
      .filter((path) => isCoveredSource(path, policy))
      .filter((path) =>
        isCoverageCounterFreeSource(
          path,
          readFileSync(resolve(repositoryRoot, path), 'utf8'),
        ),
      ),
  );
  const policyErrors = getCoveragePolicyErrors(
    policy,
    trackedFiles,
    coverageFiles,
    counterFreeFiles,
  );
  if (policyErrors.length > 0) {
    throw new Error(
      `Invalid coverage policy or map:\n- ${policyErrors.join('\n- ')}`,
    );
  }

  let statementCount = 0;
  let executedStatementCount = 0;
  for (const file of files) {
    const statements = Object.values(file.s ?? {});
    statementCount += statements.length;
    executedStatementCount += statements.filter((count) => count > 0).length;
  }
  if (statementCount === 0 || executedStatementCount === 0) {
    throw new Error('Coverage map contains no executed Istanbul statements.');
  }

  const coverageModifiedAt = statSync(coveragePath).mtimeMs;
  const staleInputs = getTrackedCoverageInputs().filter((path) => {
    const absolutePath = resolve(repositoryRoot, path);
    return (
      existsSync(absolutePath) &&
      statSync(absolutePath).mtimeMs > coverageModifiedAt
    );
  });
  if (staleInputs.length > 0) {
    const sample = staleInputs.slice(0, 3).join(', ');
    throw new Error(
      `Coverage map is stale; newer coverage inputs include ${sample}. Run \`pnpm test:coverage\`.`,
    );
  }

  return { executedStatementCount, fileCount: files.length, statementCount };
};

const executablePath = process.argv[1];
const isMain =
  executablePath !== undefined && executablePath !== ''
    ? fileURLToPath(import.meta.url) === resolve(executablePath)
    : false;

if (isMain) {
  try {
    const result = validateCoverageMap();
    console.log(
      `Coverage map verified: ${result.fileCount} files, ${result.executedStatementCount}/${result.statementCount} statements executed.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

/** @typedef {{ branches?: unknown, functions?: unknown, lines?: unknown, statements?: unknown }} CoverageFloors */
/** @typedef {{ include: string[], exclude: string[], thresholds: Record<string, CoverageFloors> }} CoveragePolicy */
