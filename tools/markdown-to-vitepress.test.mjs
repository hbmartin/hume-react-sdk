import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeVitePressUnsafeMarkdown } from './markdown-to-vitepress.mjs';

await test('raw HTML package headers remain intact', () => {
  const header = [
    '<div align="center">',
    '  <h1>@humeai/voice-react</h1>',
    '  <p>',
    '    <strong>Voice SDK</strong>',
    '  </p>',
    '</div>',
  ].join('\n');

  assert.equal(escapeVitePressUnsafeMarkdown(header), header);
});

await test('type-like angle brackets outside code fences remain escaped', () => {
  assert.equal(
    escapeVitePressUnsafeMarkdown('#### `disconnect`: () => Promise<void>'),
    '#### `disconnect`: () =&gt; Promise&lt;void&gt;',
  );
});

await test('inline code spans preserve angle brackets', () => {
  assert.equal(
    escapeVitePressUnsafeMarkdown(
      'Use `Promise<Result>` when a factory returns Promise<Result>.',
    ),
    'Use `Promise<Result>` when a factory returns Promise&lt;Result&gt;.',
  );
});

await test('inline code spans with matching multi-backtick delimiters remain unchanged', () => {
  assert.equal(
    escapeVitePressUnsafeMarkdown(
      'Use ``Map<`key`, Value>`` with Map<Key, Value>.',
    ),
    'Use ``Map<`key`, Value>`` with Map&lt;Key, Value&gt;.',
  );
});

await test('unmatched inline-code delimiters remain ordinary text without stalling', () => {
  assert.equal(
    escapeVitePressUnsafeMarkdown('Keep an unmatched ` at the end'),
    'Keep an unmatched ` at the end',
  );
  assert.equal(
    escapeVitePressUnsafeMarkdown(
      'Keep unmatched ``ticks and `Promise<Result>`.',
    ),
    'Keep unmatched ``ticks and `Promise<Result>`.',
  );
});

await test('fenced JSX remains unchanged', () => {
  const example = ['```tsx', '<Button>Open</Button>', '```'].join('\n');

  assert.equal(escapeVitePressUnsafeMarkdown(example), example);
});

await test('sibling-document references inside code remain unchanged', () => {
  const fenced = ['```md', './MIGRATION.md', '```'].join('\n');
  const indented = [
    '    ./MIGRATION.md',
    '    const result: Promise<Result> = load();',
    'Outside Promise<Result>.',
  ].join('\n');

  assert.equal(escapeVitePressUnsafeMarkdown(fenced), fenced);
  assert.equal(
    escapeVitePressUnsafeMarkdown(indented),
    [
      '    ./MIGRATION.md',
      '    const result: Promise<Result> = load();',
      'Outside Promise&lt;Result&gt;.',
    ].join('\n'),
  );
  assert.equal(
    escapeVitePressUnsafeMarkdown('Use `./MIGRATION.md` as the example path.'),
    'Use `./MIGRATION.md` as the example path.',
  );
});

await test('indented paragraph continuations are escaped instead of treated as code', () => {
  const example = [
    'A paragraph returning a value:',
    '    Promise<Result>',
    '',
    '    const result: Promise<Result> = load();',
  ].join('\n');

  assert.equal(
    escapeVitePressUnsafeMarkdown(example),
    [
      'A paragraph returning a value:',
      '    Promise&lt;Result&gt;',
      '',
      '    const result: Promise<Result> = load();',
    ].join('\n'),
  );
});

await test('indented code directly after setext headings remains unchanged', () => {
  for (const underline of ['===', '-']) {
    const example = [
      'A setext heading',
      underline,
      '    const result: Promise<Result> = load();',
    ].join('\n');

    assert.equal(escapeVitePressUnsafeMarkdown(example), example);
  }
});

await test('type-seven HTML does not interrupt paragraph continuation', () => {
  const example = [
    'A paragraph with inline HTML',
    '<em>',
    '    Promise<Result>',
  ].join('\n');

  assert.equal(
    escapeVitePressUnsafeMarkdown(example),
    ['A paragraph with inline HTML', '<em>', '    Promise&lt;Result&gt;'].join(
      '\n',
    ),
  );
});

await test('indented list-paragraph continuations are not code without a blank line', () => {
  const example = [
    '- A paragraph returning a value:',
    '      Promise<Result>',
  ].join('\n');

  assert.equal(
    escapeVitePressUnsafeMarkdown(example),
    ['- A paragraph returning a value:', '      Promise&lt;Result&gt;'].join(
      '\n',
    ),
  );
});

await test('fences indented inside list items remain unchanged', () => {
  const example = [
    '1. Load the value:',
    '    ```ts',
    '    const result: Promise<Result> = load();',
    '    ```',
    'Outside Promise<Result>.',
  ].join('\n');

  assert.equal(
    escapeVitePressUnsafeMarkdown(example),
    [
      '1. Load the value:',
      '    ```ts',
      '    const result: Promise<Result> = load();',
      '    ```',
      'Outside Promise&lt;Result&gt;.',
    ].join('\n'),
  );
});

await test('tab-indented fences inside list items remain unchanged', () => {
  const example = [
    '- Load the value:',
    '\t```ts',
    '\tconst result: Promise<Result> = load();',
    '\t```',
    'Outside Promise<Result>.',
  ].join('\n');

  assert.equal(
    escapeVitePressUnsafeMarkdown(example),
    [
      '- Load the value:',
      '\t```ts',
      '\tconst result: Promise<Result> = load();',
      '\t```',
      'Outside Promise&lt;Result&gt;.',
    ].join('\n'),
  );
});

await test('indented code-block markers do not open fenced code', () => {
  const example = ['    ```', '    - ```', 'Outside Promise<Result>.'].join(
    '\n',
  );

  assert.equal(
    escapeVitePressUnsafeMarkdown(example),
    ['    ```', '    - ```', 'Outside Promise&lt;Result&gt;.'].join('\n'),
  );
});

await test('tilde-fenced examples remain unchanged', () => {
  const example = [
    '~~~ts',
    'const result: Promise<Result> = load();',
    '~~~',
    'Outside Promise<Result>.',
  ].join('\n');

  assert.equal(
    escapeVitePressUnsafeMarkdown(example),
    [
      '~~~ts',
      'const result: Promise<Result> = load();',
      '~~~',
      'Outside Promise&lt;Result&gt;.',
    ].join('\n'),
  );
});

await test('shorter fence markers do not close a longer outer fence', () => {
  const example = [
    '````md',
    '```ts',
    'const result: Promise<Result> = load();',
    '```',
    '````',
    'Outside Promise<Result>.',
  ].join('\n');

  assert.equal(
    escapeVitePressUnsafeMarkdown(example),
    [
      '````md',
      '```ts',
      'const result: Promise<Result> = load();',
      '```',
      '````',
      'Outside Promise&lt;Result&gt;.',
    ].join('\n'),
  );
});

await test('relative sibling-document links point at their site routes', () => {
  assert.equal(
    escapeVitePressUnsafeMarkdown('See the [migration guide](./MIGRATION.md).'),
    'See the [migration guide](/guide/migration).',
  );
  assert.equal(
    escapeVitePressUnsafeMarkdown(
      '<a href="./MIGRATION.md">Read the migration guide</a>',
    ),
    '<a href="/guide/migration">Read the migration guide</a>',
  );
  assert.equal(
    escapeVitePressUnsafeMarkdown('<code>./MIGRATION.md</code>'),
    '<code>./MIGRATION.md</code>',
  );
  assert.equal(
    escapeVitePressUnsafeMarkdown('<code>href="./MIGRATION.md"</code>'),
    '<code>href="./MIGRATION.md"</code>',
  );
  assert.equal(
    escapeVitePressUnsafeMarkdown(
      ['<code>', 'href="./MIGRATION.md"', '</code>'].join('\n'),
    ),
    ['<code>', 'href="./MIGRATION.md"', '</code>'].join('\n'),
  );
  assert.equal(
    escapeVitePressUnsafeMarkdown(
      '<span>See the [migration guide](./MIGRATION.md).</span>',
    ),
    '<span>See the [migration guide](/guide/migration).</span>',
  );
  assert.equal(
    escapeVitePressUnsafeMarkdown(
      '<div data-example="./MIGRATION.md">Not a link</div>',
    ),
    '<div data-example="./MIGRATION.md">Not a link</div>',
  );
  for (const attribute of ['data-href', 'x-href', 'v-bind:href']) {
    const unchanged = `<div ${attribute}="./MIGRATION.md">Not a link</div>`;
    assert.equal(escapeVitePressUnsafeMarkdown(unchanged), unchanged);
  }
});

await test('links to other files are left alone', () => {
  const unchanged = 'See [the renderer](https://example.com/MIGRATION.md).';
  assert.equal(escapeVitePressUnsafeMarkdown(unchanged), unchanged);
});
