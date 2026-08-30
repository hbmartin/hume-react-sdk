import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getPnpmInvocation } from './pnpm-command.mjs';
import {
  createPublishArguments,
  createReleasePlan,
  parseReleaseArguments,
  validatePublishedWorkspaceDependencies,
  validateProvenanceRepository,
} from './release-plan.mjs';

const packages = [
  { name: '@humeai/voice-embed', version: '0.2.18' },
  { name: '@humeai/voice-embed-react', version: '0.2.18' },
  { name: '@humeai/voice-react', version: '0.3.0-beta.7' },
];

function getReleaseTestEnvironment() {
  const environment = { ...process.env };
  delete environment.GITHUB_REPOSITORY;
  delete environment.RELEASE_TAG;
  return environment;
}

await test('release CLI arguments are parsed consistently', () => {
  assert.deepEqual(parseReleaseArguments(['v1.2.3', '--dry-run']), {
    dryRun: true,
    releaseTag: 'v1.2.3',
  });
  assert.deepEqual(parseReleaseArguments(['--dry-run'], 'v1.2.3'), {
    dryRun: true,
    releaseTag: 'v1.2.3',
  });
  assert.throws(
    () => parseReleaseArguments(['v1.2.3', 'v1.2.4']),
    /Expected a single release tag/,
  );
});

await test('stable releases select only matching packages and use the latest dist-tag', () => {
  assert.deepEqual(createReleasePlan('v0.2.18', packages), {
    expectedVersion: '0.2.18',
    npmTag: 'latest',
    packageNames: ['@humeai/voice-embed', '@humeai/voice-embed-react'],
    workspaceDependenciesToVerify: [],
  });
});

await test('prereleases select only matching packages and use the next dist-tag', () => {
  assert.deepEqual(createReleasePlan('v0.3.0-beta.7', packages), {
    expectedVersion: '0.3.0-beta.7',
    npmTag: 'next',
    packageNames: ['@humeai/voice-react'],
    workspaceDependenciesToVerify: [],
  });
});

await test('invalid and unmatched release tags are rejected', () => {
  assert.throws(
    () => createReleasePlan('0.2.18', packages),
    /Invalid release tag/,
  );
  assert.throws(
    () => createReleasePlan('v0.2.19', packages),
    /No publishable package/,
  );
  assert.throws(
    () => createReleasePlan('v0.3.0-', packages),
    /Invalid release tag/,
  );
  assert.throws(
    () => createReleasePlan('v01.0.0', packages),
    /Invalid release tag/,
  );
  assert.throws(
    () => createReleasePlan('v1.0.0-01', packages),
    /Invalid release tag/,
  );
});

/**
 * @param {string[]} arguments_
 * @param {string} [releaseTag]
 * @returns {Promise<string[][]>}
 */
// fallow-ignore-next-line complexity -- cross-platform fixture setup and teardown are intentionally colocated
async function runRelease(arguments_, releaseTag) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'run-release-'));
  const toolsDirectory = join(temporaryDirectory, 'tools');
  const binaryDirectory = join(temporaryDirectory, 'bin');
  const invocationLog = join(temporaryDirectory, 'pnpm-invocations.jsonl');

  try {
    await Promise.all([
      symlink(fileURLToPath(new URL('.', import.meta.url)), toolsDirectory),
      mkdir(binaryDirectory),
      ...['embed', 'embed-react', 'react'].map(async (packageName) => {
        const packageDirectory = join(
          temporaryDirectory,
          'packages',
          packageName,
        );
        await mkdir(packageDirectory, { recursive: true });
        await writeFile(
          join(packageDirectory, 'package.json'),
          JSON.stringify({ name: `@humeai/${packageName}`, version: '1.2.3' }),
        );
      }),
    ]);
    const fakePnpmScript = join(binaryDirectory, 'fake-pnpm.cjs');
    await writeFile(
      fakePnpmScript,
      `#!/usr/bin/env node\nconst { appendFileSync } = require('node:fs');\nappendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    );
    if (process.platform === 'win32') {
      await writeFile(
        join(binaryDirectory, 'pnpm.cmd'),
        `@echo off\r\n"${process.execPath}" "%~dp0\\fake-pnpm.cjs" %*\r\n`,
      );
    } else {
      const fakePnpm = join(binaryDirectory, 'pnpm');
      await writeFile(
        fakePnpm,
        `#!/usr/bin/env node\nrequire('./fake-pnpm.cjs');\n`,
      );
      await chmod(fakePnpm, 0o755);
    }

    const environment = getReleaseTestEnvironment();
    const pathKey =
      Object.keys(environment).find((key) => key.toLowerCase() === 'path') ??
      'PATH';
    environment[pathKey] =
      `${binaryDirectory}${delimiter}${environment[pathKey] ?? ''}`;
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./run-release.mjs', import.meta.url)),
        ...arguments_,
      ],
      {
        cwd: temporaryDirectory,
        encoding: 'utf8',
        env: {
          ...environment,
          RELEASE_TEST_LOG: invocationLog,
          ...(releaseTag === undefined ? {} : { RELEASE_TAG: releaseTag }),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return (await readFile(invocationLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const parsed = /** @type {unknown} */ (JSON.parse(line));
        if (
          !Array.isArray(parsed) ||
          !(
            /** @type {unknown[]} */ (parsed).every(
              (argument) => typeof argument === 'string',
            )
          )
        ) {
          throw new Error('The pnpm invocation log was malformed.');
        }
        return /** @type {string[]} */ (parsed);
      });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

await test('run-release accepts v1.2.3 followed by --dry-run', async () => {
  const invocations = await runRelease(['v1.2.3', '--dry-run']);

  assert.deepEqual(invocations[0], ['check']);
  assert.equal(invocations[1]?.at(-1), '--dry-run');
});

await test('run-release accepts --dry-run with RELEASE_TAG', async () => {
  const invocations = await runRelease(['--dry-run'], 'v1.2.3');

  assert.deepEqual(invocations[0], ['check']);
  assert.equal(invocations[1]?.at(-1), '--dry-run');
});

await test('private packages are not selected for publication', () => {
  assert.throws(
    () =>
      createReleasePlan('v0.2.18', [
        { name: '@humeai/private-package', version: '0.2.18', private: true },
      ]),
    /No publishable package/,
  );
});

await test('matching runtime workspace dependencies are included in the publish closure', () => {
  assert.deepEqual(
    createReleasePlan('v2.0.0', [
      { name: '@humeai/dependency', version: '2.0.0' },
      {
        name: '@humeai/dependent',
        version: '2.0.0',
        dependencies: { '@humeai/dependency': 'workspace:*' },
      },
    ]).packageNames,
    ['@humeai/dependency', '@humeai/dependent'],
  );
});

await test('unrelated runtime workspace dependency versions are verified instead of republished', () => {
  const plan = createReleasePlan('v2.0.0', [
    { name: '@humeai/dependency', version: '1.0.0' },
    {
      name: '@humeai/dependent',
      version: '2.0.0',
      dependencies: { '@humeai/dependency': 'workspace:*' },
    },
  ]);

  assert.deepEqual(plan.packageNames, ['@humeai/dependent']);
  assert.deepEqual(plan.workspaceDependenciesToVerify, [
    { name: '@humeai/dependency', version: '1.0.0' },
  ]);
});

await test('published version-skewed workspace dependencies pass validation', async () => {
  const requestedUrls = [];
  await validatePublishedWorkspaceDependencies(
    {
      workspaceDependenciesToVerify: [
        { name: '@humeai/dependency', version: '1.0.0' },
      ],
    },
    {
      fetchImplementation: async (url) => {
        if (typeof url === 'string') requestedUrls.push(url);
        else if (url instanceof URL) requestedUrls.push(url.href);
        else requestedUrls.push(url.url);
        return /** @type {Response} */ ({ ok: true, status: 200 });
      },
      registryUrl: 'https://registry.example.test/npm/',
    },
  );

  assert.deepEqual(requestedUrls, [
    'https://registry.example.test/npm/%40humeai%2Fdependency/1.0.0',
  ]);
});

await test('registry validation forwards npm token authentication', async () => {
  let authorization;
  await validatePublishedWorkspaceDependencies(
    {
      workspaceDependenciesToVerify: [
        { name: '@humeai/dependency', version: '1.0.0' },
      ],
    },
    {
      fetchImplementation: async (_url, init) => {
        const headers = new Headers(init?.headers);
        authorization = headers.get('authorization');
        return /** @type {Response} */ ({ ok: true, status: 200 });
      },
      registryToken: 'test-token',
      registryUrl: 'https://registry.example.test/npm/',
    },
  );

  assert.equal(authorization, 'Bearer test-token');
});

await test('registry validation does not forward ambient npm tokens', async () => {
  const previousNodeAuthToken = process.env.NODE_AUTH_TOKEN;
  const previousNpmToken = process.env.NPM_TOKEN;
  process.env.NODE_AUTH_TOKEN = 'ambient-node-token';
  process.env.NPM_TOKEN = 'ambient-npm-token';
  let authorization;

  try {
    await validatePublishedWorkspaceDependencies(
      {
        workspaceDependenciesToVerify: [
          { name: '@humeai/dependency', version: '1.0.0' },
        ],
      },
      {
        fetchImplementation: async (_url, init) => {
          const headers = new Headers(init?.headers);
          authorization = headers.get('authorization');
          return /** @type {Response} */ ({ ok: true, status: 200 });
        },
        registryUrl: 'https://registry.example.test/npm/',
      },
    );
  } finally {
    if (previousNodeAuthToken === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = previousNodeAuthToken;
    if (previousNpmToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previousNpmToken;
  }

  assert.equal(authorization, null);
});

await test('unpublished version-skewed workspace dependencies block publication', async () => {
  await assert.rejects(
    validatePublishedWorkspaceDependencies(
      {
        workspaceDependenciesToVerify: [
          { name: '@humeai/dependency', version: '1.0.0' },
        ],
      },
      {
        fetchImplementation: async () => /** @type {Response} */ ({
          ok: false,
          status: 404,
        }),
      },
    ),
    /@humeai\/dependency@1\.0\.0 has not been published/,
  );
});

await test('transient registry failures are retried with a bounded attempt count', async () => {
  let attempts = 0;
  await validatePublishedWorkspaceDependencies(
    {
      workspaceDependenciesToVerify: [
        { name: '@humeai/dependency', version: '1.0.0' },
      ],
    },
    {
      fetchImplementation: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary network failure');
        if (attempts === 2) {
          return /** @type {Response} */ ({ ok: false, status: 503 });
        }
        return /** @type {Response} */ ({ ok: true, status: 200 });
      },
      maxAttempts: 3,
      retryDelayMs: 0,
    },
  );

  assert.equal(attempts, 3);
});

await test('non-retryable registry responses fail without extra requests', async () => {
  let attempts = 0;
  await assert.rejects(
    validatePublishedWorkspaceDependencies(
      {
        workspaceDependenciesToVerify: [
          { name: '@humeai/dependency', version: '1.0.0' },
        ],
      },
      {
        fetchImplementation: async () => {
          attempts += 1;
          return /** @type {Response} */ ({ ok: false, status: 401 });
        },
        maxAttempts: 3,
        retryDelayMs: 0,
      },
    ),
    /HTTP 401/,
  );
  assert.equal(attempts, 1);
});

await test('registry requests time out instead of hanging a release', async () => {
  await assert.rejects(
    validatePublishedWorkspaceDependencies(
      {
        workspaceDependenciesToVerify: [
          { name: '@humeai/dependency', version: '1.0.0' },
        ],
      },
      {
        fetchImplementation: async () => new Promise(() => {}),
        maxAttempts: 1,
        timeoutMs: 10,
      },
    ),
    /after 1 attempts/,
  );
});

await test('missing runtime workspace dependencies are identified by name', () => {
  assert.throws(
    () =>
      createReleasePlan('v2.0.0', [
        {
          name: '@humeai/dependent',
          version: '2.0.0',
          dependencies: { '@humeai/missing': 'workspace:*' },
        },
      ]),
    /Runtime workspace dependency @humeai\/missing is not publishable/,
  );
});

await test('private runtime workspace dependencies are rejected', () => {
  assert.throws(
    () =>
      createReleasePlan('v2.0.0', [
        { name: '@humeai/private', version: '1.0.0', private: true },
        {
          name: '@humeai/dependent',
          version: '2.0.0',
          dependencies: { '@humeai/private': 'workspace:*' },
        },
      ]),
    /private and cannot be published/,
  );
});

await test('provenance repositories must match the GitHub workflow repository', () => {
  const manifests = [
    {
      name: '@humeai/voice-react',
      version: '1.0.0',
      repository: {
        url: 'git+https://github.com/HumeAI/hume-react-sdk.git',
      },
    },
  ];
  assert.doesNotThrow(() =>
    validateProvenanceRepository('HumeAI/hume-react-sdk', manifests),
  );
  assert.throws(
    () => validateProvenanceRepository('someone/fork', manifests),
    /Cannot publish with provenance from someone\/fork/,
  );
});

await test('release plan can be imported without a CLI path', () => {
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./tools/release-plan.mjs')"],
    { encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr);
});

await test('release validation executes through a symlink', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'release-plan-'));
  try {
    const symlinkPath = join(temporaryDirectory, 'release-plan.mjs');
    await symlink(new URL('./release-plan.mjs', import.meta.url), symlinkPath);
    const executed = spawnSync(process.execPath, [symlinkPath, 'invalid-tag'], {
      encoding: 'utf8',
      env: getReleaseTestEnvironment(),
    });
    assert.notEqual(executed.status, 0);
    assert.match(executed.stderr, /Invalid release tag/);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

await test('publish arguments filter packages and require provenance', () => {
  const plan = createReleasePlan('v0.3.0-beta.7', packages);

  assert.deepEqual(createPublishArguments(plan, { dryRun: true }), [
    'publish',
    '--recursive',
    '--fail-if-no-match',
    '--access',
    'public',
    '--no-git-checks',
    '--provenance',
    '--tag',
    'next',
    '--filter',
    '@humeai/voice-react',
    '--dry-run',
  ]);
});

await test('pnpm invocation uses the Windows command interpreter', () => {
  assert.deepEqual(
    getPnpmInvocation(['check'], 'win32', 'C:\\Windows\\System32\\cmd.exe'),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      arguments: ['/d', '/s', '/c', 'pnpm.cmd', 'check'],
    },
  );
  assert.deepEqual(getPnpmInvocation(['check'], 'linux'), {
    command: 'pnpm',
    arguments: ['check'],
  });
  assert.deepEqual(getPnpmInvocation(['check'], 'darwin'), {
    command: 'pnpm',
    arguments: ['check'],
  });
});
