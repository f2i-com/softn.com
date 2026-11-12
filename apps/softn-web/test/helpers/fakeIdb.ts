/**
 * As much of `idb` as the runtime's library and its editor's store use, kept
 * in memory: object stores by key path, indexes over one field, and
 * transactions. A test mocks `idb` with this
 * (`vi.mock('idb', () => import('./helpers/fakeIdb'))`) and the real modules
 * run over it.
 *
 * Writing transactions on a store run one at a time, in the order they were
 * opened, as IndexedDB runs them: the second one's first read waits until
 * the first is done, and so sees what the first wrote. Two writers that both
 * read before either wrote is exactly what a real database does not allow,
 * and a stand-in that allowed it hid a defect of that shape (the editor
 * taking its own overlapping save for another tab's). A transaction is done
 * once nothing more is asked of it by the time the page next has a turn,
 * which is when a browser commits one; asked for anything after that, it
 * refuses, as a browser's does.
 */

type Row = Record<string, unknown>;

interface Store {
  keyPath: string;
  indexes: Map<string, string>;
  rows: Map<unknown, Row>;
  /** Done when every writing transaction opened on this store so far is. */
  turn: Promise<void>;
}

type StoreApi = ReturnType<typeof api>;

/** A writing transaction's view of a store: each request waits its transaction's turn, and the transaction ends when it is left idle. */
function writing(store: Store): { store: StoreApi; done: Promise<void> } {
  const before = store.turn;
  let finish = (): void => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.turn = before.then(() => done);
  let pending = 0;
  let finished = false;
  let idle: ReturnType<typeof setTimeout> | null = setTimeout(commit, 0);
  function commit(): void {
    if (pending > 0 || finished) return;
    finished = true;
    finish();
  }
  const asked = <T>(work: () => Promise<T>): Promise<T> => {
    if (finished) return Promise.reject(new Error('The transaction has finished'));
    pending++;
    if (idle !== null) clearTimeout(idle);
    idle = null;
    return before.then(work).finally(() => {
      pending--;
      if (pending === 0) idle = setTimeout(commit, 0);
    });
  };
  const base = api(store);
  return {
    done,
    store: {
      ...base,
      get: (key) => asked(() => base.get(key)),
      getAll: () => asked(() => base.getAll()),
      put: (value) => asked(() => base.put(value)),
      add: (value) => asked(() => base.add(value)),
      delete: (key) => asked(() => base.delete(key)),
      index: (name) => {
        const index = base.index(name);
        return { get: (value) => asked(() => index.get(value)), getAll: (value) => asked(() => index.getAll(value)) };
      },
    },
  };
}

/** A read outside any writing transaction: after the writing transactions already opened on the store, as a browser orders it. */
function reading(store: Store): StoreApi {
  const base = api(store);
  const after = <T>(work: () => Promise<T>): Promise<T> => store.turn.then(work);
  return {
    ...base,
    get: (key) => after(() => base.get(key)),
    getAll: () => after(() => base.getAll()),
    index: (name) => {
      const index = base.index(name);
      return { get: (value) => after(() => index.get(value)), getAll: (value) => after(() => index.getAll(value)) };
    },
  };
}

const databases = new Map<string, Map<string, Store>>();

/** Forget every database: a test starts with none. */
export function resetFakeIdb(): void {
  databases.clear();
}

/** The rows of a store, for a test to look at; empty when there is none. */
export function fakeRows(database: string, store: string): Row[] {
  return [...(databases.get(database)?.get(store)?.rows.values() ?? [])].map((row) => structuredClone(row));
}

function api(store: Store) {
  const all = (): Row[] => [...store.rows.values()].map((row) => structuredClone(row));
  return {
    get: async (key: unknown) => {
      const row = store.rows.get(key);
      return row === undefined ? undefined : structuredClone(row);
    },
    getAll: async () => all(),
    put: async (value: Row) => {
      store.rows.set(value[store.keyPath], structuredClone(value));
      return value[store.keyPath];
    },
    add: async (value: Row) => {
      if (store.rows.has(value[store.keyPath])) throw new Error('A row with that key is there already');
      store.rows.set(value[store.keyPath], structuredClone(value));
      return value[store.keyPath];
    },
    delete: async (key: unknown) => {
      store.rows.delete(key);
    },
    createIndex: (name: string, field: string) => {
      store.indexes.set(name, field);
    },
    index: (name: string) => {
      const field = store.indexes.get(name);
      if (field === undefined) throw new Error(`No index ${name}`);
      return {
        get: async (value: unknown) => all().find((row) => row[field] === value),
        getAll: async (value: unknown) => all().filter((row) => row[field] === value),
      };
    },
  };
}

export async function openDB(
  name: string,
  version: number,
  options: { upgrade?: (db: unknown, oldVersion: number, newVersion: number, tx: unknown) => void } = {}
): Promise<unknown> {
  let stores = databases.get(name);
  const fresh = stores === undefined;
  if (!stores) databases.set(name, (stores = new Map()));
  const held = stores;
  const found = (store: string): Store => {
    const there = held.get(store);
    if (!there) throw new Error(`No object store ${store}`);
    return there;
  };
  const db = {
    createObjectStore: (store: string, { keyPath }: { keyPath: string }) => {
      held.set(store, { keyPath, indexes: new Map(), rows: new Map(), turn: Promise.resolve() });
      return api(found(store));
    },
    get: (store: string, key: unknown) => reading(found(store)).get(key),
    getAll: (store: string) => reading(found(store)).getAll(),
    // One request is a writing transaction of its own.
    put: (store: string, value: Row) => writing(found(store)).store.put(value),
    delete: (store: string, key: unknown) => writing(found(store)).store.delete(key),
    getFromIndex: (store: string, index: string, value: unknown) => reading(found(store)).index(index).get(value),
    getAllFromIndex: (store: string, index: string, value: unknown) => reading(found(store)).index(index).getAll(value),
    transaction: (store: string, mode: 'readonly' | 'readwrite' = 'readonly') => {
      if (mode !== 'readwrite') return { objectStore: (named: string = store) => reading(found(named)), done: Promise.resolve() };
      const opened = writing(found(store));
      return { objectStore: () => opened.store, done: opened.done };
    },
    close: () => {},
  };
  if (fresh) options.upgrade?.(db, 0, version, { objectStore: (store: string) => api(found(store)) });
  return db;
}
