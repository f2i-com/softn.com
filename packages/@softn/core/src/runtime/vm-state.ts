/**
 * State comparison shared by the VM→host sync paths.
 *
 * Both the main-thread runtime and the Web Worker runtime read state variables
 * back out of the VM and must decide which of them actually changed. Getting
 * that wrong in either direction is visible to the user — a false negative
 * drops an update, a false positive re-renders forever — so both use the same
 * comparison.
 */

/** Maximum recursion depth for {@link deepEqual}. */
export const MAX_CONVERSION_DEPTH = 10;

/**
 * Deep equality check for state comparison.
 * Handles primitives, arrays, plain objects, Date, Set, Map, RegExp,
 * and typed arrays to prevent infinite re-renders or missed updates.
 */
export function deepEqual(a: unknown, b: unknown, depth: number = 0): boolean {
  if (a === b) return true;
  // Handle NaN: NaN === NaN is false, but they should be equal for state comparison
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  // Prevent stack overflow on pathologically deep structures
  if (depth >= MAX_CONVERSION_DEPTH) return false;

  // Date
  if (a instanceof Date) {
    return b instanceof Date && a.getTime() === b.getTime();
  }

  // RegExp
  if (a instanceof RegExp) {
    return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }

  // Set
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false;
    for (const val of a) {
      if (!b.has(val)) return false;
    }
    return true;
  }

  // Map
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key) || !deepEqual(val, b.get(key), depth + 1)) return false;
    }
    return true;
  }

  // ArrayBuffer
  if (a instanceof ArrayBuffer) {
    if (!(b instanceof ArrayBuffer) || a.byteLength !== b.byteLength) return false;
    const viewA = new Uint8Array(a);
    const viewB = new Uint8Array(b);
    for (let i = 0; i < viewA.length; i++) {
      if (viewA[i] !== viewB[i]) return false;
    }
    return true;
  }

  // Typed arrays (Uint8Array, Float32Array, etc.)
  if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b)) return false;
    const ta = a as unknown as { length: number; [i: number]: number; constructor: unknown };
    const tb = b as unknown as { length: number; [i: number]: number; constructor: unknown };
    if (ta.constructor !== tb.constructor || ta.length !== tb.length) return false;
    for (let i = 0; i < ta.length; i++) {
      if (ta[i] !== tb[i]) return false;
    }
    return true;
  }

  // Arrays
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }

  // Plain objects
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!deepEqual(aObj[key], bObj[key], depth + 1)) return false;
  }
  return true;
}
