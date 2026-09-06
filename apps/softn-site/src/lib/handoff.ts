/**
 * A bundle handed to this page by Builder or Studio.
 *
 * Both editors stage a bundle in this origin's IndexedDB and open the
 * publish page with `?from=handoff`; this takes it. The database, store and
 * key names are the contract with `packages/@softn/core/src/bundle/handoff.ts`,
 * which this repeats rather than imports: the site does not depend on the
 * engine. Taking removes the entry, and one older than ten minutes is
 * thrown away unread.
 */

const HANDOFF_DB = 'softn-handoff';
const HANDOFF_STORE = 'bundles';
const HANDOFF_KEY = 'pending';
const HANDOFF_TTL_MS = 10 * 60 * 1000;

export interface BundleHandoff {
  bytes: Uint8Array;
  name: string;
  from: 'builder' | 'studio' | 'runtime';
  stagedAt: number;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export async function takeBundleHandoff(now = Date.now()): Promise<BundleHandoff | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(HANDOFF_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(HANDOFF_STORE)) req.result.createObjectStore(HANDOFF_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
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

/** Whether this page was opened to take a hand-off. */
export function openedForHandoff(search = window.location.search): boolean {
  return new URLSearchParams(search).get('from') === 'handoff';
}
