import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublishArguments, createReleasePlan } from './release-plan.mjs';

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
