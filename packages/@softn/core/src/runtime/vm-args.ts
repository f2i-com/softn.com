/**
 * Argument sanitisation for the scripting VM boundary.
 *
 * `.logic` code operates on plain data, never on browser host objects, so
 * everything crossing into the VM is deep-cloned through an allowlist first.
 * Shared by every VM adapter — a hardening fix here must not be able to land
 * in one engine's adapter and not the other's.
 */

import { extractEventProps } from './event-props';

/**
 * True for values that are safe to hand to the VM: plain objects
 * (`{}` / `Object.create(null)`) and arrays. Everything else — DOM nodes,
 * events, typed arrays, `Map`, `Set`, proxies — is rejected.
 */
function isPlainObject(obj: object): boolean {
  if (Array.isArray(obj)) return true;
  const proto = Object.getPrototypeOf(obj);
  return proto === null || proto === Object.prototype;
}

/**
 * Defensive deep-clone of VM call arguments that:
 * - allows only primitives, plain objects and arrays (allowlist)
 * - reduces a browser event to the plain properties a script may see
 * - drops DOM nodes and every other browser host object
 * - breaks circular references (which would otherwise recurse until the
 *   engine's stack gives out) while still permitting shared references
 * - survives getters that throw
 */
export function sanitizeArgs(args: unknown[]): unknown[] {
  if (args.length === 0) return args;
  const seen = new WeakSet();

  function cloneSafe(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    const t = typeof obj;
    if (t === 'string' || t === 'number' || t === 'boolean') return obj;
    if (t === 'function') return null;
    if (t !== 'object') return obj;
    const o = obj as object;
    // A browser event, bare or inside React's wrapper, crosses as the same
    // plain shape the window bridge sends, rather than as nothing.
    if (typeof Event !== 'undefined') {
      if (o instanceof Event) return extractEventProps(o);
      const native = (o as { nativeEvent?: unknown }).nativeEvent;
      if (native instanceof Event) return extractEventProps(native);
    }
    if (!isPlainObject(o)) return null;
    // Break cycles but allow valid DAGs (shared references).
    if (seen.has(o)) return null;
    seen.add(o);

    let result: unknown;
    if (Array.isArray(o)) {
      result = o.map(cloneSafe);
    } else {
      const clone: Record<string, unknown> = {};
      for (const key of Object.keys(o)) {
        try {
          clone[key] = cloneSafe((o as Record<string, unknown>)[key]);
        } catch {
          // A getter that throws contributes null rather than aborting the call.
          clone[key] = null;
        }
      }
      result = clone;
    }

    seen.delete(o); // let this object reappear on a sibling path
    return result;
  }

  return args.map(cloneSafe);
}
