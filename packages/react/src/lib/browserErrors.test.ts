import { describe, expect, it } from 'vitest';

import { getBrowserErrorMessage, normalizeBrowserError } from './browserErrors';

describe('browser error normalization', () => {
  it('treats an empty browser error message as unavailable', () => {
    expect(getBrowserErrorMessage({ message: '' })).toBeNull();
  });

  it('uses the fallback for a cross-realm-shaped error with an empty message', () => {
    expect(
      normalizeBrowserError(
        { message: '', name: 'NotReadableError' },
        'Microphone unavailable',
      ),
    ).toMatchObject({
      message: 'Microphone unavailable',
      name: 'NotReadableError',
    });
  });
});
