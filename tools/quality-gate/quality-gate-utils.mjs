import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPnpmInvocation } from '../pnpm-command.mjs';

export const repositoryRoot = resolve(import.meta.dirname, '../..');

/** @param {unknown} error */
const isMissingPathError = (error) =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/**
 * @param {string | undefined} executablePath
 * @param {string} moduleUrl
 */
export const isDirectExecution = (executablePath, moduleUrl) => {
  if (executablePath === undefined || executablePath === '') return false;
  const resolvedExecutablePath = resolve(executablePath);
  const modulePath = fileURLToPath(moduleUrl);
  if (resolvedExecutablePath === modulePath) return true;

  let executableRealPath;
  try {
    executableRealPath = realpathSync(resolvedExecutablePath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  return executableRealPath === realpathSync(modulePath);
};

/** @param {string} path */
export const readJson = (path) =>
  /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')));

/**
 * @param {string} source
 * @param {(source: string, index: number) => { nextIndex: number, text: string } | null} transformOutsideString
 */
const transformOutsideJsonStrings = (source, transformOutsideString) => {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (inString) {
      output += character;
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
      output += character;
      continue;
    }
    const transformed = transformOutsideString(source, index);
    if (transformed === null) {
      output += character;
    } else {
      output += transformed.text;
      index = transformed.nextIndex;
    }
  }
  return output;
};

/**
 * @param {string} source
 * @param {number} index
 */
const stripJsonComment = (source, index) => {
  if (source.charAt(index) !== '/') return null;
  const nextCharacter = source.charAt(index + 1);
  if (nextCharacter === '/') {
    let cursor = index;
    let replacement = '';
    while (cursor < source.length && source[cursor] !== '\n') {
      replacement += source[cursor] === '\r' ? '\r' : ' ';
      cursor += 1;
    }
    if (cursor < source.length) replacement += '\n';
    return { nextIndex: cursor, text: replacement };
  }
  if (nextCharacter !== '*') return null;

  let cursor = index;
  let replacement = '  ';
  cursor += 2;
  while (cursor < source.length) {
    const character = source.charAt(cursor);
    if (character === '*' && source.charAt(cursor + 1) === '/') {
      return { nextIndex: cursor + 1, text: `${replacement}  ` };
    }
    replacement += character === '\n' || character === '\r' ? character : ' ';
    cursor += 1;
  }
  throw new SyntaxError('Unterminated JSONC block comment.');
};

/**
 * @param {string} source
 * @param {number} index
 */
const stripTrailingComma = (source, index) => {
  if (source.charAt(index) !== ',') return null;
  let nextIndex = index + 1;
  while (/\s/u.test(source.charAt(nextIndex))) nextIndex += 1;
  const nextCharacter = source.charAt(nextIndex);
  return nextCharacter === '}' || nextCharacter === ']'
    ? { nextIndex: index, text: '' }
    : null;
};

/** @param {string} source */
export const parseJsonc = (source) => {
  const withoutComments = transformOutsideJsonStrings(source, stripJsonComment);
  const withoutTrailingCommas = transformOutsideJsonStrings(
    withoutComments,
    stripTrailingComma,
  );
  return JSON.parse(withoutTrailingCommas);
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

/**
 * @param {string[]} args
 * @param {{ capture?: boolean }} [options]
 */
export const runPnpm = (args, options = {}) => {
  const invocation = getPnpmInvocation(args);
  return run(invocation.command, invocation.arguments, options);
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

/**
 * @param {string[]} candidates
 * @param {string | null | undefined} candidate
 * @param {string} [prefix]
 */
const appendAuditBaseCandidate = (candidates, candidate, prefix = '') => {
  if (candidate === undefined || candidate === null || candidate === '') return;
  candidates.push(`${prefix}${candidate}`);
};

/**
 * @param {{ explicitBase: string | undefined, configuredBase: string | undefined, githubBase: string | undefined, remoteHead: string | null | undefined }} options
 */
export const getAuditBaseCandidates = ({
  explicitBase,
  configuredBase,
  githubBase,
  remoteHead,
}) => {
  /** @type {string[]} */
  const candidates = [];
  appendAuditBaseCandidate(candidates, explicitBase);
  appendAuditBaseCandidate(candidates, configuredBase);
  appendAuditBaseCandidate(candidates, githubBase, 'origin/');
  appendAuditBaseCandidate(
    candidates,
    remoteHead?.replace(/^refs\/remotes\//, ''),
  );
  candidates.push('origin/main', 'main');
  return candidates;
};

/** @param {string | undefined} explicitBase */
export const resolveAuditBase = (explicitBase) => {
  const configuredBase = process.env['FALLOW_AUDIT_BASE'];
  const githubBase = process.env['GITHUB_BASE_REF'];
  const remoteHead = gitOutput(['symbolic-ref', 'refs/remotes/origin/HEAD']);
  const candidates = getAuditBaseCandidates({
    configuredBase,
    explicitBase,
    githubBase,
    remoteHead,
  });

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
