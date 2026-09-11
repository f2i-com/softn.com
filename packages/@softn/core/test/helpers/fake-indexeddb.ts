/**
 * Enough of IndexedDB for the hand-off protocol to run under Node: open with
 * a version and an upgrade, object stores with out-of-line keys, get, put,
 * delete and a forward cursor, and transactions that commit once no request
 * is pending — or abort on demand, so a claim whose transaction never
 * commits can be shown not to count as a delivery.
 *
 * Not a general IndexedDB; only what the tests need.
 */

type Listener = ((ev: unknown) => void) | null;

/**
 * A deep copy that keeps the caller's realm. The platform clone under vitest
 * hands back typed arrays from the outer realm, which fail `instanceof
 * Uint8Array` inside the test — the very check the protocol makes.
 */
function clone<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = clone(v);
    return out as T;
  }
  return value;
}

class FakeRequest<T = unknown> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Listener = null;
  onerror: Listener = null;
  readyState: 'pending' | 'done' = 'pending';
}

class FakeCursor {
  constructor(
    private readonly store: FakeObjectStore,
    private readonly tx: FakeTransaction,
    private readonly req: FakeRequest<FakeCursor | null>,
    private index: number,
  ) {}
  private keys(): string[] {
    return [...this.store.data.keys()].sort();
  }
  get key(): string {
    return this.keys()[this.index];
  }
  get value(): unknown {
    return clone(this.store.data.get(this.key));
  }
  delete(): FakeRequest<undefined> {
    const key = this.key;
    // Deleting the current row shifts what follows it down by one.
    this.index -= 1;
    return this.tx.run(() => {
      this.store.data.delete(key);
      return undefined;
    });
  }
  continue(): void {
    this.index += 1;
    this.tx.run(() => (this.index < this.keys().length ? this : null), this.req);
  }
}

class FakeObjectStore {
  data = new Map<string, unknown>();
  constructor(public readonly name: string) {}
  tx!: FakeTransaction;
  get(key: string): FakeRequest<unknown> {
    return this.tx.run(() => clone(this.data.get(key)));
  }
  put(value: unknown, key: string): FakeRequest<string> {
    return this.tx.run(() => {
      this.data.set(key, clone(value));
      return key;
    });
  }
  delete(key: string): FakeRequest<undefined> {
    return this.tx.run(() => {
      this.data.delete(key);
      return undefined;
    });
  }
  openCursor(): FakeRequest<FakeCursor | null> {
    const req = new FakeRequest<FakeCursor | null>();
    const cursor = new FakeCursor(this, this.tx, req, 0);
    this.tx.run(() => (this.data.size > 0 ? cursor : null), req);
    return req;
  }
}

class FakeTransaction {
  oncomplete: Listener = null;
  onerror: Listener = null;
  onabort: Listener = null;
  error: DOMException | null = null;
  private pending = 0;
  private finished = false;
  constructor(
    private readonly db: FakeDatabase,
    private readonly stores: Map<string, FakeObjectStore>,
  ) {}
  objectStore(name: string): FakeObjectStore {
    const store = this.stores.get(name);
    if (!store) throw new DOMException(`No store ${name}`, 'NotFoundError');
    store.tx = this;
    return store;
  }
  /** Queue one request; it settles on a microtask, the transaction after the loop turns. */
  run<T>(op: () => T, req: FakeRequest<T> = new FakeRequest<T>()): FakeRequest<T> {
    if (this.finished) throw new DOMException('Transaction finished', 'TransactionInactiveError');
    this.pending += 1;
    queueMicrotask(() => {
      if (this.finished) return;
      const abort = this.db.host.abortNextTransaction;
      if (abort) {
        this.db.host.abortNextTransaction = false;
        req.error = new DOMException('Injected abort', 'AbortError');
        req.readyState = 'done';
        req.onerror?.({ target: req });
        this.finished = true;
        this.error = req.error;
        this.onabort?.({ target: this });
        return;
      }
      try {
        req.result = op();
        req.readyState = 'done';
        req.onsuccess?.({ target: req });
      } catch (e) {
        req.error = e instanceof DOMException ? e : new DOMException(String(e), 'UnknownError');
        req.readyState = 'done';
        req.onerror?.({ target: req });
      }
      this.pending -= 1;
      setTimeout(() => {
        if (!this.finished && this.pending === 0) {
          this.finished = true;
          this.oncomplete?.({ target: this });
        }
      }, 0);
    });
    return req;
  }
}

class FakeDatabase {
  constructor(
    public readonly host: FakeIndexedDB,
    private readonly stores: Map<string, FakeObjectStore>,
  ) {}
  get objectStoreNames(): { contains(name: string): boolean } {
    return { contains: (name) => this.stores.has(name) };
  }
  createObjectStore(name: string): FakeObjectStore {
    const store = new FakeObjectStore(name);
    this.stores.set(name, store);
    return store;
  }
  transaction(name: string | string[], _mode?: string): FakeTransaction {
    const names = Array.isArray(name) ? name : [name];
    for (const n of names) if (!this.stores.has(n)) throw new DOMException(`No store ${n}`, 'NotFoundError');
    return new FakeTransaction(this, this.stores);
  }
  close(): void {
    /* nothing held open */
  }
}

export class FakeIndexedDB {
  private databases = new Map<string, { version: number; stores: Map<string, FakeObjectStore> }>();
  /** The next transaction's first request errors and the transaction aborts. */
  abortNextTransaction = false;
  /** Opening any database fails. */
  failOpen = false;

  open(name: string, version = 1): FakeRequest<FakeDatabase> & { onupgradeneeded: Listener; onblocked: Listener } {
    const req = Object.assign(new FakeRequest<FakeDatabase>(), { onupgradeneeded: null as Listener, onblocked: null as Listener });
    queueMicrotask(() => {
      if (this.failOpen) {
        req.error = new DOMException('Injected open failure', 'UnknownError');
        req.onerror?.({ target: req });
        return;
      }
      let entry = this.databases.get(name);
      const upgrade = !entry || entry.version < version;
      if (!entry) {
        entry = { version, stores: new Map() };
        this.databases.set(name, entry);
      }
      const db = new FakeDatabase(this, entry.stores);
      req.result = db;
      if (upgrade) {
        entry.version = version;
        req.onupgradeneeded?.({ target: req });
      }
      req.onsuccess?.({ target: req });
    });
    return req;
  }

  /** Every record in a store, for assertions. */
  records(dbName: string, store: string): Map<string, unknown> {
    return new Map(this.databases.get(dbName)?.stores.get(store)?.data ?? []);
  }

  reset(): void {
    this.databases.clear();
    this.abortNextTransaction = false;
    this.failOpen = false;
  }
}

/** Install a fresh fake as the global `indexedDB` and return it. */
export function installFakeIndexedDB(): FakeIndexedDB {
  const fake = new FakeIndexedDB();
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fake;
  return fake;
}
