import { spawnSync } from 'node:child_process';

import { getPnpmInvocation } from './pnpm-command.mjs';
import {
  createReleasePlan,
  readPublishablePackages,
  validatePublishedWorkspaceDependencies,
  validateProvenanceRepository,
} from './release-plan.mjs';

const cliArguments = process.argv.slice(2);
const dryRun = cliArguments.includes('--dry-run');
const releaseTags = cliArguments.filter((argument) => argument !== '--dry-run');
if (releaseTags.length > 1) {
  throw new Error(
    'Expected a single release tag and an optional --dry-run flag.',
  );
}

const releaseTag = releaseTags[0] ?? process.env.RELEASE_TAG;
const packages = await readPublishablePackages();
validateProvenanceRepository(process.env.GITHUB_REPOSITORY, packages);
const plan = createReleasePlan(releaseTag, packages);
await validatePublishedWorkspaceDependencies(plan);

const pnpmCheck = getPnpmInvocation(['check']);
const check = spawnSync(pnpmCheck.command, pnpmCheck.arguments, {
  stdio: 'inherit',
});
if (check.error !== undefined) throw check.error;
if (check.status !== 0) process.exit(check.status ?? 1);

const publish = spawnSync(
  process.execPath,
  [
    'tools/publish-release.mjs',
    /** @type {string} */ (releaseTag),
    ...(dryRun ? ['--dry-run'] : []),
  ],
  { stdio: 'inherit' },
);
if (publish.error !== undefined) throw publish.error;
process.exitCode = publish.status ?? 1;
