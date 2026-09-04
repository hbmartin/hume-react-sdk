import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getOwnValue, getOwnValues, isObjectRecord } from './safe-object.mjs';

const publishablePackagePaths = [
  'packages/embed/package.json',
  'packages/embed-react/package.json',
  'packages/react/package.json',
];

const packageNamePattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const versionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const defaultRegistryRequestAttempts = 3;
const defaultRegistryRequestTimeoutMs = 10_000;
const defaultRegistryRetryDelayMs = 250;

/** @param {unknown} value */
function toStringRecord(value) {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  /** @type {Record<string, string>} */
  const result = {};
  for (const key of Object.keys(value)) {
    const entry = getOwnValue(value, key);
    if (typeof entry !== 'string') return undefined;
    result[key] = entry;
  }
  return result;
}

/** @param {unknown} value @returns {PackageManifest} */
function parsePackageManifest(value) {
  if (!isObjectRecord(value)) {
    throw new Error('Package manifest must be an object.');
  }
  const [
    name,
    version,
    privatePackage,
    repository,
    dependenciesValue,
    optionalDependenciesValue,
  ] = getOwnValues(value, [
    'name',
    'version',
    'private',
    'repository',
    'dependencies',
    'optionalDependencies',
  ]);
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(
      'Package manifest requires string name and version fields.',
    );
  }
  if (privatePackage !== undefined && typeof privatePackage !== 'boolean') {
    throw new Error('Package manifest private field must be boolean.');
  }
  const repositoryUrl =
    typeof repository === 'object' && repository !== null
      ? getOwnValue(repository, 'url')
      : undefined;
  if (repositoryUrl !== undefined && typeof repositoryUrl !== 'string') {
    throw new Error('Package manifest repository URL must be a string.');
  }
  const dependencies = toStringRecord(dependenciesValue);
  const optionalDependencies = toStringRecord(optionalDependenciesValue);
  if (dependenciesValue !== undefined && dependencies === undefined) {
    throw new Error('Package manifest dependencies must contain only strings.');
  }
  if (
    optionalDependenciesValue !== undefined &&
    optionalDependencies === undefined
  ) {
    throw new Error(
      'Package manifest optionalDependencies must contain only strings.',
    );
  }
  return {
    name,
    version,
    ...(privatePackage === undefined ? {} : { private: privatePackage }),
    ...(repositoryUrl === undefined
      ? {}
      : { repository: { url: repositoryUrl } }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
  };
}

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

/**
 * Parses the shared release command-line contract.
 *
 * @param {readonly string[]} arguments_
 * @param {string} [environmentReleaseTag]
 */
export function parseReleaseArguments(
  arguments_,
  environmentReleaseTag = process.env['RELEASE_TAG'],
) {
  const dryRun = arguments_.includes('--dry-run');
  const releaseTags = arguments_.filter((argument) => argument !== '--dry-run');
  if (releaseTags.length > 1) {
    throw new Error(
      'Expected a single release tag and an optional --dry-run flag.',
    );
  }

  return {
    dryRun,
    releaseTag: releaseTags[0] ?? environmentReleaseTag,
  };
}

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

/**
 * @param {string} dependencyName
 * @param {PackageManifest | undefined} dependency
 * @returns {PackageManifest}
 */
function requirePublishableWorkspaceDependency(dependencyName, dependency) {
  if (dependency === undefined) {
    throw new Error(
      `Runtime workspace dependency ${dependencyName} is not publishable.`,
    );
  }
  if (dependency.private === true) {
    throw new Error(
      `Runtime workspace dependency ${dependency.name} is private and cannot be published.`,
    );
  }
  return dependency;
}

/**
 * @param {readonly string[]} selectedPackageNames
 * @param {readonly PackageManifest[]} packages
 * @param {string} expectedVersion
 */
function includeRuntimeWorkspaceDependencies(
  selectedPackageNames,
  packages,
  expectedVersion,
) {
  const packagesByName = new Map(
    packages.map((packageManifest) => [packageManifest.name, packageManifest]),
  );
  const includedPackageNames = new Set(selectedPackageNames);
  /** @type {Map<string, { name: string, version: string }>} */
  const workspaceDependenciesToVerify = new Map();
  for (const packageName of includedPackageNames) {
    const packageManifest = packagesByName.get(packageName);
    if (packageManifest === undefined) {
      throw new Error(`Selected package ${packageName} is not publishable.`);
    }
    for (const dependencyName of getRuntimeWorkspaceDependencies(
      packageManifest,
    )) {
      const dependency = requirePublishableWorkspaceDependency(
        dependencyName,
        packagesByName.get(dependencyName),
      );
      if (dependency.version === expectedVersion) {
        includedPackageNames.add(dependency.name);
      } else {
        workspaceDependenciesToVerify.set(
          `${dependency.name}@${dependency.version}`,
          { name: dependency.name, version: dependency.version },
        );
      }
    }
  }
  return {
    packageNames: packages
      .filter((packageManifest) =>
        includedPackageNames.has(packageManifest.name),
      )
      .map((packageManifest) => packageManifest.name),
    workspaceDependenciesToVerify: [...workspaceDependenciesToVerify.values()],
  };
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
  const { packageNames, workspaceDependenciesToVerify } =
    includeRuntimeWorkspaceDependencies(
      releasePackageNames,
      packages,
      expectedVersion,
    );

  return {
    expectedVersion,
    npmTag: expectedVersion.includes('-') ? 'next' : 'latest',
    packageNames,
    workspaceDependenciesToVerify,
  };
}

/** @param {number} delayMs */
function wait(delayMs) {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

/** @param {number} status */
function isRetryableRegistryStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * @param {typeof globalThis.fetch} fetchImplementation
 * @param {URL} url
 * @param {number} timeoutMs
 * @param {string | undefined} registryToken
 */
async function fetchRegistryResponse(
  fetchImplementation,
  url,
  timeoutMs,
  registryToken,
) {
  const abortController = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeout;
  /** @type {Promise<never>} */
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(
        `npm registry request timed out after ${timeoutMs}ms.`,
      );
      abortController.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImplementation(url, {
        headers: {
          accept: 'application/json',
          ...(registryToken === undefined || registryToken === ''
            ? {}
            : { authorization: `Bearer ${registryToken}` }),
        },
        signal: abortController.signal,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * @param {{ name: string, version: string }} dependency
 * @param {URL} registry
 * @param {{ fetchImplementation: typeof globalThis.fetch, maxAttempts: number, registryToken: string | undefined, retryDelayMs: number, timeoutMs: number }} options
 */
async function validatePublishedWorkspaceDependency(
  dependency,
  registry,
  { fetchImplementation, maxAttempts, registryToken, retryDelayMs, timeoutMs },
) {
  const packageVersionUrl = new URL(
    `${encodeURIComponent(dependency.name)}/${encodeURIComponent(dependency.version)}`,
    registry,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchRegistryResponse(
        fetchImplementation,
        packageVersionUrl,
        timeoutMs,
        registryToken,
      );
    } catch (cause) {
      if (attempt < maxAttempts) {
        await wait(retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(
        `Could not verify ${dependency.name}@${dependency.version} in ${registry.origin} after ${maxAttempts} attempts.`,
        { cause },
      );
    }

    if (response.ok) return;
    if (response.status === 404) {
      throw new Error(
        `Runtime workspace dependency ${dependency.name}@${dependency.version} has not been published.`,
      );
    }
    if (isRetryableRegistryStatus(response.status) && attempt < maxAttempts) {
      await wait(retryDelayMs * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(
      `Could not verify ${dependency.name}@${dependency.version}; the npm registry returned HTTP ${response.status}.`,
    );
  }
}

/**
 * Verifies that version-skewed runtime workspace dependencies already exist in
 * the configured npm registry before publishing a dependent package. Registry
 * authentication is sent only when `registryToken` is explicitly supplied.
 *
 * @param {{ workspaceDependenciesToVerify: readonly { name: string, version: string }[] }} plan
 * @param {{ fetchImplementation?: typeof globalThis.fetch, maxAttempts?: number, registryToken?: string, registryUrl?: string, retryDelayMs?: number, timeoutMs?: number }} [options]
 */
export async function validatePublishedWorkspaceDependencies(
  plan,
  {
    fetchImplementation = globalThis.fetch,
    maxAttempts = defaultRegistryRequestAttempts,
    registryToken,
    registryUrl = process.env['npm_config_registry'] ??
      process.env['NPM_CONFIG_REGISTRY'] ??
      'https://registry.npmjs.org/',
    retryDelayMs = defaultRegistryRetryDelayMs,
    timeoutMs = defaultRegistryRequestTimeoutMs,
  } = {},
) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive safe integer.');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('retryDelayMs must be a non-negative finite number.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive finite number.');
  }
  const registry = new URL(registryUrl);
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';

  await Promise.all(
    plan.workspaceDependenciesToVerify.map((dependency) =>
      validatePublishedWorkspaceDependency(dependency, registry, {
        fetchImplementation,
        maxAttempts,
        registryToken,
        retryDelayMs,
        timeoutMs,
      }),
    ),
  );
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
      return parsePackageManifest(JSON.parse(contents));
    }),
  );
}

/**
 * Reads and validates the repository-backed release plan used by release
 * commands before they run checks or publish packages.
 *
 * @param {string | undefined} releaseTag
 */
export async function createValidatedReleasePlan(releaseTag) {
  const packages = await readPublishablePackages();
  validateProvenanceRepository(process.env['GITHUB_REPOSITORY'], packages);
  const plan = createReleasePlan(releaseTag, packages);
  await validatePublishedWorkspaceDependencies(plan);
  return plan;
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
  const { releaseTag } = parseReleaseArguments(process.argv.slice(2));
  const plan = await createValidatedReleasePlan(releaseTag);

  process.stdout.write(
    `Release ${plan.expectedVersion} will publish ${plan.packageNames.join(', ')} with the npm dist-tag ${plan.npmTag}.\n`,
  );
}

if (await isDirectExecution(process.argv[1], import.meta.url)) {
  await main();
}
