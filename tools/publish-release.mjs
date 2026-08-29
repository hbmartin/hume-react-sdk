import { spawnSync } from 'node:child_process';

import { getPnpmInvocation } from './pnpm-command.mjs';
import {
  createPublishArguments,
  createValidatedReleasePlan,
  parseReleaseArguments,
} from './release-plan.mjs';

const { dryRun, releaseTag } = parseReleaseArguments(process.argv.slice(2));
const plan = await createValidatedReleasePlan(releaseTag);
const publishArguments = createPublishArguments(plan, { dryRun });

process.stdout.write(
  `${dryRun ? 'Dry-running' : 'Publishing'} ${plan.packageNames.join(', ')} with the npm dist-tag ${plan.npmTag}.\n`,
);

const pnpm = getPnpmInvocation(publishArguments);
const result = spawnSync(pnpm.command, pnpm.arguments, {
  stdio: 'inherit',
});

if (result.error !== undefined) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
