// Next 16 references this ES2024 type while the example intentionally emits
// ES2022. Keep the dependency declaration check narrow without widening the
// application's available runtime library surface.
interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
}
