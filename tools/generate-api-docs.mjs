import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeVitePressUnsafeMarkdown } from './markdown-to-vitepress.mjs';
import { getPnpmInvocation } from './pnpm-command.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedRoot = join(repositoryRoot, 'docs', '.generated');
const apiModelDirectory = join(generatedRoot, 'api-model');
const apiReferenceDirectory = join(repositoryRoot, 'docs', 'reference', 'api');
const guideDirectory = join(repositoryRoot, 'docs', 'guide');
const migrationGuidePath = join(guideDirectory, 'migration.md');

// Package guides are hand-written at `docs/guide/<package>.md`. This script
// only produces the API reference and the migration guide; package READMEs are
// npm landing pages and are no longer republished to the site.
const packages = [
  { directory: 'packages/embed', model: 'voice-embed.api.json' },
  { directory: 'packages/embed-react', model: 'voice-embed-react.api.json' },
  { directory: 'packages/react', model: 'voice-react.api.json' },
];

/**
 * @param {string} command
 * @param {readonly string[]} arguments_
 * @returns {Promise<void>}
 */
function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const reason = signal === null ? `exit code ${code}` : `signal ${signal}`;
      reject(
        new Error(`${command} ${arguments_.join(' ')} failed with ${reason}`),
      );
    });
  });
}

/** @param {readonly string[]} arguments_ */
function runPnpm(arguments_) {
  const invocation = getPnpmInvocation(arguments_);
  return run(invocation.command, invocation.arguments);
}

async function makeMarkdownVitePressSafe() {
  const entries = await readdir(apiReferenceDirectory, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map(async (entry) => {
        const path = join(apiReferenceDirectory, entry.name);
        const markdown = await readFile(path, 'utf8');
        const normalized = markdown.replaceAll('\r\n', '\n');
        const sanitized = normalized.replace(
          /<table>[\s\S]*?<\/table>/gu,
          (table) => table.replaceAll('{', '&#123;').replaceAll('}', '&#125;'),
        );

        await writeFile(path, sanitized);
      }),
  );
}

async function writeMigrationGuide() {
  await mkdir(guideDirectory, { recursive: true });

  const migration = await readFile(
    join(repositoryRoot, 'packages/react/MIGRATION.md'),
    'utf8',
  );
  const frontmatter = [
    '---',
    'description: "Breaking changes and upgrade steps for @humeai/voice-react."',
    'title: "Migrating versions"',
    '---',
    '',
  ].join('\n');

  await writeFile(
    migrationGuidePath,
    `${frontmatter}${escapeVitePressUnsafeMarkdown(migration)}`,
  );
}

await rm(generatedRoot, { force: true, recursive: true });
await rm(migrationGuidePath, { force: true });
await mkdir(apiModelDirectory, { recursive: true });
await writeMigrationGuide();

for (const package_ of packages) {
  const configuration = join(package_.directory, 'api-extractor.json');
  await runPnpm(['exec', 'api-extractor', 'run', '--config', configuration]);

  await copyFile(
    join(repositoryRoot, package_.directory, '.api-extractor', package_.model),
    join(apiModelDirectory, package_.model),
  );
}

await runPnpm([
  'exec',
  'api-documenter',
  'markdown',
  '--input-folder',
  apiModelDirectory,
  '--output-folder',
  apiReferenceDirectory,
]);

// API Documenter renders complex object types as plain text inside raw HTML
// tables. Vue treats braces in those cells as template syntax, so encode them
// in generated output before VitePress compiles the Markdown.
await makeMarkdownVitePressSafe();
