/**
 * The visitor's identity for server storage.
 *
 * A storage collection with an `owner-write` or `private` policy has to know
 * who added a record, and there are no accounts. What there is instead is a
 * token this browser mints once and keeps, sent with every storage request
 * as `X-Visitor-Token`. The directory hashes it with its salt and the app's
 * slug and keeps only the hash, so the token is never written down on the
 * server, and one app's owners cannot be matched with another's.
 *
 * It is custody, not authentication, in the way the site's edit keys are:
 * clear this browser's storage and the records stay where their policy
 * leaves them, but nothing can claim them again. A host may pass its own
 * token to the runtime instead (`storageVisitorToken`); this is the default
 * for one that does not.
 */

const KEY = 'softn.storage.visitor';
const SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

function mint(): string | null {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') return null;
  const bytes = new Uint8Array(24);
  c.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * This browser's token, minted on first use. Null where there is no storage
 * to keep it in or no randomness to make it from — a worker, a server, a
 * private window that refuses — in which case the runtime sends none and
 * collections that need one refuse, saying so.
 */
export function storageVisitorToken(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const existing = localStorage.getItem(KEY);
    if (existing && SHAPE.test(existing)) return existing;
    const token = mint();
    if (!token) return null;
    localStorage.setItem(KEY, token);
    return token;
  } catch {
    return null;
  }
}

/** Forget this browser's token, for a "start over" a host might offer. */
export function forgetStorageVisitorToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}
