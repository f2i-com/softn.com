/**
 * One shared attempt at an initialisation, cached on success and forgotten
 * on failure.
 *
 * The engine's WASM loader stored its first promise and never looked at it
 * again, so a fetch that failed once — offline for a moment, a proxy that
 * dropped the connection — left a rejected promise behind that every later
 * app in the page received as its own startup failure. Nothing short of a
 * reload could clear it.
 *
 * Concurrent callers still share a single attempt, and a success stays cached
 * for the life of the page. Only a failed attempt is discarded, and only by
 * the attempt that failed: a retry that has already begun is not thrown away
 * by an older rejection landing late. Retrying is the caller's decision; this
 * does not loop.
 */
export function retryableSingleFlight<T>(initialize: () => T | PromiseLike<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () => {
    if (current) return current;
    const pending = Promise.resolve().then(initialize);
    const guarded: Promise<T> = pending.catch((error: unknown) => {
      if (current === guarded) current = null;
      throw error;
    });
    current = guarded;
    return guarded;
  };
}
