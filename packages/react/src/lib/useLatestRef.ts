import { useRef } from 'react';

export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  // oxlint-disable-next-line react/refs -- synchronizing during render keeps event callbacks current before effects run
  ref.current = value;
  return ref;
}
