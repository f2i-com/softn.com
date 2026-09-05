/**
 * Keys for the per-render cache of sync helper results.
 *
 * The cache exists so that `{label(x)}` written twice in one template costs
 * one VM call, not two. That only holds if two calls share a key exactly when
 * they would return the same thing, and the previous key did not: a lone
 * number was interpolated with `String()`, so `f(0)` and `f(-0)` collided, and
 * anything with more than one argument fell through to `JSON.stringify`, which
 * folds `[null]`, `[undefined]` and `[NaN]` onto one string, visits the whole
 * of every object handed to it, and calls any `toJSON` it meets on the way.
 * Within a single render the second call then silently returned the first
 * one's answer.
 *
 * Only primitives are keyed here. A reference value is not described — the
 * call goes through to the VM and its result is not cached — because there is
 * no cheap, lossless description of an object graph, and an expensive lossy
 * one is what this replaces. Every part of the key carries its own length, so
 * a boundary between two arguments cannot be forged by the contents of one.
 */

const MAX_ARGS = 64;
const MAX_STRING_LENGTH = 65_536;
const MAX_KEY_LENGTH = 65_536;

export function buildSyncCacheKey(name: string, args: readonly unknown[]): string | null {
  if (args.length > MAX_ARGS || name.length > 4096) return null;
  let key = `${name.length}:${name}|${args.length}|`;
  for (const value of args) {
    let part: string;
    if (value === null) {
      part = 'null';
    } else {
      switch (typeof value) {
        case 'undefined':
          part = 'undefined';
          break;
        case 'boolean':
          part = value ? 'boolean:1' : 'boolean:0';
          break;
        case 'number':
          // `String(-0)` is "0"; Object.is is the only test that tells them apart.
          part = `number:${Object.is(value, -0) ? '-0' : String(value)}`;
          break;
        case 'bigint':
          part = `bigint:${String(value)}`;
          break;
        case 'string':
          if (value.length > MAX_STRING_LENGTH) return null;
          part = `string:${value}`;
          break;
        default:
          // Objects, arrays, functions, symbols: call through, do not cache.
          return null;
      }
    }
    if (key.length + part.length > MAX_KEY_LENGTH) return null;
    key += `${part.length}:${part}`;
  }
  return key;
}
