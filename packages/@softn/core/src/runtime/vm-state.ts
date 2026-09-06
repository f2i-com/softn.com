/**
 * State comparison shared by the VM→host sync paths.
 *
 * Both the main-thread runtime and the Web Worker runtime read state variables
 * back out of the VM and must decide which of them actually changed. Getting
 * that wrong in either direction is visible to the user — a false negative
 * drops an update, a false positive re-renders forever — so both use the same
 * comparison.
 *
 * The contract: two values are equal when they are the same kind of thing and
 * every part of them is equal. "Kind" is decided for both operands, never
 * inferred from the first alone — an earlier version asked only what `a` was,
 * so `{}` equalled `new Set([1])` (a plain object with no keys against a Set
 * with no keys) while the reverse comparison was false. A comparator that is
 * not symmetric is one whose answer depends on which side the VM happened to
 * put the old value on.
 *
 * What the VM bridge materialises for a state variable is JSON-shaped data
 * plus the binary kinds listed below. Anything else — a class instance, a
 * function, a Promise — compares by identity only, which reads as "changed"
 * on every sync; that is the safe direction for a value the bridge does not
 * understand.
 */

/** Maximum recursion depth for {@link deepEqual}. */
export const MAX_CONVERSION_DEPTH = 10;

type Kind =
  | 'date'
  | 'regexp'
  | 'set'
  | 'map'
  | 'arraybuffer'
  | 'dataview'
  | 'typedarray'
  | 'array'
  | 'object';

function kindOf(value: object): Kind {
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value instanceof RegExp) return 'regexp';
  if (value instanceof Set) return 'set';
  if (value instanceof Map) return 'map';
  if (value instanceof ArrayBuffer) return 'arraybuffer';
  if (ArrayBuffer.isView(value)) return value instanceof DataView ? 'dataview' : 'typedarray';
  return 'object';
}

const hasOwn = Object.prototype.hasOwnProperty;

/** Byte-for-byte comparison of the range each view covers, not of its whole buffer. */
function bytesEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const vb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}

/**
 * Deep equality check for state comparison.
 *
 * Handles primitives (NaN equals NaN), arrays, plain objects, Date, Set, Map,
 * RegExp, ArrayBuffer, DataView and every typed array. Sets compare their
 * members by identity, as a Set does. Objects compare their own enumerable
 * string keys: a key present on one side and absent on the other is a
 * difference even when its value is `undefined`, because `{a: undefined}` and
 * `{b: undefined}` are different states.
 */
export function deepEqual(a: unknown, b: unknown, depth: number = 0): boolean {
  if (a === b) return true;
  // NaN === NaN is false, but for state comparison the value has not changed.
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  // Prevent stack overflow on pathologically deep structures: report a change
  // rather than guess, so the worst case is a re-render, not a dropped update.
  if (depth >= MAX_CONVERSION_DEPTH) return false;

  const kind = kindOf(a as object);
  if (kind !== kindOf(b as object)) return false;

  switch (kind) {
    case 'date':
      return (a as Date).getTime() === (b as Date).getTime();

    case 'regexp':
      return (a as RegExp).source === (b as RegExp).source && (a as RegExp).flags === (b as RegExp).flags;

    case 'set': {
      const sa = a as Set<unknown>;
      const sb = b as Set<unknown>;
      if (sa.size !== sb.size) return false;
      for (const val of sa) {
        if (!sb.has(val)) return false;
      }
      return true;
    }

    case 'map': {
      const ma = a as Map<unknown, unknown>;
      const mb = b as Map<unknown, unknown>;
      if (ma.size !== mb.size) return false;
      for (const [key, val] of ma) {
        if (!mb.has(key) || !deepEqual(val, mb.get(key), depth + 1)) return false;
      }
      return true;
    }

    case 'arraybuffer':
      return bytesEqual(new Uint8Array(a as ArrayBuffer), new Uint8Array(b as ArrayBuffer));

    case 'dataview':
      // A DataView has no `.length` and no indexer; the earlier code assumed
      // both, so two DataViews compared as zero elements long — equal whatever
      // their bytes said.
      return bytesEqual(a as DataView, b as DataView);

    case 'typedarray': {
      const ta = a as ArrayBufferView;
      const tb = b as ArrayBufferView;
      // Same element type, then the same bytes over each view's own range: a
      // subview is compared as the window it is, not as the buffer behind it.
      if (ta.constructor !== tb.constructor) return false;
      return bytesEqual(ta, tb);
    }

    case 'array': {
      const aa = a as unknown[];
      const ab = b as unknown[];
      if (aa.length !== ab.length) return false;
      for (let i = 0; i < aa.length; i++) {
        if (!deepEqual(aa[i], ab[i], depth + 1)) return false;
      }
      return true;
    }

    case 'object': {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;
      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);
      if (aKeys.length !== bKeys.length) return false;
      for (const key of aKeys) {
        // Membership, not just value: with equal key counts, one side missing
        // this key means it has some other key instead — `{a: undefined}` and
        // `{b: undefined}` used to compare equal because `undefined` equalled
        // the absent property's `undefined`.
        if (!hasOwn.call(bObj, key)) return false;
        if (!deepEqual(aObj[key], bObj[key], depth + 1)) return false;
      }
      return true;
    }
  }
}
