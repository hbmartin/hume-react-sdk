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

await test('fenced JSX remains unchanged', () => {
  const example = ['```tsx', '<Button>Open</Button>', '```'].join('\n');

  assert.equal(makeReadmeVitePressSafe(example), example);
});
