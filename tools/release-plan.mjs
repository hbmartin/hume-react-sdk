import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const publishablePackagePaths = [
  'packages/embed/package.json',
  'packages/embed-react/package.json',
  'packages/react/package.json',
];

const packageNamePattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const versionPattern =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/**
 * @typedef {{ name: string, version: string, private?: boolean }} PackageManifest
 */

/**
 * Selects exactly the publishable packages represented by a release tag.
 *
 * @param {string | undefined} releaseTag
 * @param {readonly PackageManifest[]} packages
 */
export function createReleasePlan(releaseTag, packages) {
  if (releaseTag === undefined || !releaseTag.startsWith('v')) {
    throw new Error(`Invalid release tag: ${releaseTag ?? '(missing)'}`);
  }

  const expectedVersion = releaseTag.slice(1);
  if (!versionPattern.test(expectedVersion)) {
    throw new Error(`Invalid release tag: ${releaseTag}`);
  }

  for (const packageManifest of packages) {
    if (!packageNamePattern.test(packageManifest.name)) {
      throw new Error(`Invalid package name: ${packageManifest.name}`);
    }
    if (!versionPattern.test(packageManifest.version)) {
      throw new Error(
        `${packageManifest.name} has an invalid version: ${packageManifest.version}`,
      );
    }
  }

  const packageNames = packages
    .filter(
      (packageManifest) =>
        packageManifest.private !== true &&
        packageManifest.version === expectedVersion,
    )
    .map((packageManifest) => packageManifest.name);

  if (packageNames.length === 0) {
    throw new Error(`No publishable package matches release tag ${releaseTag}`);
  }

  return {
    expectedVersion,
    npmTag: expectedVersion.includes('-') ? 'next' : 'latest',
    packageNames,
  };
}

/**
 * @param {{ npmTag: string, packageNames: readonly string[] }} plan
 * @param {{ dryRun?: boolean }} [options]
 */
export function createPublishArguments(plan, { dryRun = false } = {}) {
  return [
    'publish',
    '--recursive',
    '--fail-if-no-match',
    '--access',
    'public',
    '--no-git-checks',
    '--provenance',
    '--tag',
    plan.npmTag,
    ...plan.packageNames.flatMap((packageName) => ['--filter', packageName]),
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

/** @param {string} [repositoryRoot] */
export async function readPublishablePackages(repositoryRoot = process.cwd()) {
  return Promise.all(
    publishablePackagePaths.map(async (packagePath) => {
      const contents = await readFile(
        resolve(repositoryRoot, packagePath),
        'utf8',
      );
      return /** @type {PackageManifest} */ (JSON.parse(contents));
    }),
  );
}

async function main() {
  const releaseTag = process.argv[2] ?? process.env.RELEASE_TAG;
  const packages = await readPublishablePackages();
  const plan = createReleasePlan(releaseTag, packages);

  process.stdout.write(
    `Release ${plan.expectedVersion} will publish ${plan.packageNames.join(', ')} with the npm dist-tag ${plan.npmTag}.\n`,
  );
}

const isDirectExecution =
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  await main();
}
