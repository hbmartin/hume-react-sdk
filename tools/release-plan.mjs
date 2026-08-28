import { readFile, realpath } from 'node:fs/promises';
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
 * @typedef {{
 *   name: string,
 *   version: string,
 *   private?: boolean,
 *   repository?: { url?: string },
 *   dependencies?: Record<string, string>,
 *   optionalDependencies?: Record<string, string>,
 * }} PackageManifest
 */

/** @param {string | undefined} releaseTag */
function requireReleaseTag(releaseTag) {
  if (releaseTag === undefined)
    throw new Error('Invalid release tag: (missing)');
  if (!releaseTag.startsWith('v')) {
    throw new Error(`Invalid release tag: ${releaseTag}`);
  }
  return releaseTag;
}

/** @param {string | undefined} releaseTag */
function parseReleaseVersion(releaseTag) {
  const validatedTag = requireReleaseTag(releaseTag);
  const expectedVersion = validatedTag.slice(1);
  if (!versionPattern.test(expectedVersion)) {
    throw new Error(`Invalid release tag: ${validatedTag}`);
  }
  return expectedVersion;
}

/** @param {PackageManifest} packageManifest */
function validatePackageManifest(packageManifest) {
  if (!packageNamePattern.test(packageManifest.name)) {
    throw new Error(`Invalid package name: ${packageManifest.name}`);
  }
  if (!versionPattern.test(packageManifest.version)) {
    throw new Error(
      `${packageManifest.name} has an invalid version: ${packageManifest.version}`,
    );
  }
}

/** @param {PackageManifest} packageManifest */
function getRuntimeWorkspaceDependencies(packageManifest) {
  return [
    ...Object.entries(packageManifest.dependencies ?? {}),
    ...Object.entries(packageManifest.optionalDependencies ?? {}),
  ]
    .filter(([, version]) => version.startsWith('workspace:'))
    .map(([name]) => name);
}

/** @param {PackageManifest | undefined} dependency */
function requirePublishableWorkspaceDependency(dependency) {
  if (dependency === undefined) {
    throw new Error('A runtime workspace dependency is not publishable.');
  }
  if (dependency.private === true) {
    throw new Error(
      `Runtime workspace dependency ${dependency.name} is private and cannot be published.`,
    );
  }
  return dependency.name;
}

/**
 * @param {readonly string[]} selectedPackageNames
 * @param {readonly PackageManifest[]} packages
 */
function includeRuntimeWorkspaceDependencies(selectedPackageNames, packages) {
  const packagesByName = new Map(
    packages.map((packageManifest) => [packageManifest.name, packageManifest]),
  );
  const includedPackageNames = new Set(selectedPackageNames);
  for (const packageName of includedPackageNames) {
    const packageManifest = packagesByName.get(packageName);
    for (const dependencyName of getRuntimeWorkspaceDependencies(
      /** @type {PackageManifest} */ (packageManifest),
    )) {
      includedPackageNames.add(
        requirePublishableWorkspaceDependency(
          packagesByName.get(dependencyName),
        ),
      );
    }
  }
  return packages
    .filter((packageManifest) => includedPackageNames.has(packageManifest.name))
    .map((packageManifest) => packageManifest.name);
}

/** @param {string | undefined} repositoryUrl */
function getGitHubRepository(repositoryUrl) {
  if (repositoryUrl === undefined) return null;
  try {
    const url = new URL(repositoryUrl.replace(/^git\+/, ''));
    if (url.hostname !== 'github.com') return null;
    return url.pathname.replace(/^\//, '').replace(/\.git$/, '');
  } catch {
    return null;
  }
}

/**
 * Ensures npm provenance will describe the repository running the workflow.
 *
 * @param {string | undefined} githubRepository
 * @param {readonly PackageManifest[]} packages
 */
export function validateProvenanceRepository(githubRepository, packages) {
  if (githubRepository === undefined) return;
  const mismatches = packages
    .filter(
      (packageManifest) =>
        getGitHubRepository(packageManifest.repository?.url) !==
        githubRepository,
    )
    .map((packageManifest) => packageManifest.name);
  if (mismatches.length > 0) {
    throw new Error(
      `Cannot publish with provenance from ${githubRepository}; update repository.url for ${mismatches.join(', ')}.`,
    );
  }
}

/**
 * Selects exactly the publishable packages represented by a release tag.
 *
 * @param {string | undefined} releaseTag
 * @param {readonly PackageManifest[]} packages
 */
export function createReleasePlan(releaseTag, packages) {
  const expectedVersion = parseReleaseVersion(releaseTag);
  packages.forEach(validatePackageManifest);

  const releasePackageNames = packages
    .filter(
      (packageManifest) =>
        packageManifest.private !== true &&
        packageManifest.version === expectedVersion,
    )
    .map((packageManifest) => packageManifest.name);

  if (releasePackageNames.length === 0) {
    throw new Error(`No publishable package matches release tag ${releaseTag}`);
  }
  const packageNames = includeRuntimeWorkspaceDependencies(
    releasePackageNames,
    packages,
  );

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

/**
 * @param {string | undefined} executablePath
 * @param {string} moduleUrl
 */
export async function isDirectExecution(executablePath, moduleUrl) {
  if (executablePath === undefined) return false;
  try {
    const [executableRealPath, moduleRealPath] = await Promise.all([
      realpath(executablePath),
      realpath(fileURLToPath(moduleUrl)),
    ]);
    return executableRealPath === moduleRealPath;
  } catch {
    return false;
  }
}

async function main() {
  const releaseTag = process.argv[2] ?? process.env.RELEASE_TAG;
  const packages = await readPublishablePackages();
  validateProvenanceRepository(process.env.GITHUB_REPOSITORY, packages);
  const plan = createReleasePlan(releaseTag, packages);

  process.stdout.write(
    `Release ${plan.expectedVersion} will publish ${plan.packageNames.join(', ')} with the npm dist-tag ${plan.npmTag}.\n`,
  );
}

if (await isDirectExecution(process.argv[1], import.meta.url)) {
  await main();
}
