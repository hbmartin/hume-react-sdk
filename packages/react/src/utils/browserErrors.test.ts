import { describe, expect, it, vi } from 'vitest';

import {
  getBrowserErrorMessage,
  getBrowserErrorName,
  isNativeDomException,
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
      expect(deferredBrowserErrors.getBrowserErrorName({})).toBeNull();

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

  it('retries accessor capture after a getter-less DOMException global', async () => {
    const NativeDOMException = DOMException;
    class PartialDOMException {}

    vi.resetModules();
    vi.stubGlobal('DOMException', PartialDOMException);
    try {
      const deferredBrowserErrors = await import('./browserErrors.js');
      expect(
        deferredBrowserErrors.getBrowserErrorName(new PartialDOMException()),
      ).toBeNull();

      vi.stubGlobal('DOMException', NativeDOMException);
      const error = new NativeDOMException(
        'Microphone denied after polyfill replacement',
        'NotAllowedError',
      );
      expect(deferredBrowserErrors.getBrowserErrorName(error)).toBe(
        'NotAllowedError',
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

  it('retries the same object after temporary getters reject it', async () => {
    const NativeDOMException = DOMException;
    class TemporaryDOMException {
      readonly #message = 'Temporary message';
      readonly #name = 'PartialError';

      get message() {
        return this.#message;
      }

      get name() {
        return this.#name;
      }
    }
    const error = new NativeDOMException(
      'Microphone denied after polyfill replacement',
      'NotAllowedError',
    );

    vi.resetModules();
    vi.stubGlobal('DOMException', TemporaryDOMException);
    try {
      const deferredBrowserErrors = await import('./browserErrors.js');
      expect(deferredBrowserErrors.getBrowserErrorName(error)).toBeNull();

      vi.stubGlobal('DOMException', NativeDOMException);
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

  it('caches failed DOMException probes per property', async () => {
    let messageReads = 0;
    class PartialDOMException {
      get message(): string {
        messageReads += 1;
        throw new Error('Message is unavailable');
      }

      get name() {
        return 'AbortError';
      }
    }

    vi.resetModules();
    vi.stubGlobal('DOMException', PartialDOMException);
    try {
      const deferredBrowserErrors = await import('./browserErrors.js');
      const error = new PartialDOMException();

      expect(deferredBrowserErrors.getBrowserErrorName(error)).toBe(
        'AbortError',
      );
      expect(deferredBrowserErrors.getBrowserErrorMessage(error)).toBeNull();
      expect(deferredBrowserErrors.getBrowserErrorName(error)).toBe(
        'AbortError',
      );
      expect(deferredBrowserErrors.getBrowserErrorMessage(error)).toBeNull();
      expect(messageReads).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('skips the sibling probe after a brand check throws', () => {
    let messageReads = 0;
    let nameReads = 0;
    class CountingDOMException {
      readonly #message = 'Counted message';
      readonly #name = 'AbortError';

      get message() {
        messageReads += 1;
        return this.#message;
      }

      get name() {
        nameReads += 1;
        return this.#name;
      }
    }

    vi.stubGlobal('DOMException', CountingDOMException);
    try {
      const ordinary = {};
      expect(getBrowserErrorName(ordinary)).toBeNull();
      expect(getBrowserErrorMessage(ordinary)).toBeNull();
      expect(nameReads).toBe(1);
      expect(messageReads).toBe(0);

      const error = new CountingDOMException();
      expect(getBrowserErrorName(error)).toBe('AbortError');
      expect(getBrowserErrorMessage(error)).toBe('Counted message');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps recognizing native DOMException objects after a subclass replaces the global', () => {
    const NativeDOMException = DOMException;
    const before = new NativeDOMException(
      'Microphone denied',
      'NotAllowedError',
    );
    expect(getBrowserErrorName(before)).toBe('NotAllowedError');

    vi.stubGlobal('DOMException', class extends NativeDOMException {});
    try {
      const after = new NativeDOMException(
        'Microphone denied after subclass replacement',
        'NotAllowedError',
      );
      expect(isNativeDomException(after)).toBe(true);
      expect(getBrowserErrorName(after)).toBe('NotAllowedError');
      expect(getBrowserErrorMessage(after)).toBe(
        'Microphone denied after subclass replacement',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('observes DOMException accessors patched in place', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      DOMException.prototype,
      'name',
    );
    if (descriptor === undefined) {
      throw new Error('Expected a DOMException name accessor.');
    }
    const error = new DOMException('Microphone denied', 'NotAllowedError');
    expect(getBrowserErrorName(error)).toBe('NotAllowedError');

    Object.defineProperty(DOMException.prototype, 'name', {
      configurable: true,
      get: () => 'PatchedError',
    });
    try {
      expect(getBrowserErrorName(error)).toBe('PatchedError');
      expect(
        getBrowserErrorName(new DOMException('Aborted', 'AbortError')),
      ).toBe('PatchedError');
    } finally {
      Object.defineProperty(DOMException.prototype, 'name', descriptor);
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
