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
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createPublishArguments,
  createReleasePlan,
  validateProvenanceRepository,
} from './release-plan.mjs';

const packages = [
  { name: '@humeai/voice-embed', version: '0.2.18' },
  { name: '@humeai/voice-embed-react', version: '0.2.18' },
  { name: '@humeai/voice-react', version: '0.3.0-beta.7' },
];

await test('stable releases select only matching packages and use the latest dist-tag', () => {
  assert.deepEqual(createReleasePlan('v0.2.18', packages), {
    expectedVersion: '0.2.18',
    npmTag: 'latest',
    packageNames: ['@humeai/voice-embed', '@humeai/voice-embed-react'],
  });
});

await test('prereleases select only matching packages and use the next dist-tag', () => {
  assert.deepEqual(createReleasePlan('v0.3.0-beta.7', packages), {
    expectedVersion: '0.3.0-beta.7',
    npmTag: 'next',
    packageNames: ['@humeai/voice-react'],
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
    const fakePnpm = join(binaryDirectory, 'pnpm');
    await writeFile(
      fakePnpm,
      `#!/usr/bin/env node\nconst { appendFileSync } = require('node:fs');\nappendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    );
    await chmod(fakePnpm, 0o755);

    const environment = { ...process.env };
    delete environment.GITHUB_REPOSITORY;
    delete environment.RELEASE_TAG;
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
          PATH: `${binaryDirectory}:${environment.PATH ?? ''}`,
          RELEASE_TEST_LOG: invocationLog,
          ...(releaseTag === undefined ? {} : { RELEASE_TAG: releaseTag }),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return (await readFile(invocationLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
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

await test('runtime workspace dependencies are included in the publish closure', () => {
  assert.deepEqual(
    createReleasePlan('v2.0.0', [
      { name: '@humeai/dependency', version: '1.0.0' },
      {
        name: '@humeai/dependent',
        version: '2.0.0',
        dependencies: { '@humeai/dependency': 'workspace:*' },
      },
    ]).packageNames,
    ['@humeai/dependency', '@humeai/dependent'],
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
