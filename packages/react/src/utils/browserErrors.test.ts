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

  it('reads native DOMException accessors across realms', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    try {
      const ForeignDOMException = (
        frame.contentWindow as unknown as {
          DOMException?: typeof DOMException;
        } | null
      )?.DOMException;
      if (ForeignDOMException === undefined) {
        throw new Error('Expected an iframe DOMException constructor.');
      }
      const error = new ForeignDOMException(
        'Microphone denied in iframe',
        'NotAllowedError',
      );

      expect(error).not.toBeInstanceOf(DOMException);
      expect(getBrowserErrorName(error)).toBe('NotAllowedError');
      expect(getBrowserErrorMessage(error)).toBe('Microphone denied in iframe');
    } finally {
      frame.remove();
    }
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

  it('captures DOMException accessors when the global appears after import', async () => {
    const NativeDOMException = DOMException;
    vi.resetModules();
    vi.stubGlobal('DOMException', undefined);
    try {
      const deferredBrowserErrors = await import('./browserErrors.js');
      vi.stubGlobal('DOMException', NativeDOMException);
      const error = new NativeDOMException(
        'Microphone denied after initialization',
        'NotAllowedError',
      );

      expect(deferredBrowserErrors.getBrowserErrorName(error)).toBe(
        'NotAllowedError',
      );
      expect(deferredBrowserErrors.getBrowserErrorMessage(error)).toBe(
        'Microphone denied after initialization',
      );
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('retries accessor capture after a partial DOMException global', async () => {
    const NativeDOMException = DOMException;
    class PartialDOMException {
      get name() {
        return 'PartialError';
      }
    }

    vi.resetModules();
    vi.stubGlobal('DOMException', PartialDOMException);
    try {
      const deferredBrowserErrors = await import('./browserErrors.js');
      expect(
        deferredBrowserErrors.getBrowserErrorName(new PartialDOMException()),
      ).toBe('PartialError');

      vi.stubGlobal('DOMException', NativeDOMException);
      const error = new NativeDOMException(
        'Microphone denied after polyfill replacement',
        'NotAllowedError',
      );
      expect(deferredBrowserErrors.getBrowserErrorName(error)).toBe(
        'NotAllowedError',
      );
      expect(deferredBrowserErrors.getBrowserErrorMessage(error)).toBe(
        'Microphone denied after polyfill replacement',
      );
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('caches DOMException brand checks for repeated objects', async () => {
    let nameReads = 0;
    class CountingDOMException {
      readonly #name: string;

      constructor(name: string) {
        this.#name = name;
      }

      get name() {
        nameReads += 1;
        return this.#name;
      }
    }

    vi.resetModules();
    vi.stubGlobal('DOMException', CountingDOMException);
    try {
      const deferredBrowserErrors = await import('./browserErrors.js');
      const error = new CountingDOMException('AbortError');
      const ordinary = {};

      expect(deferredBrowserErrors.isNativeDomException(error)).toBe(true);
      expect(deferredBrowserErrors.getBrowserErrorName(error)).toBe(
        'AbortError',
      );
      expect(deferredBrowserErrors.isNativeDomException(ordinary)).toBe(false);
      expect(deferredBrowserErrors.isNativeDomException(ordinary)).toBe(false);
      expect(deferredBrowserErrors.getBrowserErrorName(ordinary)).toBeNull();
      expect(nameReads).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
