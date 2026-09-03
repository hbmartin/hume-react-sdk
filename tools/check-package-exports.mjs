import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolsDirectory, '..');
const packageRoot = resolve(process.argv[2] ?? '.');
const dependencyPackageRoots = process.argv
  .slice(3)
  .map((path) => resolve(path));
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** @type {unknown} */
const manifestValue = JSON.parse(
  await readFile(join(packageRoot, 'package.json'), 'utf8'),
);

if (
  !isRecord(manifestValue) ||
  typeof manifestValue.name !== 'string' ||
  manifestValue.name === ''
) {
  throw new Error(`Package at ${packageRoot} does not have a valid name`);
}
const packageName = manifestValue.name;

const fixtureRoot = await mkdtemp(join(tmpdir(), 'hume-package-check-'));

try {
  const tarballPaths = [];
  for (const root of [packageRoot, ...dependencyPackageRoots]) {
    const { stdout: packOutput } = await execFileAsync(
      'pnpm',
      ['--dir', root, 'pack', '--json', '--pack-destination', fixtureRoot],
      { cwd: repositoryRoot },
    );
    /** @type {unknown} */
    const packResult = JSON.parse(packOutput);

    if (
      !isRecord(packResult) ||
      typeof packResult.filename !== 'string' ||
      packResult.filename === ''
    ) {
      throw new Error(`pnpm pack did not return a tarball for ${root}`);
    }
    tarballPaths.push(packResult.filename);
  }

  await writeFile(
    join(fixtureRoot, 'package.json'),
    `${JSON.stringify({ name: 'package-export-check', private: true })}\n`,
  );
  await execFileAsync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      ...tarballPaths,
      '@types/react@19',
      '@types/react-dom@19',
    ],
    { cwd: fixtureRoot },
  );

  const packageSpecifier = JSON.stringify(packageName);
  await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const sdk = await import(${packageSpecifier}); if (Object.keys(sdk).length === 0) throw new Error('ESM entry has no exports');`,
    ],
    { cwd: fixtureRoot },
  );
  await execFileAsync(
    process.execPath,
    [
      '--eval',
      `const sdk = require(${packageSpecifier}); if (Object.keys(sdk).length === 0) throw new Error('CommonJS entry has no exports');`,
    ],
    { cwd: fixtureRoot },
  );
  await execFileAsync(
    process.execPath,
    [
      '--eval',
      `const manifest = require(${JSON.stringify(`${packageName}/package.json`)}); if (manifest.name !== ${packageSpecifier}) throw new Error('Public package.json export is invalid');`,
    ],
    { cwd: fixtureRoot },
  );

  await writeFile(
    join(fixtureRoot, 'import-test.mts'),
    `import * as sdk from ${packageSpecifier};\nvoid sdk;\n`,
  );
  await writeFile(
    join(fixtureRoot, 'require-test.cts'),
    `import sdk = require(${packageSpecifier});\nvoid sdk;\n`,
  );
  await execFileAsync(
    process.execPath,
    [
      join(packageRoot, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      'true',
      '--target',
      'ES2022',
      '--module',
      'Node16',
      '--moduleResolution',
      'Node16',
      join(fixtureRoot, 'import-test.mts'),
      join(fixtureRoot, 'require-test.cts'),
    ],
    { cwd: fixtureRoot },
  );

  console.log(
    `Verified packed ESM, CommonJS, types, and package.json for ${packageName}`,
  );
} finally {
  await rm(fixtureRoot, { force: true, recursive: true });
}
