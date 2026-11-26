/**
 * The desktop's native store (SQLite behind Tauri) as the page's cache holds
 * it (audit round 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XDBService } from '../src/runtime/xdb';

type Row = { id: string; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string; deleted: boolean };

let rows: Map<string, Row>;
let refuse: Set<string>;
let invoke: ReturnType<typeof vi.fn>;
/** Commands held until released, for a native write that lands late. */
let gate: Map<string, Promise<void>>;

const at = (minute: number) => new Date(Date.parse('2026-11-01T00:00:00.000Z') + minute * 60_000).toISOString();

/** Hold `command` until the function answered is called. */
function hold(command: string): () => void {
  let release!: () => void;
  gate.set(command, new Promise<void>((resolve) => { release = resolve; }));
  return () => {
    gate.delete(command);
    release();
  };
}

beforeEach(() => {
  rows = new Map();
  refuse = new Set();
  gate = new Map();
  invoke = vi.fn(async (cmd: string, args: Record<string, any> = {}) => {
    const held = gate.get(cmd);
    if (held) await held;
    if (refuse.has(cmd)) throw new Error('SQLITE_READONLY: attempt to write a readonly database');
    switch (cmd) {
      case 'get_collections':
        return [...new Set([...rows.values()].map((r) => r.collection))];
      case 'get_collection':
        // As crates/softn-xdb db.rs reads a collection: ORDER BY created_at DESC.
        return [...rows.values()]
          .filter((r) => r.collection === args.collection && (args.includeDeleted === true || !r.deleted))
          .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
      case 'create_record': {
        const row: Row = { id: args.payload.id, collection: args.payload.collection, data: args.payload.data, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted: false };
        rows.set(row.id, row);
        return row;
      }
      case 'update_record': {
        const row = rows.get(args.payload.id);
        if (!row) throw new Error('Record not found');
        if (args.payload.collection !== undefined && row.collection !== args.payload.collection) throw new Error('Refused');
        const updated = { ...row, data: { ...row.data, ...args.payload.data }, updated_at: args.payload.updated_at ?? new Date().toISOString() };
        rows.set(row.id, updated);
        return updated;
      }
      case 'get_record': {
        const row = rows.get(args.id);
        if (!row) throw new Error(`Record not found: ${args.id}`);
        return row;
      }
      case 'delete_record': {
        const row = rows.get(args.id);
        if (!row) throw new Error(`Record not found: ${args.id}`);
        if (args.collection !== undefined && row.collection !== args.collection) return false;
        rows.set(row.id, { ...row, deleted: true, updated_at: args.updatedAt ?? new Date().toISOString() });
        return true;
      }
      case 'upsert_records': {
        const refused: string[] = [];
        for (const record of args.records as Row[]) {
          const held = rows.get(record.id);
          if (held && held.collection !== record.collection) refused.push(record.id);
          else rows.set(record.id, record);
        }
        return refused;
      }
      default:
        throw new Error(`Unexpected command: ${cmd}`);
    }
  });
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } };
});

afterEach(() => {
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

describe('the order of a collection on the desktop', () => {
  // SQLite lists a collection newest first, and the cache took that order: an
  // app's unsorted list was reversed on the desktop after every restart (in the
  // browser, and on the desktop until it restarted, records are in the order
  // they were made), and a record made after the restart went to the end,
  // below the oldest.
  it('is the order records were made, as in the browser, after a load and after a write', async () => {
    for (const [id, minute] of [['a', 1], ['b', 2], ['c', 3]] as const) {
      rows.set(id, { id, collection: 'notes', data: { id }, created_at: at(minute), updated_at: at(minute), deleted: false });
    }
    const xdb = new XDBService(undefined, 'r3-order');
    await xdb.isReady;
    expect(xdb.getAll('notes').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(xdb.query('notes').map((r) => r.id)).toEqual(['a', 'b', 'c']);

    const d = xdb.create('notes', { id: 'd' });
    await settle();
    expect(xdb.getAll('notes').map((r) => r.id)).toEqual(['a', 'b', 'c', d.id]);

    // What the native store gained meanwhile (another window, a peer) comes after, in the order made.
    rows.set('e', { id: 'e', collection: 'notes', data: {}, created_at: at(10), updated_at: at(10), deleted: false });
    rows.set('f', { id: 'f', collection: 'notes', data: {}, created_at: at(11), updated_at: at(11), deleted: false });
    const read = await xdb.getAllAsync('notes');
    expect(read.map((r) => r.id)).toEqual(['a', 'b', 'c', d.id, 'e', 'f']);

    // The browser's order, for the same records made in the same order.
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    const web = new XDBService(memoryStorage(), 'r3-order-web', undefined, { backend: 'storage' });
    const made = ['a', 'b', 'c'].map((id) => web.create('notes', { id }).id);
    expect(web.getAll('notes').map((r) => r.id)).toEqual(made);
    xdb.destroy();
  });
});

describe('an edit of a record named by its collection, on the desktop', () => {
  // updateInCollection's native refusal was only logged: the storage status,
  // which the host's notice bar watches, said every change was saved.
  it('says when SQLite refuses it, and stops saying so once a change lands', async () => {
    rows.set('n1', { id: 'n1', collection: 'notes', data: { text: 'a' }, created_at: at(1), updated_at: at(1), deleted: false });
    const xdb = new XDBService(undefined, 'r3-scoped-edit');
    await xdb.isReady;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      refuse.add('update_record');
      expect(xdb.updateInCollection('notes', 'n1', { text: 'b' })?.data.text).toBe('b');
      await settle();
      const status = xdb.getStorageStatus();
      expect(status.state).toBe('degraded');
      expect(status.issues.some((issue) => issue.kind === 'write-failed' && issue.collection === 'notes')).toBe(true);

      refuse.delete('update_record');
      xdb.updateInCollection('notes', 'n1', { text: 'c' });
      await settle();
      expect(rows.get('n1')?.data.text).toBe('c');
      expect(xdb.getStorageStatus().issues.some((issue) => issue.kind === 'write-failed')).toBe(false);
      expect(xdb.getStorageStatus().state).toBe('ready');
    } finally {
      quiet.mockRestore();
      xdb.destroy();
    }
  });
});

describe('getAsync on the desktop', () => {
  // The native store finds a record by id alone: getAsync('notes', id) answered
  // a record of another collection, where the browser (and get) answer none.
  it('answers only a record of the collection asked for', async () => {
    rows.set('c1', { id: 'c1', collection: 'comments', data: { text: 'a comment' }, created_at: at(1), updated_at: at(1), deleted: false });
    const xdb = new XDBService(undefined, 'r3-get-collection');
    await xdb.isReady;
    expect(xdb.get('notes', 'c1')).toBeNull();
    expect(await xdb.getAsync('notes', 'c1')).toBeNull();
    expect((await xdb.getAsync('comments', 'c1'))?.data.text).toBe('a comment');
    xdb.destroy();
  });

  // A record made with create() is the page's at once; SQLite has it once the
  // native create lands. getAsync asked SQLite alone, and answered null for it.
  it('answers a record made here whose native create has not landed', async () => {
    const xdb = new XDBService(undefined, 'r3-get-pending');
    await xdb.isReady;
    const release = hold('create_record');
    const made = xdb.create('notes', { text: 'just made' });
    expect((await xdb.getAsync('notes', made.id))?.data.text).toBe('just made');
    release();
    await settle();
    expect((await xdb.getAsync('notes', made.id))?.data.text).toBe('just made');
    xdb.destroy();
  });
});

describe('updateAsync and deleteAsync of a record whose native create has not landed', () => {
  // SQLite has no row to change until the create lands: the change was refused
  // as not found, answered null or false, and lost (the record stayed as made,
  // in the cache and in SQLite). update() and delete() keep such a change for
  // the create to send once its row exists; these do the same now.
  it('keeps the edit, which reaches SQLite once the create lands', async () => {
    const xdb = new XDBService(undefined, 'r3-update-pending');
    await xdb.isReady;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const release = hold('create_record');
      const made = xdb.create('notes', { text: 'draft' });
      const edited = await xdb.updateAsync(made.id, { text: 'final' });
      expect(edited?.data.text).toBe('final');
      release();
      await settle();
      expect(rows.get(made.id)?.data.text).toBe('final');
      expect(xdb.get('notes', made.id)?.data.text).toBe('final');
    } finally {
      quiet.mockRestore();
      xdb.destroy();
    }
  });

  it('keeps the deletion, which reaches SQLite once the create lands', async () => {
    const xdb = new XDBService(undefined, 'r3-delete-pending');
    await xdb.isReady;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const release = hold('create_record');
      const made = xdb.create('notes', { text: 'mistake' });
      expect(await xdb.deleteAsync(made.id)).toBe(true);
      expect(xdb.get('notes', made.id)).toBeNull();
      release();
      await settle();
      expect(rows.get(made.id)?.deleted).toBe(true);
      expect(xdb.get('notes', made.id)).toBeNull();
    } finally {
      quiet.mockRestore();
      xdb.destroy();
    }
  });
});

describe('an edit or a deletion by id alone, on the desktop', () => {
  // The cache can hold a record under an id SQLite keeps in another
  // collection: a peer's (or the sync host's) record the native store refused
  // as another collection's stays in the cache. update(id) and delete(id) found
  // it there and sent SQLite the id alone, which reached the other collection's
  // record: the edit was merged into it, or it was deleted.
  it('names the collection it changed, so a record of another collection in SQLite is not changed', async () => {
    rows.set('p0', { id: 'p0', collection: 'public', data: { text: 'shared' }, created_at: at(1), updated_at: at(1), deleted: false });
    rows.set('s1', { id: 's1', collection: 'secrets', data: { text: 'private' }, created_at: at(2), updated_at: at(2), deleted: false });
    const xdb = new XDBService(undefined, 'r3-by-id');
    await xdb.isReady;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A peer's record in `public` under the private record's id: SQLite refuses it, the cache keeps it.
      xdb.writePeerRecords('public', [{ id: 's1', collection: 'public', data: { text: 'planted' }, created_at: at(3), updated_at: at(3), deleted: false }]);
      await settle();
      expect(xdb.get('public', 's1')?.data.text).toBe('planted');

      xdb.update('s1', { text: 'edited' });
      await settle();
      expect(rows.get('s1')).toMatchObject({ collection: 'secrets', data: { text: 'private' }, deleted: false });

      xdb.delete('s1');
      await settle();
      expect(rows.get('s1')).toMatchObject({ collection: 'secrets', data: { text: 'private' }, deleted: false });
    } finally {
      quiet.mockRestore();
      xdb.destroy();
    }
  });
});

describe('what the desktop store keeps of the records it made', () => {
  // Each record made here left an entry mapping its id to SQLite's, kept for the
  // life of the page, the records removed since included: an app that made and
  // pruned records all day held one more entry for each, without end.
  it('is bounded, however many records are made and removed', async () => {
    const xdb = new XDBService(undefined, 'r3-made-many');
    await xdb.isReady;
    for (let round = 0; round < 6; round++) {
      const made = Array.from({ length: 2_000 }, (_, i) => xdb.create('log', { round, i }).id);
      await settle();
      xdb.hardDeleteMany('log', made);
      await settle();
    }
    expect(xdb.getAll('log')).toHaveLength(0);
    expect((xdb as unknown as { optimisticIdMap: Map<string, string> }).optimisticIdMap.size).toBeLessThanOrEqual(10_000);
    xdb.destroy();
  });
});

describe('hardDeleteMany on the desktop', () => {
  // db.prune and db.clearCollection remove records with it. On the desktop each
  // record was its own native delete_record, and each rewrote the collection's
  // whole CRDT document in SQLite: pruning thousands of records cost minutes.
  it('removes the records in one native call', async () => {
    for (let i = 0; i < 20; i++) {
      rows.set(`n${i}`, { id: `n${i}`, collection: 'notes', data: { i }, created_at: at(i), updated_at: at(i), deleted: false });
    }
    const xdb = new XDBService(undefined, 'r3-prune');
    await xdb.isReady;
    const heard: string[] = [];
    const off = xdb.subscribe('notes', (event) => heard.push(event.type));
    invoke.mockClear();
    const ids = Array.from({ length: 15 }, (_, i) => `n${i}`);
    expect(xdb.hardDeleteMany('notes', ids)).toBe(15);
    off();
    await settle();
    const commands = invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands.filter((cmd) => cmd === 'delete_record')).toHaveLength(0);
    expect(commands.filter((cmd) => cmd === 'upsert_records')).toHaveLength(1);
    for (const id of ids) expect(rows.get(id)?.deleted).toBe(true);
    expect(rows.get('n15')?.deleted).toBe(false);
    expect(xdb.getAll('notes').map((r) => r.id)).toEqual(['n15', 'n16', 'n17', 'n18', 'n19']);
    expect(xdb.getAllRaw('notes').map((r) => r.id)).toEqual(['n15', 'n16', 'n17', 'n18', 'n19']);
    // One refresh for the batch, as in the browser.
    expect(heard).toEqual(['refresh']);
    expect(xdb.getStorageStatus().state).toBe('ready');
    xdb.destroy();
  });

  it('says when SQLite refuses the removal', async () => {
    for (let i = 0; i < 3; i++) {
      rows.set(`n${i}`, { id: `n${i}`, collection: 'notes', data: { i }, created_at: at(i), updated_at: at(i), deleted: false });
    }
    const xdb = new XDBService(undefined, 'r3-prune-refused');
    await xdb.isReady;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      refuse.add('upsert_records');
      refuse.add('delete_record');
      expect(xdb.hardDeleteMany('notes', ['n0', 'n1'])).toBe(2);
      await settle();
      expect(xdb.getStorageStatus().issues.some((issue) => issue.kind === 'write-failed' && issue.collection === 'notes')).toBe(true);
    } finally {
      quiet.mockRestore();
      xdb.destroy();
    }
  });
});
