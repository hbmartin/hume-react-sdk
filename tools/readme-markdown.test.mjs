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

await test('fenced JSX remains unchanged', () => {
  const example = ['```tsx', '<Button>Open</Button>', '```'].join('\n');

  assert.equal(makeReadmeVitePressSafe(example), example);
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
