/**
 * Handing a bundle from one page of the site to another.
 *
 * Builder and Studio make bundles; the runtime runs them and the directory
 * publishes them. All four are pages of one origin, and a page cannot give
 * another a file — so a bundle to pass along is staged in this origin's
 * IndexedDB under one key, and the page that opens next takes it. Taking it
 * removes it: the hand-off is for the page it was made for, once, and a
 * stale one left behind is thrown away after a few minutes.
 *
 * The directory's publish page reads the same store without depending on
 * this package (apps/softn-site/src/lib/handoff.ts): the database, store
 * and key names below are the contract, and both sides carry them.
 *
 * In development the four apps run on separate ports — separate origins —
 * and share no storage. A hand-off then finds nothing and the receiving
 * page falls back to its ordinary open or upload.
 */

export const HANDOFF_DB = 'softn-handoff';
export const HANDOFF_STORE = 'bundles';
export const HANDOFF_KEY = 'pending';
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

export interface BundleHandoff {
  bytes: Uint8Array;
  /** The bundle's name, for the file name the receiver gives it. */
  name: string;
  /** Where it came from, for the receiver's wording. */
  from: 'builder' | 'studio' | 'runtime';
  stagedAt: number;
}

function openHandoffDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available here'));
      return;
    }
    const req = indexedDB.open(HANDOFF_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDOFF_STORE)) req.result.createObjectStore(HANDOFF_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** Stage a bundle for the next page. Resolves false where nothing can be staged. */
export async function stageBundleHandoff(bytes: Uint8Array, name: string, from: BundleHandoff['from']): Promise<boolean> {
  try {
    const db = await openHandoffDb();
    try {
      const tx = db.transaction(HANDOFF_STORE, 'readwrite');
      // A copy into a plain buffer: a view over a larger buffer would store the whole buffer.
      const copy = new Uint8Array(bytes);
      await request(tx.objectStore(HANDOFF_STORE).put({ bytes: copy, name, from, stagedAt: Date.now() }, HANDOFF_KEY));
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Take the staged bundle, if there is one and it is fresh. Taking removes it. */
export async function takeBundleHandoff(now = Date.now()): Promise<BundleHandoff | null> {
  try {
    const db = await openHandoffDb();
    try {
      const tx = db.transaction(HANDOFF_STORE, 'readwrite');
      const store = tx.objectStore(HANDOFF_STORE);
      const raw = (await request(store.get(HANDOFF_KEY))) as Partial<BundleHandoff> | undefined;
      await request(store.delete(HANDOFF_KEY));
      if (!raw || !(raw.bytes instanceof Uint8Array) || typeof raw.name !== 'string' || typeof raw.stagedAt !== 'number') return null;
      if (now - raw.stagedAt > HANDOFF_TTL_MS) return null;
      const from = raw.from === 'builder' || raw.from === 'studio' || raw.from === 'runtime' ? raw.from : 'runtime';
      return { bytes: raw.bytes, name: raw.name, from, stagedAt: raw.stagedAt };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The address of a page that should take the staged bundle when it opens. */
export function handoffUrl(base: string, page: 'publish' | 'runtime'): string {
  const root = base.replace(/\/+$/, '');
  return page === 'publish' ? `${root}/?from=handoff` : `${root}/?open=handoff`;
}
