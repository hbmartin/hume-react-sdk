import assert from 'node:assert/strict';
import test from 'node:test';

import { makeReadmeVitePressSafe } from './readme-markdown.mjs';

await test('raw HTML package headers remain intact', () => {
  const header = [
    '<div align="center">',
    '  <h1>@humeai/voice-react</h1>',
    '  <p>',
    '    <strong>Voice SDK</strong>',
    '  </p>',
    '</div>',
  ].join('\n');

  assert.equal(makeReadmeVitePressSafe(header), header);
});

await test('type-like angle brackets outside code fences remain escaped', () => {
  assert.equal(
    makeReadmeVitePressSafe('#### `disconnect`: () => Promise<void>'),
    '#### `disconnect`: () =&gt; Promise&lt;void&gt;',
  );
});

await test('inline code spans preserve angle brackets', () => {
  assert.equal(
    makeReadmeVitePressSafe(
      'Use `Promise<Result>` when a factory returns Promise<Result>.',
    ),
    'Use `Promise<Result>` when a factory returns Promise&lt;Result&gt;.',
  );
});

await test('inline code spans with matching multi-backtick delimiters remain unchanged', () => {
  assert.equal(
    makeReadmeVitePressSafe('Use ``Map<`key`, Value>`` with Map<Key, Value>.'),
    'Use ``Map<`key`, Value>`` with Map&lt;Key, Value&gt;.',
  );
});

await test('unmatched inline-code delimiters remain ordinary text without stalling', () => {
  assert.equal(
    makeReadmeVitePressSafe('Keep an unmatched ` at the end'),
    'Keep an unmatched ` at the end',
  );
  assert.equal(
    makeReadmeVitePressSafe('Keep unmatched ``ticks and `Promise<Result>`.'),
    'Keep unmatched ``ticks and `Promise<Result>`.',
  );
});

await test('fenced JSX remains unchanged', () => {
  const example = ['```tsx', '<Button>Open</Button>', '```'].join('\n');

  assert.equal(makeReadmeVitePressSafe(example), example);
});

await test('sibling-document references inside code remain unchanged', () => {
  const fenced = ['```md', './MIGRATION.md', '```'].join('\n');
  const indented = [
    '    ./MIGRATION.md',
    '    const result: Promise<Result> = load();',
    'Outside Promise<Result>.',
  ].join('\n');

  assert.equal(makeReadmeVitePressSafe(fenced), fenced);
  assert.equal(
    makeReadmeVitePressSafe(indented),
    [
      '    ./MIGRATION.md',
      '    const result: Promise<Result> = load();',
      'Outside Promise&lt;Result&gt;.',
    ].join('\n'),
  );
  assert.equal(
    makeReadmeVitePressSafe('Use `./MIGRATION.md` as the example path.'),
    'Use `./MIGRATION.md` as the example path.',
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
    makeReadmeVitePressSafe(example),
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
    makeReadmeVitePressSafe(example),
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
    makeReadmeVitePressSafe(example),
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
    makeReadmeVitePressSafe(example),
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
    makeReadmeVitePressSafe(example),
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
    makeReadmeVitePressSafe('See the [migration guide](./MIGRATION.md).'),
    'See the [migration guide](/guide/migration).',
  );
  assert.equal(
    makeReadmeVitePressSafe(
      '<a href="./MIGRATION.md">Read the migration guide</a>',
    ),
    '<a href="/guide/migration">Read the migration guide</a>',
  );
});

await test('links to other files are left alone', () => {
  const unchanged = 'See [the renderer](https://example.com/MIGRATION.md).';
  assert.equal(makeReadmeVitePressSafe(unchanged), unchanged);
});
