import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the VitePress sidebar for the generated API reference.
 *
 * API Documenter emits one flat Markdown file per exported symbol, with no
 * navigation of its own. This derives a grouped sidebar from the same API models
 * the documenter reads, so the two cannot drift.
 *
 * @typedef {{ kind: string, name?: string, docComment?: string, overloadIndex?: number, members?: ApiMember[] }} ApiMember
 * @typedef {{ name: string, members: ApiMember[] }} ApiModel
 * @typedef {{ text: string, link: string, deprecated: boolean, kind: string }} SidebarEntry
 * @typedef {{ text: string, link?: string, base?: string, collapsed?: boolean, items?: SidebarItem[] }} SidebarItem
 */

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where `tools/generate-api-docs.mjs` copies the per-package API models. */
export const defaultApiModelDirectory = join(
  repositoryRoot,
  'docs',
  '.generated',
  'api-model',
);

/** Route prefix the generated reference pages are served from. */
export const apiReferenceBase = '/reference/api/';

/**
 * Models in the order they should appear. `voice-react` leads because it is the
 * package most readers arrive for.
 */
const API_MODEL_FILES = [
  'voice-react.api.json',
  'voice-embed-react.api.json',
  'voice-embed.api.json',
];

/**
 * Section labels by API item kind, in API Documenter's own table order so the
 * sidebar and the package page agree. A kind absent from this map gets no page
 * of its own and is skipped.
 *
 * @type {ReadonlyMap<string, string>}
 */
const KIND_GROUPS = new Map([
  ['Class', 'Classes'],
  ['Enum', 'Enumerations'],
  ['Function', 'Functions'],
  ['Interface', 'Interfaces'],
  ['Variable', 'Variables'],
  ['TypeAlias', 'Type aliases'],
]);

/** Packages smaller than this render as one flat list instead of kind groups. */
const KIND_GROUP_THRESHOLD = 10;

const DEPRECATED_GROUP = 'Deprecated';

/**
 * Mirrors `Utilities.getSafeFilenameForName` in `@microsoft/api-documenter`.
 *
 * @param {string} name
 */
function toSafeFilename(name) {
  return name.replaceAll(/[^a-z0-9_\-.]/giu, '_').toLowerCase();
}

/**
 * Mirrors `PackageName.getUnscopedName`.
 *
 * @param {string} packageName
 */
function toUnscopedName(packageName) {
  return packageName.startsWith('@')
    ? packageName.slice(packageName.indexOf('/') + 1)
    : packageName;
}

/**
 * API Documenter names a handful of unnamed members after their syntax rather
 * than an identifier. Only `Constructor` occurs in this repository, but the
 * others are cheap to mirror and prevent a silent mismatch later.
 *
 * @param {ApiMember} member
 */
function toDisplayName(member) {
  switch (member.kind) {
    case 'Constructor': {
      return '(constructor)';
    }
    case 'ConstructSignature': {
      return '(new)';
    }
    case 'CallSignature': {
      return '(call)';
    }
    case 'IndexSignature': {
      return '(:index)';
    }
    default: {
      return member.name ?? '';
    }
  }
}

/**
 * The page filename API Documenter emits for a top-level export, without its
 * `.md` extension.
 *
 * @param {string} packageBase
 * @param {ApiMember} member
 */
function toPageSlug(packageBase, member) {
  const overloadIndex = member.overloadIndex ?? 1;
  const suffix = overloadIndex > 1 ? `_${overloadIndex - 1}` : '';
  return `${packageBase}.${toSafeFilename(toDisplayName(member))}${suffix}`;
}

/**
 * Locale-independent so Linux and Windows runners produce identical output.
 *
 * @param {{ text: string }} a
 * @param {{ text: string }} b
 */
function byDisplayName(a, b) {
  const left = a.text.toLowerCase();
  const right = b.text.toLowerCase();
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Match a real TSDoc block tag, not prose or code that mentions `@deprecated`.
 *
 * @param {string | undefined} docComment
 */
function hasDeprecatedTag(docComment) {
  return /^\s*\*\s*@deprecated(?:\s|$)/mu.test(docComment ?? '');
}

/**
 * Collects the top-level exports of one model as sidebar-ready entries.
 *
 * API Documenter derives filenames case-insensitively, so a type alias and a
 * variable sharing a name collapse onto one page (rushstack#1308). It writes
 * them in model order and the last one wins, so dedupe the same way: the
 * sidebar then names the page a reader actually lands on.
 *
 * @param {ApiModel} model
 */
function collectEntries(model) {
  const packageBase = toSafeFilename(toUnscopedName(model.name));
  /** @type {Map<string, SidebarEntry>} */
  const entries = new Map();

  // Entry points contribute no path segment. Flatten all of them so a package
  // remains complete if API Extractor adds secondary entry-point support.
  const members = model.members.flatMap(
    (entryPoint) => entryPoint.members ?? [],
  );
  for (const member of members) {
    if (!KIND_GROUPS.has(member.kind)) continue;

    const link = toPageSlug(packageBase, member);
    entries.set(link, {
      deprecated: hasDeprecatedTag(member.docComment),
      kind: member.kind,
      link,
      text: toDisplayName(member),
    });
  }

  return {
    entries: [...entries.values()],
    packageBase,
    packageName: model.name,
  };
}

/**
 * Renders current exports flat for small packages or grouped by kind for larger
 * ones.
 *
 * @param {SidebarEntry[]} entries
 * @returns {SidebarItem[]}
 */
function toLiveItems(entries) {
  const live = entries.filter((entry) => !entry.deprecated).sort(byDisplayName);

  if (entries.length < KIND_GROUP_THRESHOLD) {
    // Kind headers cost more than they explain for a two-export package.
    return live.map(({ link, text }) => ({ link, text }));
  }

  /** @type {SidebarItem[]} */
  const items = [];
  for (const [kind, label] of KIND_GROUPS) {
    const inKind = live.filter((entry) => entry.kind === kind);
    if (inKind.length === 0) continue;
    items.push({
      collapsed: true,
      items: inKind.map(({ link, text }) => ({ link, text })),
      text: label,
    });
  }
  return items;
}

/**
 * @param {SidebarEntry[]} entries
 * @returns {SidebarItem[]}
 */
function toDeprecatedItems(entries) {
  const deprecated = entries
    .filter((entry) => entry.deprecated)
    .sort(byDisplayName);

  return deprecated.length === 0
    ? []
    : [
        {
          collapsed: true,
          items: deprecated.map(({ link, text }) => ({ link, text })),
          text: DEPRECATED_GROUP,
        },
      ];
}

/**
 * @param {ReturnType<typeof collectEntries>} collected
 * @returns {SidebarItem}
 */
function toPackageSection({ entries, packageBase, packageName }) {
  return {
    base: apiReferenceBase,
    collapsed: true,
    items: [...toLiveItems(entries), ...toDeprecatedItems(entries)],
    link: packageBase,
    text: packageName,
  };
}

/**
 * Pure transform: API models in, sidebar out.
 *
 * @param {readonly ApiModel[]} models
 * @returns {SidebarItem[]}
 */
export function buildApiReferenceSidebar(models) {
  return [
    {
      items: [
        { link: '/reference/', text: 'Overview' },
        { link: `${apiReferenceBase}`, text: 'All packages' },
      ],
      text: 'API reference',
    },
    ...models.map((model) => toPackageSection(collectEntries(model))),
  ];
}

/**
 * Reads the generated API models and returns the complete sidebar for the
 * `/reference/api/` route.
 *
 * @param {string} [apiModelDirectory]
 * @returns {SidebarItem[]}
 */
export function readApiReferenceSidebar(
  apiModelDirectory = defaultApiModelDirectory,
) {
  const models = API_MODEL_FILES.map((file) => {
    const path = join(apiModelDirectory, file);
    let contents;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (error) {
      if (
        error instanceof Error &&
        /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
      ) {
        throw new Error(
          `Generated API model not found at ${path}. Run \`pnpm docs:api\` first, ` +
            'or use `pnpm docs:build` / `pnpm docs:dev`, which run it for you.',
          { cause: error },
        );
      }
      throw error;
    }

    return /** @type {ApiModel} */ (JSON.parse(contents));
  });

  return buildApiReferenceSidebar(models);
}
