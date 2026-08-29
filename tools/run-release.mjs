import { spawnSync } from 'node:child_process';

import { getPnpmInvocation } from './pnpm-command.mjs';
import {
  createValidatedReleasePlan,
  parseReleaseArguments,
} from './release-plan.mjs';

const { dryRun, releaseTag } = parseReleaseArguments(process.argv.slice(2));
await createValidatedReleasePlan(releaseTag);

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
