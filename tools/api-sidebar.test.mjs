// Page slugs are lowercased identifiers, so they read as unknown words.
// cspell:words audiodevice audioencoding exampleerror languagemodeloption ttsservice
// cspell:words usealpha usecurrent uselegacy usezulu widgetprops

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  apiReferenceBase,
  buildApiReferenceSidebar,
  defaultApiModelDirectory,
  readApiReferenceSidebar,
} from './api-sidebar.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const apiReferenceDirectory = join(repositoryRoot, 'docs', 'reference', 'api');

/**
 * Page filenames that two exports collapse onto, because API Documenter derives
 * filenames case-insensitively and writes the last one to win (rushstack#1308).
 * Pinned so a newly introduced collision fails here instead of silently
 * dropping a sidebar entry.
 */
const EXPECTED_COLLISIONS = ['voice-embed.languagemodeloption'];

/**
 * Minimal stand-ins for `docs/.generated/api-model/*.api.json`. Inline rather
 * than fixture files so cspell and oxfmt do not pick up a synthetic JSON blob.
 *
 * @param {string} name
 * @param {ApiTestMember[]} members
 */
function model(name, members) {
  return {
    kind: 'Package',
    members: [{ kind: 'EntryPoint', members, name: '' }],
    name,
  };
}

await test('exports are grouped by kind and sorted within each group', () => {
  const sidebar = buildApiReferenceSidebar([
    model('@humeai/scoped-example', [
      { kind: 'Function', name: 'useZulu' },
      { kind: 'Function', name: 'useAlpha' },
      { kind: 'Class', name: 'ExampleError' },
      { kind: 'Enum', name: 'ReadyState' },
      { kind: 'Interface', name: 'Options' },
      { kind: 'Variable', name: 'Provider' },
      { kind: 'TypeAlias', name: 'Handler' },
      { kind: 'TypeAlias', name: 'Message' },
      { kind: 'TypeAlias', name: 'Status' },
      { kind: 'TypeAlias', name: 'Reason' },
    ]),
  ]);

  assert.deepEqual(sidebar[1], {
    base: '/reference/api/',
    collapsed: true,
    items: [
      {
        collapsed: true,
        items: [{ link: 'scoped-example.exampleerror', text: 'ExampleError' }],
        text: 'Classes',
      },
      {
        collapsed: true,
        items: [{ link: 'scoped-example.readystate', text: 'ReadyState' }],
        text: 'Enumerations',
      },
      {
        collapsed: true,
        items: [
          { link: 'scoped-example.usealpha', text: 'useAlpha' },
          { link: 'scoped-example.usezulu', text: 'useZulu' },
        ],
        text: 'Functions',
      },
      {
        collapsed: true,
        items: [{ link: 'scoped-example.options', text: 'Options' }],
        text: 'Interfaces',
      },
      {
        collapsed: true,
        items: [{ link: 'scoped-example.provider', text: 'Provider' }],
        text: 'Variables',
      },
      {
        collapsed: true,
        items: [
          { link: 'scoped-example.handler', text: 'Handler' },
          { link: 'scoped-example.message', text: 'Message' },
          { link: 'scoped-example.reason', text: 'Reason' },
          { link: 'scoped-example.status', text: 'Status' },
        ],
        text: 'Type aliases',
      },
    ],
    link: 'scoped-example',
    text: '@humeai/scoped-example',
  });
});

await test('the overview group leads the sidebar', () => {
  const sidebar = buildApiReferenceSidebar([]);

  assert.deepEqual(sidebar, [
    {
      items: [
        { link: '/reference/', text: 'Overview' },
        { link: '/reference/api/', text: 'All packages' },
      ],
      text: 'API reference',
    },
  ]);
});

await test('small packages render flat, without kind headers', () => {
  const sidebar = buildApiReferenceSidebar([
    model('@humeai/tiny', [
      { kind: 'TypeAlias', name: 'WidgetProps' },
      { kind: 'Function', name: 'Widget' },
    ]),
  ]);

  assert.deepEqual(sidebar[1]?.items, [
    { link: 'tiny.widget', text: 'Widget' },
    { link: 'tiny.widgetprops', text: 'WidgetProps' },
  ]);
});

await test('deprecated exports move to a single trailing group', () => {
  /** @type {ApiTestMember[]} */
  const members = [
    {
      docComment: '/**\n * @deprecated Use `useVoice`.\n */\n',
      kind: 'Function',
      name: 'useLegacy',
    },
    { kind: 'Function', name: 'useCurrent' },
  ];
  for (let index = 0; index < 8; index += 1) {
    members.push({ kind: 'TypeAlias', name: `Filler${index}` });
  }

  const section = buildApiReferenceSidebar([model('@humeai/dep', members)])[1];
  assert.notEqual(section, undefined);
  const groups = section?.items ?? [];
  const trailing = groups[groups.length - 1];
  assert.notEqual(trailing, undefined);

  assert.equal(trailing?.text, 'Deprecated');
  assert.deepEqual(trailing.items, [
    { link: 'dep.uselegacy', text: 'useLegacy' },
  ]);
  assert.deepEqual(groups.find((group) => group.text === 'Functions')?.items, [
    { link: 'dep.usecurrent', text: 'useCurrent' },
  ]);
});

await test('an empty deprecated group is omitted entirely', () => {
  const items = buildApiReferenceSidebar([
    model('@humeai/tiny', [{ kind: 'Function', name: 'Widget' }]),
  ])[1]?.items;

  assert.equal(
    items?.some((item) => item.text === 'Deprecated'),
    false,
  );
});

await test('mentioning the deprecated tag in prose keeps an export live', () => {
  const items = buildApiReferenceSidebar([
    model('@humeai/tiny', [
      {
        docComment: '/**\n * Explains the literal `@deprecated` tag.\n */\n',
        kind: 'Function',
        name: 'Widget',
      },
    ]),
  ])[1]?.items;

  assert.deepEqual(items, [{ link: 'tiny.widget', text: 'Widget' }]);
});

await test('colliding filenames keep the last export, as API Documenter does', () => {
  const items = buildApiReferenceSidebar([
    model('@humeai/tiny', [
      { kind: 'TypeAlias', name: 'AudioEncoding' },
      { kind: 'Variable', name: 'AudioEncoding' },
    ]),
  ])[1]?.items;

  // One entry, not two, and it is the Variable that actually owns the page.
  assert.deepEqual(items, [
    { link: 'tiny.audioencoding', text: 'AudioEncoding' },
  ]);
});

await test('unnamed and overloaded members mirror API Documenter filenames', () => {
  const items = buildApiReferenceSidebar([
    model('@humeai/tiny', [
      { kind: 'Function', name: 'render', overloadIndex: 1 },
      { kind: 'Function', name: 'render', overloadIndex: 2 },
    ]),
  ])[1]?.items;

  assert.deepEqual(items, [
    { link: 'tiny.render', text: 'render' },
    { link: 'tiny.render_1', text: 'render' },
  ]);
});

await test('members without a page of their own are skipped', () => {
  const items = buildApiReferenceSidebar([
    model('@humeai/tiny', [
      { kind: 'Enum', name: 'ReadyState' },
      // Enum members render inline in the enum's table; they get no page.
      { kind: 'EnumMember', name: 'Open' },
    ]),
  ])[1]?.items;

  assert.deepEqual(items, [{ link: 'tiny.readystate', text: 'ReadyState' }]);
});

await test('empty package models render an empty section', () => {
  const emptyModel = model('@humeai/empty', []);
  emptyModel.members = [];

  assert.deepEqual(buildApiReferenceSidebar([emptyModel])[1]?.items, []);
});

await test('exports from every entry point are included', () => {
  const multipleEntryPoints = model('@humeai/tiny', [
    { kind: 'Function', name: 'First' },
  ]);
  multipleEntryPoints.members.push({
    kind: 'EntryPoint',
    members: [{ kind: 'Function', name: 'Second' }],
    name: './secondary',
  });

  assert.deepEqual(buildApiReferenceSidebar([multipleEntryPoints])[1]?.items, [
    { link: 'tiny.first', text: 'First' },
    { link: 'tiny.second', text: 'Second' },
  ]);
});

await test('a missing API model names the command that generates it', () => {
  assert.throws(
    () => readApiReferenceSidebar(join(repositoryRoot, 'does-not-exist')),
    /Run `pnpm docs:api` first/u,
  );
});

const generatedOutputExists =
  existsSync(apiReferenceDirectory) && existsSync(defaultApiModelDirectory);
const generatedOutputRequired =
  process.env['REQUIRE_GENERATED_API_OUTPUT'] === 'true';
const skipWithoutGeneratedOutput = generatedOutputExists
  ? false
  : 'run `pnpm docs:api` first';

await test(
  'generated API output exists when the environment requires it',
  { skip: !generatedOutputRequired },
  () => {
    assert.equal(
      generatedOutputExists,
      true,
      'generated API output is required; run `pnpm docs:api` first',
    );
  },
);

/**
 * Every `link` in the sidebar, with each item's inherited `base` applied.
 *
 * @param {readonly import('./api-sidebar.mjs').SidebarItem[]} items
 * @param {string} inheritedBase
 * @returns {string[]}
 */
function collectLinks(items, inheritedBase = '') {
  return items.flatMap((item) => {
    const base = item.base ?? inheritedBase;
    return [
      ...(item.link === undefined
        ? []
        : [`${item.link.startsWith('/') ? '' : base}${item.link}`]),
      ...collectLinks(item.items ?? [], base),
    ];
  });
}

/**
 * The generated models, read independently of the module under test so the
 * assertions below are a real cross-check rather than a restatement.
 *
 * @returns {import('./api-sidebar.mjs').ApiModel[]}
 */
function readModels() {
  return [
    'voice-react.api.json',
    'voice-embed-react.api.json',
    'voice-embed.api.json',
  ].map(
    (file) =>
      /** @type {import('./api-sidebar.mjs').ApiModel} */ (
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- API Extractor owns and validates these generated test inputs
        JSON.parse(readFileSync(join(defaultApiModelDirectory, file), 'utf8'))
      ),
  );
}

/**
 * Page slugs API Documenter emits for a package and its top-level exports.
 * Deliberately re-derived from the naming rule rather than imported.
 *
 * @returns {string[]}
 */
function readTopLevelPageSlugs(models = readModels()) {
  return models.flatMap((parsed) => {
    const base = parsed.name.slice(parsed.name.indexOf('/') + 1);
    const members = parsed.members.flatMap(
      (entryPoint) => entryPoint.members ?? [],
    );
    return [
      base,
      ...members.map((member) => {
        const overloadIndex = member.overloadIndex ?? 1;
        const suffix = overloadIndex > 1 ? `_${overloadIndex - 1}` : '';
        return `${base}.${toSlug(member.name ?? '')}${suffix}`;
      }),
    ];
  });
}

/** @param {string} name */
function toSlug(name) {
  return name.replaceAll(/[^a-z0-9_\-.]/giu, '_').toLowerCase();
}

await test('the page cross-check does not filter unfamiliar top-level kinds', () => {
  assert.deepEqual(
    readTopLevelPageSlugs([
      model('@humeai/tiny', [{ kind: 'Namespace', name: 'Tools' }]),
    ]),
    ['tiny', 'tiny.tools'],
  );
});

/** @typedef {{ kind: string, name?: string, docComment?: string, overloadIndex?: number, members?: ApiTestMember[] }} ApiTestMember */

await test(
  'every sidebar link resolves to a generated page',
  { skip: skipWithoutGeneratedOutput },
  () => {
    // Bare filenames only: `windows-tools` runs this suite on Windows, where
    // path separators would otherwise diverge.
    const emitted = new Set(
      readdirSync(apiReferenceDirectory).filter((name) => name.endsWith('.md')),
    );

    for (const link of collectLinks(readApiReferenceSidebar())) {
      if (link === '/reference/') {
        assert.ok(
          existsSync(join(repositoryRoot, 'docs', 'reference', 'index.md')),
          'the reference overview page is missing',
        );
        continue;
      }

      assert.ok(
        link.startsWith(apiReferenceBase),
        `sidebar link ${link} is outside ${apiReferenceBase}`,
      );
      const slug = link.slice(apiReferenceBase.length);
      const file = slug === '' ? 'index.md' : `${slug}.md`;
      assert.ok(emitted.has(file), `sidebar link ${link} has no page ${file}`);
    }
  },
);

await test(
  'every top-level export is reachable from the sidebar',
  { skip: skipWithoutGeneratedOutput },
  () => {
    const linked = new Set(
      collectLinks(readApiReferenceSidebar())
        .filter((link) => link.startsWith(apiReferenceBase))
        .map((link) => link.slice(apiReferenceBase.length))
        .filter((slug) => slug !== ''),
    );

    // Derived from the models rather than from the sidebar, so this actually
    // catches an export the generator drops. Member pages
    // (`voice-react.audiodevice.deviceid`) are deliberately not linked: they
    // are reachable from the parent page's table and from the page outline.
    for (const slug of readTopLevelPageSlugs()) {
      assert.ok(linked.has(slug), `${slug} is emitted but not linked`);
    }
  },
);

await test(
  'the set of colliding page filenames has not changed',
  { skip: skipWithoutGeneratedOutput },
  () => {
    /** @type {Map<string, number>} */
    const counts = new Map();

    for (const slug of readTopLevelPageSlugs()) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }

    const collisions = [...counts]
      .filter(([, count]) => count > 1)
      .map(([slug]) => slug)
      .sort();

    assert.deepEqual(
      collisions,
      EXPECTED_COLLISIONS,
      'update EXPECTED_COLLISIONS when the public API changes',
    );
  },
);
