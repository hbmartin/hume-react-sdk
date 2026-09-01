import { describe, expect, it, vi } from 'vitest';

import {
  getBrowserErrorMessage,
  getBrowserErrorName,
  normalizeBrowserError,
} from './browserErrors';

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

  it('reads native DOMException accessors without using instance overrides', () => {
    const error = new DOMException('Microphone denied', 'NotAllowedError');
    const accessor = vi.fn(() => {
      throw new Error('Instance accessor should not run');
    });
    Object.defineProperties(error, {
      message: { configurable: true, get: accessor },
      name: { configurable: true, get: accessor },
    });

    expect(getBrowserErrorName(error)).toBe('NotAllowedError');
    expect(getBrowserErrorMessage(error)).toBe('Microphone denied');
    expect(accessor).not.toHaveBeenCalled();
  });

  it('does not invoke accessors on browser-shaped failures', () => {
    const accessor = vi.fn(() => 'unsafe');
    const error = {};
    Object.defineProperties(error, {
      message: { get: accessor },
      name: { get: accessor },
    });

    expect(getBrowserErrorName(error)).toBeNull();
    expect(getBrowserErrorMessage(error)).toBeNull();
    expect(accessor).not.toHaveBeenCalled();
  });
});
