import { spawnSync } from 'node:child_process';

import {
  createReleasePlan,
  readPublishablePackages,
  validateProvenanceRepository,
} from './release-plan.mjs';

const releaseTags = process.argv.slice(2);
if (releaseTags.length > 1) {
  throw new Error('Expected a single release tag.');
}

const releaseTag = releaseTags[0] ?? process.env.RELEASE_TAG;
const packages = await readPublishablePackages();
validateProvenanceRepository(process.env.GITHUB_REPOSITORY, packages);
createReleasePlan(releaseTag, packages);

const check = spawnSync('pnpm', ['check'], { stdio: 'inherit' });
if (check.error !== undefined) throw check.error;
if (check.status !== 0) process.exit(check.status ?? 1);

const publish = spawnSync(
  process.execPath,
  ['tools/publish-release.mjs', /** @type {string} */ (releaseTag)],
  { stdio: 'inherit' },
);
if (publish.error !== undefined) throw publish.error;
process.exitCode = publish.status ?? 1;
