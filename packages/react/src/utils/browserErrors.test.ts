import { describe, expect, it } from 'vitest';

import { getBrowserErrorMessage, normalizeBrowserError } from './browserErrors';

describe('browser error normalization', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', ' \n\t '],
  ])('treats an %s browser error message as unavailable', (_label, message) => {
    expect(getBrowserErrorMessage({ message })).toBeNull();
  });

  it.each([
    [
      'native',
      () => {
        const error = new Error('');
        error.name = 'NotReadableError';
        return error;
      },
    ],
    ['cross-realm-shaped', () => ({ message: '', name: 'NotReadableError' })],
  ])(
    'uses the fallback for a %s error with an empty message',
    (_label, makeError) => {
      expect(
        normalizeBrowserError(makeError(), 'Microphone unavailable'),
      ).toMatchObject({
        message: 'Microphone unavailable',
        name: 'NotReadableError',
      });
    },
  );
});
