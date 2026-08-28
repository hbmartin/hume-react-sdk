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

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedRoot = join(repositoryRoot, 'docs', '.generated');
const apiModelDirectory = join(generatedRoot, 'api-model');
const apiReferenceDirectory = join(repositoryRoot, 'docs', 'reference', 'api');
const packageGuideDirectory = join(repositoryRoot, 'docs', 'packages');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const packages = [
  {
    description:
      "Hume's hosted voice widget for browser applications that do not use React.",
    directory: 'packages/embed',
    model: 'voice-embed.api.json',
    output: 'voice-embed.md',
    title: '@humeai/voice-embed',
  },
  {
    description: "Hume's hosted voice widget as a React component.",
    directory: 'packages/embed-react',
    model: 'voice-embed-react.api.json',
    output: 'voice-embed-react.md',
    title: '@humeai/voice-embed-react',
  },
  {
    description:
      'Headless hooks and components for building a custom React voice interface.',
    directory: 'packages/react',
    model: 'voice-react.api.json',
    output: 'voice-react.md',
    title: '@humeai/voice-react',
  },
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

async function writePackageGuides() {
  await mkdir(packageGuideDirectory, { recursive: true });

  await Promise.all(
    packages.map(async (package_) => {
      const readme = await readFile(
        join(repositoryRoot, package_.directory, 'README.md'),
        'utf8',
      );
      let insideCodeFence = false;
      const vitePressSafeReadme = readme
        .replaceAll('\r\n', '\n')
        .split('\n')
        .map((line) => {
          if (/^\s*`{3,}/u.test(line)) {
            insideCodeFence = !insideCodeFence;
            return line;
          }

          if (!insideCodeFence && /[A-Za-z0-9_.)\]]</u.test(line)) {
            return line.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
          }

          return line;
        })
        .join('\n');
      const frontmatter = [
        '---',
        `description: ${JSON.stringify(package_.description)}`,
        `title: ${JSON.stringify(package_.title)}`,
        '---',
        '',
      ].join('\n');

      await writeFile(
        join(packageGuideDirectory, package_.output),
        `${frontmatter}${vitePressSafeReadme}`,
      );
    }),
  );
}

await rm(generatedRoot, { force: true, recursive: true });
await mkdir(apiModelDirectory, { recursive: true });
await writePackageGuides();

for (const package_ of packages) {
  const configuration = join(package_.directory, 'api-extractor.json');
  await run(pnpmCommand, [
    'exec',
    'api-extractor',
    'run',
    '--config',
    configuration,
  ]);

  await copyFile(
    join(repositoryRoot, package_.directory, '.api-extractor', package_.model),
    join(apiModelDirectory, package_.model),
  );
}

await run(pnpmCommand, [
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
