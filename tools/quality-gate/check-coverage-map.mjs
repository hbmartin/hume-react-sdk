import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson, repositoryRoot } from './quality-gate-utils.mjs';

const coveragePath = resolve(repositoryRoot, 'coverage/coverage-final.json');
const coveredRoots = [
  'packages/embed/src/',
  'packages/embed-react/src/',
  'packages/react/src/',
  'examples/next-app/app/',
  'examples/next-app/components/',
  'examples/next-app/utils/',
  'examples/vite-app/src/',
  'examples/vite-app-embed/src/',
];

export const getTrackedCoverageInputs = () => {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('Unable to list tracked coverage inputs.');

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter(
      (path) =>
        (coveredRoots.some((root) => path.startsWith(root)) &&
          /\.(?:ts|tsx)$/.test(path) &&
          !path.endsWith('.d.ts')) ||
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
