/**
 * Argument sanitisation for the scripting VM boundary.
 *
 * `.logic` code operates on plain data, never on browser host objects, so
 * everything crossing into the VM is deep-cloned through an allowlist first.
 * Shared by every VM adapter — a hardening fix here must not be able to land
 * in one engine's adapter and not the other's.
 */

import { eventForScript } from './event-props';

/**
 * True for values that are safe to hand to the VM: plain objects
 * (`{}` / `Object.create(null)`) and arrays. Everything else — DOM nodes,
 * events, class instances, proxies — is rejected, but for the built-in data
 * kinds {@link dataOf} reads as plain data.
 */
function isPlainObject(obj: object): boolean {
  if (Array.isArray(obj)) return true;
  const proto = Object.getPrototypeOf(obj);
  return proto === null || proto === Object.prototype;
}

/** Define `key` as an own data property: assigned, `__proto__` ran the prototype setter and the key was lost. */
function own(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** No such data kind: see {@link dataOf}. */
const NOT_DATA = Symbol('not data');

/**
 * A built-in that holds plain data, as the plain data it holds, the way the
 * script would write it: a `Set` as the list of its members (DataGrid hands
 * its selection as one, and a page writes `selectedKeys` as a list), a `Map`
 * as its `[key, value]` pairs (as `#each` goes through one), a `Date` as its
 * ISO text (`toJSON`; null for an invalid one), and a typed array, a
 * `DataView` or an `ArrayBuffer` as the list of its numbers (bytes for the
 * last two). Each of these crossed as null, so a handler was handed nothing
 * where the page had something. The members are cloned by `clone`, so a
 * DOM node held in a Set is still nothing. Anything else is {@link NOT_DATA}.
 */
function dataOf(o: object, clone: (value: unknown) => unknown): unknown {
  if (o instanceof Date) {
    const time = Date.prototype.getTime.call(o);
    return Number.isNaN(time) ? null : Date.prototype.toISOString.call(o);
  }
  if (o instanceof Set) {
    const members: unknown[] = [];
    // The built-in's own iteration, which a subclass cannot change.
    Set.prototype.forEach.call(o, (member: unknown) => members.push(clone(member)));
    return members;
  }
  if (o instanceof Map) {
    const pairs: unknown[] = [];
    Map.prototype.forEach.call(o, (value: unknown, key: unknown) => pairs.push([clone(key), clone(value)]));
    return pairs;
  }
  if (ArrayBuffer.isView(o)) {
    const view =
      o instanceof DataView ? new Uint8Array(o.buffer, o.byteOffset, o.byteLength) : (o as unknown as ArrayLike<number | bigint>);
    const numbers: unknown[] = new Array(view.length);
    for (let i = 0; i < view.length; i++) numbers[i] = clone(view[i]);
    return numbers;
  }
  if (o instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && o instanceof SharedArrayBuffer)) {
    return Array.from(new Uint8Array(o as ArrayBuffer));
  }
  return NOT_DATA;
}

/** Whether a value is one of the built-in data kinds {@link dataOf} reads. */
function isDataKind(o: object): boolean {
  return (
    o instanceof Date ||
    o instanceof Set ||
    o instanceof Map ||
    ArrayBuffer.isView(o) ||
    o instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && o instanceof SharedArrayBuffer)
  );
}

/**
 * A value of the page's state as the engine is handed it: the value itself
 * where it is plain data, which is nearly always, and otherwise a copy in
 * which each built-in data kind is read as a call's arguments read it
 * (`dataOf`), a `Set` as the list of its members.
 *
 * The page's state is written into the engine as it is. A Set there, which a
 * page holds when a handler keeps what DataGrid hands it (`@selectionChange=
 * {(keys) => selection = keys}`), reached the logic as `{}`, and the next call
 * read that `{}` back over the page's own copy: the selection was gone from
 * the page too. Everything else is handed over as before: this copies only
 * the arrays and objects on the way to such a value, and nothing at all for
 * plain data.
 */
export function stateForScript(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const walking = new Set<object>();

  function walk(v: unknown): unknown {
    if (v === null || typeof v !== 'object') return v;
    const o = v as object;
    if (walking.has(o)) return o;
    if (Array.isArray(o)) {
      walking.add(o);
      let copy: unknown[] | null = null;
      for (let i = 0; i < o.length; i++) {
        if (!(i in o)) continue;
        const item = o[i] as unknown;
        const read = walk(item);
        if (read !== item) {
          copy ??= o.slice();
          copy[i] = read;
        }
      }
      walking.delete(o);
      return copy ?? o;
    }
    const proto = Object.getPrototypeOf(o);
    if (proto === Object.prototype || proto === null) {
      walking.add(o);
      let copy: Record<string, unknown> | null = null;
      const keys = Object.keys(o);
      for (const key of keys) {
        let item: unknown;
        try {
          item = (o as Record<string, unknown>)[key];
        } catch {
          continue;
        }
        const read = walk(item);
        if (read !== item) {
          if (!copy) {
            copy = proto === null ? Object.create(null) : {};
            for (const k of keys) {
              try {
                own(copy!, k, (o as Record<string, unknown>)[k]);
              } catch {
                own(copy!, k, null);
              }
            }
          }
          own(copy!, key, read);
        }
      }
      walking.delete(o);
      return copy ?? o;
    }
    return isDataKind(o) ? sanitizeArgs([o])[0] : o;
  }

  return walk(value);
}

/**
 * Defensive deep-clone of VM call arguments that:
 * - allows only primitives, plain objects and arrays (allowlist), and reads
 *   the built-in data kinds (`Set`, `Map`, `Date`, typed arrays) as the plain
 *   data they hold (see {@link dataOf})
 * - reduces a browser event to the plain properties a script may see
 * - drops DOM nodes and every other browser host object
 * - breaks circular references (which would otherwise recurse until the
 *   engine's stack gives out) while still permitting shared references
 * - survives getters that throw
 * - keeps a key named `__proto__` as the key it is
 * - hands a BigInt over as a number where one holds it exactly, else as its
 *   digits (what a module's 64-bit answer is given as, wasm-worker.ts), and a
 *   symbol as null: the engine made both `undefined`, and the host-JavaScript
 *   engine got them as they were, so one handler saw two different values
 */
export function sanitizeArgs(args: unknown[]): unknown[] {
  if (args.length === 0) return args;
  const seen = new WeakSet();

  function cloneSafe(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    const t = typeof obj;
    if (t === 'string' || t === 'number' || t === 'boolean') return obj;
    if (t === 'function' || t === 'symbol') return null;
    if (t === 'bigint') {
      const n = Number(obj);
      return Number.isSafeInteger(n) ? n : String(obj);
    }
    if (t !== 'object') return obj;
    const o = obj as object;
    // A browser event, bare or inside React's wrapper, or the markup's
    // stand-in for one, crosses as the same plain record, rather than as
    // nothing: see handlerEventForScript.
    const event = eventForScript(o);
    if (event) return event;
    const plain = isPlainObject(o);
    // Break cycles but allow valid DAGs (shared references).
    if (seen.has(o)) return null;

    let result: unknown;
    if (!plain) {
      seen.add(o);
      try {
        result = dataOf(o, cloneSafe);
      } catch {
        // A stand-in that only claims to be one (a proxy round a Set).
        result = null;
      }
      seen.delete(o);
      return result === NOT_DATA ? null : result;
    }
    seen.add(o);

    if (Array.isArray(o)) {
      result = o.map(cloneSafe);
    } else {
      const clone: Record<string, unknown> = {};
      for (const key of Object.keys(o)) {
        try {
          own(clone, key, cloneSafe((o as Record<string, unknown>)[key]));
        } catch {
          // A getter that throws contributes null rather than aborting the call.
          own(clone, key, null);
        }
      }
      result = clone;
    }

    seen.delete(o); // let this object reappear on a sibling path
    return result;
  }

  return args.map(cloneSafe);
}
