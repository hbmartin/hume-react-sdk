export type DataProperty = Readonly<{ value: unknown }>;

/** Read an own property descriptor without allowing proxy traps to escape. */
export const getOwnPropertyDescriptorSafely = (
  value: object,
  key: PropertyKey,
): PropertyDescriptor | null | undefined => {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return null;
  }
};

/** Read an own data property without invoking an accessor. */
export const getOwnDataProperty = (
  value: object,
  key: PropertyKey,
): DataProperty | null => {
  const descriptor = getOwnPropertyDescriptorSafely(value, key);
  return descriptor !== null &&
    descriptor !== undefined &&
    'value' in descriptor
    ? { value: descriptor.value }
    : null;
};

/** Read an enumerable own data property without invoking an accessor. */
export const getOwnEnumerableDataProperty = (
  value: object,
  key: PropertyKey,
): DataProperty | null => {
  const descriptor = getOwnPropertyDescriptorSafely(value, key);
  return descriptor !== null &&
    descriptor?.enumerable === true &&
    'value' in descriptor
    ? { value: descriptor.value }
    : null;
};

/** Read a data property from an object or its prototypes without invoking accessors. */
export const getDataProperty = (
  value: object,
  key: PropertyKey,
): DataProperty | null => {
  const visited = new WeakSet<object>();
  let current: object | null = value;

  try {
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        return 'value' in descriptor ? { value: descriptor.value } : null;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return null;
  }
  return null;
};

export type AggregateErrorDetails = Readonly<{
  error: object;
  failures: readonly unknown[];
}>;

/** Recognize native, cross-realm, and aggregate-shaped errors without invoking accessors. */
export const getAggregateErrorDetails = (
  value: unknown,
): AggregateErrorDetails | null => {
  if (typeof value !== 'object' || value === null) return null;
  let isNativeAggregateError = false;
  try {
    isNativeAggregateError =
      typeof AggregateError !== 'undefined' && value instanceof AggregateError;
  } catch {
    // Fall back to the cross-realm data-property check below.
  }
  if (
    !isNativeAggregateError &&
    getDataProperty(value, 'name')?.value !== 'AggregateError'
  ) {
    return null;
  }
  const errors = getOwnDataProperty(value, 'errors')?.value;
  return Array.isArray(errors) ? { error: value, failures: errors } : null;
};
