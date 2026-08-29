import { spawnSync } from 'node:child_process';

import { getPnpmInvocation } from './pnpm-command.mjs';
import {
  createPublishArguments,
  createValidatedReleasePlan,
  parseReleaseArguments,
} from './release-plan.mjs';

const { dryRun, releaseTag } = parseReleaseArguments(process.argv.slice(2));
const plan = await createValidatedReleasePlan(releaseTag);

const pnpmCheck = getPnpmInvocation(['check']);
const check = spawnSync(pnpmCheck.command, pnpmCheck.arguments, {
  stdio: 'inherit',
});
if (check.error !== undefined) throw check.error;
if (check.status !== 0) process.exit(check.status ?? 1);

process.stdout.write(
  `${dryRun ? 'Dry-running' : 'Publishing'} ${plan.packageNames.join(', ')} with the npm dist-tag ${plan.npmTag}.\n`,
);
const pnpmPublish = getPnpmInvocation(createPublishArguments(plan, { dryRun }));
const publish = spawnSync(pnpmPublish.command, pnpmPublish.arguments, {
  stdio: 'inherit',
});
if (publish.error !== undefined) throw publish.error;
process.exitCode = publish.status ?? 1;
