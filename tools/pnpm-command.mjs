/**
 * Resolves the pnpm launcher installed by Corepack or pnpm itself.
 *
 * Windows package-manager shims use the `.cmd` extension, so shell-free spawn
 * calls need to select that launcher explicitly.
 *
 * @param {NodeJS.Platform} [platform]
 */
export function getPnpmCommand(platform = process.platform) {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}
