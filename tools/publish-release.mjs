import { spawnSync } from 'node:child_process';

import { getPnpmInvocation } from './pnpm-command.mjs';
import {
  createPublishArguments,
  createValidatedReleasePlan,
  isDirectExecution,
  parseReleaseArguments,
} from './release-plan.mjs';

/**
 * Publishes an already validated release plan.
 *
 * @param {{ npmTag: string, packageNames: readonly string[] }} plan
 * @param {{ dryRun?: boolean }} [options]
 * @returns {number}
 */
export function publishRelease(plan, { dryRun = false } = {}) {
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

  return result.status ?? 1;
}

async function main() {
  const { dryRun, releaseTag } = parseReleaseArguments(process.argv.slice(2));
  const plan = await createValidatedReleasePlan(releaseTag);
  process.exitCode = publishRelease(plan, { dryRun });
}

if (await isDirectExecution(process.argv[1], import.meta.url)) {
  await main();
}
