import { useSyncExternalStore } from 'react';

const BARK_BAND_COUNT = 24;

/**
 * Frequency-domain magnitudes for one animation frame.
 *
 * The array is shared between subscribers and must not be mutated.
 */
export type FftSnapshot = readonly number[];

const EMPTY_FFT: FftSnapshot = Object.freeze(
  Array.from({ length: BARK_BAND_COUNT }, () => 0),
);

/**
 * Mutable store backing the granular FFT subscription hooks.
 *
 * @deprecated Use {@link usePlayerFft} or {@link useMicFft}. This class remains
 * exported only because the deprecated `useSoundPlayer` return type exposes it.
 */
export class FftStore {
  private _buffer: number[] = Array.from({ length: BARK_BAND_COUNT }, () => 0);

  private _snapshot: FftSnapshot = EMPTY_FFT;

  private _listeners = new Set<() => void>();

  private _dirty = false;

  private _rafId: number | null = null;

  write(data: number[]): void {
    for (let i = 0; i < BARK_BAND_COUNT; i++) {
      this._buffer[i] = data[i] ?? 0;
    }
    if (!this._dirty) {
      this._dirty = true;
      this._scheduleFlush();
    }
  }

  clear(): void {
    this._buffer.fill(0);
    this._dirty = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._snapshot.every((value) => value === 0)) return;

    this._publish(EMPTY_FFT);
  }

  private _scheduleFlush(): void {
    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._flush();
    });
  }

  private _flush(): void {
    if (!this._dirty) return;
    this._dirty = false;
    this._publish(Object.freeze([...this._buffer]));
  }

  private _publish(snapshot: FftSnapshot): void {
    this._snapshot = snapshot;
    for (const listener of this._listeners) {
      listener();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): FftSnapshot => {
    return this._snapshot;
  };

  getServerSnapshot = (): FftSnapshot => {
    return EMPTY_FFT;
  };

  /** Reset pending work, subscribers, and buffered data without disabling reuse. */
  destroy(): void {
    this._dirty = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._listeners.clear();
    this._buffer.fill(0);
    this._snapshot = EMPTY_FFT;
  }
}

/**
 * Subscribe to an {@link FftStore} from React.
 *
 * @deprecated Use {@link usePlayerFft} or {@link useMicFft}.
 */
export function useFftSubscription(store: FftStore): FftSnapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
}
