/**
 * Builds a shell-free pnpm child-process invocation.
 *
 * Windows package-manager shims are batch files and cannot be executed
 * directly by Node. Invoke the shim through the system command interpreter;
 * other platforms can execute the pnpm launcher directly.
 *
 * @param {readonly string[]} arguments_
 * @param {NodeJS.Platform} [platform]
 * @param {string} [commandInterpreter]
 */
export function getPnpmInvocation(
  arguments_,
  platform = process.platform,
  commandInterpreter = process.env.ComSpec,
) {
  if (platform === 'win32') {
    return {
      command: commandInterpreter ?? 'cmd.exe',
      arguments: ['/d', '/s', '/c', 'pnpm.cmd', ...arguments_],
    };
  }
  return { command: 'pnpm', arguments: [...arguments_] };
}
