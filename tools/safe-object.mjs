/**
 * Read an own data property from untrusted input without invoking an accessor.
 *
 * @param {object} value
 * @param {PropertyKey} key
 * @returns {unknown}
 */
export function getOwnValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {object} value
 * @param {readonly PropertyKey[]} keys
 * @returns {unknown[]}
 */
export function getOwnValues(value, keys) {
  return keys.map((key) => getOwnValue(value, key));
}

/** @param {unknown} value @returns {value is object} */
export function isObjectRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
