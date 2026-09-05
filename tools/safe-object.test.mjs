import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getOwnValue } from './safe-object.mjs';

void test('getOwnValue tolerates descriptor traps', () => {
  const value = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('descriptor trap');
      },
    },
  );

  assert.equal(getOwnValue(value, 'key'), undefined);
});

void test('getOwnValue rejects non-object values', () => {
  for (const value of [
    null,
    undefined,
    1,
    'value',
    true,
    Symbol('value'),
    1n,
  ]) {
    assert.throws(
      () => Reflect.apply(getOwnValue, undefined, [value, 'key']),
      TypeError,
    );
  }
});
