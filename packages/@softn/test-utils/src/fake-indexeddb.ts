/**
 * Enough of IndexedDB for the hand-off protocol to run under Node: open with
 * a version and an upgrade, object stores with out-of-line keys, get, put,
 * delete and a forward cursor, and transactions that commit once no request
 * is pending — or abort on demand, so a claim whose transaction never
 * commits can be shown not to count as a delivery.
 *
 * Transactions are scheduled as a browser schedules them: one starts only
 * once every transaction made before it on any of its stores has finished,
 * unless both are read-only. Until it starts, its requests wait. Each request
 * used to run on its own, so two read-write transactions on one store
 * interleaved (both read, then both wrote), which no browser does, and a test
 * could pass here that a browser would fail.
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
  /** Whether it may run its requests yet (see FakeIndexedDB.schedule). */
  started = false;
  /** Requests made before it started, in order. */
  private waiting: Array<() => void> = [];
  private requests = 0;
  constructor(
    private readonly db: FakeDatabase,
    private readonly stores: Map<string, FakeObjectStore>,
    readonly mode: 'readonly' | 'readwrite',
    readonly scope: readonly string[],
  ) {
    // A transaction given no request in the task that made it commits when that task ends, as
    // in a browser; it would otherwise hold back every transaction made after it.
    setTimeout(() => {
      if (this.requests === 0) this.whenStarted(() => this.complete());
    }, 0);
  }

  /** Run `step` now if it has started, else when it does. */
  private whenStarted(step: () => void): void {
    if (this.started) step();
    else this.waiting.push(step);
  }

  /** Told by the host that it may run: what was asked of it meanwhile runs, in order. */
  start(): void {
    this.started = true;
    for (const step of this.waiting.splice(0)) step();
  }

  private complete(): void {
    if (this.finished) return;
    this.finished = true;
    this.db.host.finished(this);
    this.oncomplete?.({ target: this });
  }
  objectStore(name: string): FakeObjectStore {
    const store = this.stores.get(name);
    if (!store) throw new DOMException(`No store ${name}`, 'NotFoundError');
    // A handle of this transaction's own over the store's rows: the store was handed out
    // itself, with the transaction that last asked for it written on it, so a request made
    // through one transaction's handle could be run by another transaction.
    return Object.create(store, { tx: { value: this } }) as FakeObjectStore;
  }
  /** Queue one request; once the transaction has started it settles on a microtask, the transaction after the loop turns. */
  run<T>(op: () => T, req: FakeRequest<T> = new FakeRequest<T>()): FakeRequest<T> {
    if (this.finished) throw new DOMException('Transaction finished', 'TransactionInactiveError');
    this.pending += 1;
    this.requests += 1;
    this.whenStarted(() => queueMicrotask(() => {
      if (this.finished) return;
      const abort = this.db.host.abortNextTransaction;
      if (abort) {
        this.db.host.abortNextTransaction = false;
        req.error = new DOMException('Injected abort', 'AbortError');
        req.readyState = 'done';
        req.onerror?.({ target: req });
        this.finished = true;
        this.error = req.error;
        this.db.host.finished(this);
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
        if (!this.finished && this.pending === 0) this.complete();
      }, 0);
    }));
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
  transaction(name: string | string[], mode?: string): FakeTransaction {
    const names = Array.isArray(name) ? name : [name];
    for (const n of names) if (!this.stores.has(n)) throw new DOMException(`No store ${n}`, 'NotFoundError');
    const tx = new FakeTransaction(this, this.stores, mode === 'readwrite' ? 'readwrite' : 'readonly', names);
    this.host.schedule(tx, this.stores);
    return tx;
  }
  close(): void {
    /* nothing held open */
  }
}

export class FakeIndexedDB {
  private databases = new Map<string, { version: number; stores: Map<string, FakeObjectStore> }>();
  /** Transactions not finished yet, in the order they were made, with the database (its stores) each is on. */
  private live: Array<{ tx: FakeTransaction; stores: Map<string, FakeObjectStore> }> = [];

  /** A transaction was made: it starts now if nothing made before it is in its way. */
  schedule(tx: FakeTransaction, stores: Map<string, FakeObjectStore>): void {
    this.live.push({ tx, stores });
    this.startWhatCan();
  }

  /** A transaction committed or aborted: what was waiting for it may start. */
  finished(tx: FakeTransaction): void {
    this.live = this.live.filter((entry) => entry.tx !== tx);
    this.startWhatCan();
  }

  /**
   * Start each waiting transaction that no earlier unfinished one on the same
   * database shares a store with, unless both of them only read.
   */
  private startWhatCan(): void {
    this.live.forEach((entry, index) => {
      if (entry.tx.started) return;
      const blocked = this.live.slice(0, index).some(
        (earlier) =>
          earlier.stores === entry.stores &&
          earlier.tx.scope.some((name) => entry.tx.scope.includes(name)) &&
          (earlier.tx.mode === 'readwrite' || entry.tx.mode === 'readwrite'),
      );
      if (!blocked) entry.tx.start();
    });
  }
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
    this.live = [];
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
