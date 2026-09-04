import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const repositoryRoot = resolve(import.meta.dirname, '../..');

/** @param {string} path */
export const readJson = (path) =>
  /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')));

/** @param {string} source */
export const parseJsonc = (source) => {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index);
    const nextCharacter = source.charAt(index + 1);

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }

    result += character;
  }

  return JSON.parse(result.replace(/,\s*([}\]])/g, '$1'));
};

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ capture?: boolean }} [options]
 */
export const run = (command, args, options = {}) => {
  const { capture = false } = options;
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });

  if (result.error) throw result.error;
  return result;
};

/** @param {string[]} args */
const gitOutput = (args) => {
  const result = run('git', args, { capture: true });
  return result.status === 0 && typeof result.stdout === 'string'
    ? result.stdout.trim()
    : null;
};

/** @param {string} ref */
const refExists = (ref) => gitOutput(['rev-parse', '--verify', ref]) !== null;

/** @param {string | undefined} explicitBase */
export const resolveAuditBase = (explicitBase) => {
  const candidates = [];
  if (explicitBase !== undefined && explicitBase !== '') {
    candidates.push(explicitBase);
  }
  const configuredBase = process.env['FALLOW_AUDIT_BASE'];
  if (configuredBase !== undefined && configuredBase !== '') {
    candidates.push(configuredBase);
  }
  const githubBase = process.env['GITHUB_BASE_REF'];
  if (githubBase !== undefined && githubBase !== '') {
    candidates.push(`origin/${githubBase}`);
  }

  const currentBranch = gitOutput(['branch', '--show-current']);
  if (currentBranch !== null && currentBranch !== '') {
    candidates.push(`origin/${currentBranch}`);
  }

  const upstream = gitOutput([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  if (upstream !== null && upstream !== '') candidates.push(upstream);

  const remoteHead = gitOutput(['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (remoteHead !== null && remoteHead !== '') {
    candidates.push(remoteHead.replace(/^refs\/remotes\//, ''));
  }
  candidates.push('origin/main', 'main');

  const base = candidates.find((candidate) => refExists(candidate));
  if (base === undefined) {
    throw new Error(
      'Unable to resolve a merge base. Pass a base ref or set FALLOW_AUDIT_BASE.',
    );
  }

  const mergeBase = gitOutput(['merge-base', 'HEAD', base]);
  if (mergeBase === null || mergeBase === '')
    throw new Error(`Unable to compute the merge base for ${base}.`);
  return { base, mergeBase };
};
