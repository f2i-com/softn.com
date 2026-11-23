/**
 * Where an app's IndexedDB databases are kept on the page.
 *
 * The app's side keeps each database as texts, one for its description and one for each of
 * its stores (`m[name]`, `s[name,store]`). They were kept in the page's localStorage, which a
 * browser gives a site about 5 MB of in all, shared with the embedding site's own: an app's
 * IndexedDB held little more than a localStorage does. And localStorage is the same in every
 * tab only in time: a tab that read it just after another wrote it could read what was there
 * before, so the same app in two tabs could not take turns at a database. They are kept in
 * the page's own IndexedDB now, which holds as much as the browser gives the site, and which
 * every tab reads the same the moment a write is done.
 *
 * Where the page has no IndexedDB (or it is closed to the page), they are kept in its
 * localStorage, as before.
 */

/** The parts of an app's databases, by name, as the app's side writes them. */
export type IdbParts = Map<string, string>;

export interface IdbBacking {
  readonly kind: 'indexeddb' | 'localStorage';
  /** Every part the app keeps. */
  loadAll(): Promise<IdbParts>;
  /** The parts whose names begin with any of `prefixes`. */
  read(prefixes: readonly string[]): Promise<IdbParts>;
  /**
   * Writes (a text) and removals (null), all or none. False when the page's storage refused,
   * or a lease given is no longer the writer's (a tab whose lease ran out writes nothing).
   */
  write(changes: ReadonlyMap<string, string | null>, fences?: readonly LeaseFence[]): Promise<boolean>;
}

/** A lease a write is made under (holdByLease): its record's key, and who must still hold it. */
export interface LeaseFence {
  key: IDBValidKey;
  owner: string;
}

/** Past every name a part may have, in key order. */
const LAST = String.fromCharCode(0xffff);

const BACKING_DB = 'softn-container';
const BACKING_STORE = 'idb';

let opening: Promise<IDBDatabase> | null = null;

function openBackingVersion(version: number, retried: boolean): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(BACKING_DB, version);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BACKING_STORE)) db.createObjectStore(BACKING_STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A newer page of the site upgrading it: this one lets go, and opens it again when next asked.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      db.onclose = () => {
        opening = null;
      };
      if (!db.objectStoreNames.contains(BACKING_STORE)) {
        const nextVersion = (typeof db.version === 'number' && db.version >= 1 ? db.version : version) + 1;
        try { db.close(); } catch { /* ignore */ }
        if (!retried) {
          openBackingVersion(nextVersion, true).then(resolve, reject);
          return;
        }
        reject(new Error('IndexedDB backing store is missing'));
        return;
      }
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
    request.onblocked = () => reject(new Error('IndexedDB is held open by another page of the site'));
  });
}

/** The page's own database for every app's parts, opened once a page. */
function backingDb(): Promise<IDBDatabase> {
  if (!opening) {
    opening = openBackingVersion(1, false).catch((error: unknown) => {
      opening = null;
      throw error;
    });
  }
  return opening;
}

/** The page's IndexedDB, when it has one that opens. */
export async function indexedDbBacking(base: string): Promise<IdbBacking | null> {
  if (typeof indexedDB === 'undefined' || typeof IDBKeyRange === 'undefined') return null;
  try {
    await backingDb();
  } catch {
    return null;
  }
  const readPrefixes = async (prefixes: readonly string[]): Promise<IdbParts> => {
    const db = await backingDb();
    return new Promise<IdbParts>((resolve, reject) => {
      const out: IdbParts = new Map();
      const tx = db.transaction(BACKING_STORE, 'readonly');
      const store = tx.objectStore(BACKING_STORE);
      // Each part kept under [the app's base, its name]: two apps' bases never run into each
      // other. (Kept under the two joined, an app whose base began another's read, wrote and
      // deleted the other app's parts: "app-1" and "app-12".)
      for (const prefix of prefixes) {
        const cursor = store.openCursor(IDBKeyRange.bound([base, prefix], [base, prefix + LAST]));
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return;
          const key = at.key;
          if (Array.isArray(key) && key.length === 2 && key[0] === base && typeof key[1] === 'string' && typeof at.value === 'string') out.set(key[1], at.value);
          at.continue();
        };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB could not be read'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB could not be read'));
    });
  };
  return {
    kind: 'indexeddb',
    loadAll: () => readPrefixes(['']),
    read: readPrefixes,
    async write(changes, fences = []) {
      if (changes.size === 0) return true;
      try {
        const db = await backingDb();
        return await new Promise<boolean>((resolve) => {
          const tx = db.transaction(BACKING_STORE, 'readwrite');
          const store = tx.objectStore(BACKING_STORE);
          // Each lease it is written under is the writer's still, read in this transaction: one
          // that ran out (a tab whose timers stopped) undoes the whole of it.
          for (const fence of fences) {
            const held = store.get(fence.key);
            held.onsuccess = () => {
              const record = held.result as { owner?: unknown } | undefined;
              if (!record || record.owner !== fence.owner) {
                try {
                  tx.abort();
                } catch {
                  // Over already.
                }
              }
            };
          }
          for (const [name, value] of changes) {
            if (value === null) store.delete([base, name]);
            else store.put(value, [base, name]);
          }
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        });
      } catch {
        return false;
      }
    },
  };
}

/** The page's localStorage (or custom `Storage`), under `<base>idb:<name>`: where there is no IndexedDB to keep them in. */
export function localStorageBacking(base: string, storage?: Storage): IdbBacking {
  const prefix = `${base}idb:`;
  const getStore = (): Storage | undefined => {
    if (storage) return storage;
    try {
      return typeof localStorage !== 'undefined' ? localStorage : undefined;
    } catch {
      return undefined;
    }
  };
  const readPrefixes = (prefixes: readonly string[]): IdbParts => {
    const out: IdbParts = new Map();
    const store = getStore();
    if (!store) return out;
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length);
        if (!prefixes.some((p) => name.startsWith(p))) continue;
        const value = store.getItem(key);
        if (value !== null) out.set(name, value);
      }
    } catch {
      // Storage closed to this page: nothing kept.
    }
    return out;
  };
  return {
    kind: 'localStorage',
    loadAll: () => Promise.resolve(readPrefixes([''])),
    read: (prefixes) => Promise.resolve(readPrefixes(prefixes)),
    write(changes) {
      const store = getStore();
      if (!store) return Promise.resolve(false);
      try {
        for (const [name, value] of changes) {
          if (value === null) store.removeItem(prefix + name);
          else store.setItem(prefix + name, value);
        }
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
  };
}

/**
 * Holding a database across the site's tabs where the browser has no locks of its own
 * (`navigator.locks`: Safari before 15.4): a lease kept in the page's own IndexedDB, whose
 * transactions the browser runs one tab at a time. A tab takes it by writing that it holds it
 * until a few seconds on, where no other tab holds it now; renews it while it holds it; and
 * clears it when it lets go, telling the others. A tab that closed without letting go is held
 * to its lease, which runs out.
 *
 * Answers the function that lets go of it, or null when `gone()` says the asker went away.
 */
export async function holdByLease(base: string, name: string, gone: () => boolean): Promise<{ release: () => void; fence: LeaseFence } | null> {
  const db = await backingDb();
  // A key no part's can be: parts are [base, name], and this begins with a number.
  const key: IDBValidKey = [0, base, name];
  const owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`softn-lease:${JSON.stringify(base)}`) : null;
  const leaseTx = (change: (held: { owner?: unknown; until?: unknown } | undefined, store: IDBObjectStore) => boolean): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let answer = false;
      try {
        const tx = db.transaction(BACKING_STORE, 'readwrite');
        const store = tx.objectStore(BACKING_STORE);
        const got = store.get(key);
        got.onsuccess = () => {
          const held = got.result as { owner?: unknown; until?: unknown } | undefined;
          answer = change(held && typeof held === 'object' ? held : undefined, store);
        };
        tx.oncomplete = () => resolve(answer);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  const take = () =>
    leaseTx((held, store) => {
      const now = Date.now();
      if (held && held.owner !== owner && typeof held.until === 'number' && held.until > now) return false;
      store.put({ owner, until: now + LEASE_MS }, key);
      return true;
    });
  return new Promise<{ release: () => void; fence: LeaseFence } | null>((resolve) => {
    let retry: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const attempt = async () => {
      retry = null;
      if (done) return;
      if (gone()) {
        done = true;
        channel?.close();
        resolve(null);
        return;
      }
      if (!(await take())) {
        retry = setTimeout(() => void attempt(), LEASE_RETRY_MS);
        return;
      }
      done = true;
      const renew = setInterval(() => {
        void leaseTx((held, store) => {
          if (!held || held.owner !== owner) return false;
          store.put({ owner, until: Date.now() + LEASE_MS }, key);
          return true;
        });
      }, LEASE_MS / 3);
      let released = false;
      resolve({
        fence: { key, owner },
        release: () => {
          if (released) return;
          released = true;
          clearInterval(renew);
          void leaseTx((held, store) => {
            if (!held || held.owner !== owner) return false;
            store.delete(key);
            return true;
          }).then(() => {
            channel?.postMessage({ released: name });
            channel?.close();
          });
        },
      });
    };
    // Let go of by another tab: asked again at once rather than at the next retry.
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        if ((event.data as { released?: unknown } | null)?.released === name && retry !== null && !done) {
          clearTimeout(retry);
          void attempt();
        }
      };
    }
    void attempt();
  });
}

const LEASE_MS = 6000;
const LEASE_RETRY_MS = 150;

/** The database a part belongs to: `m["notes"]` and `s["notes","todo"]` are both of "notes". */
export function databaseOfPart(name: string): string | null {
  if (name.charAt(0) !== 'm' && name.charAt(0) !== 's' && name.charAt(0) !== 'p') return null;
  try {
    const parsed: unknown = JSON.parse(name.slice(1));
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
  } catch {
    return null;
  }
}

/** The names a database's parts begin with: its description, its stores, and their pages. */
export function partPrefixes(database: string): string[] {
  const opened = JSON.stringify([database]).slice(0, -1);
  return [`m${opened}]`, `s${opened},`, `p${opened},`];
}

/** The bytes a part takes, as the app's side and the Worker count them. */
export function partBytes(name: string, value: string): number {
  return (name.length + value.length) * 2;
}
