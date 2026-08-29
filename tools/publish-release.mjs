import { spawnSync } from 'node:child_process';

import { getPnpmInvocation } from './pnpm-command.mjs';
import {
  createPublishArguments,
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
