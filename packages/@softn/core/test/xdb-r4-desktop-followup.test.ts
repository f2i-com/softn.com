/**
 * The desktop's native writes, round 4 follow-ups: what a room's peers and the sync host
 * remove for good, text the native store cannot read, and one record's writes in order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('y-webrtc', () => ({ WebrtcProvider: class {} }));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {} }));

import { XDBService } from '../src/runtime/xdb';
import { XDBStorageError } from '../src/runtime/xdb-types';
import { XDBSyncAdapter } from '../src/runtime/xdb-sync';

type Row = { id: string; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string; deleted: boolean };

let rows: Map<string, Row>;
/** The first call of a command after `holdFirst` waits; the ones after it are answered at once. */
let heldFirst: Map<string, Promise<void>>;
let invoke: ReturnType<typeof vi.fn>;

const at = (minute: number) => new Date(Date.parse('2026-11-01T00:00:00.000Z') + minute * 60_000).toISOString();

function holdFirst(command: string): () => void {
  let release!: () => void;
  heldFirst.set(command, new Promise<void>((resolve) => { release = resolve; }));
  return () => release();
}

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;

/** What serde_json refuses at the IPC: a string or key holding half of a surrogate pair. */
function holdsLoneSurrogate(value: unknown): boolean {
  if (typeof value === 'string') return LONE.test(value);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, item]) => LONE.test(key) || holdsLoneSurrogate(item));
}

beforeEach(() => {
  rows = new Map();
  heldFirst = new Map();
  // The commands as crates/softn-xdb answers them.
  invoke = vi.fn(async (cmd: string, args: Record<string, any> = {}) => {
    const held = heldFirst.get(cmd);
    if (held) {
      heldFirst.delete(cmd);
      await held;
    }
    if (holdsLoneSurrogate(args)) throw new Error('lone leading surrogate in hex escape at line 1 column 40');
    switch (cmd) {
      case 'get_collections':
        return [...new Set([...rows.values()].map((r) => r.collection))];
      case 'get_collection':
        return [...rows.values()].filter((r) => r.collection === args.collection && (args.includeDeleted === true || !r.deleted));
      case 'create_record': {
        const id = args.payload.id ?? `minted-${rows.size}`;
        if (rows.has(id)) throw new Error(`A record with id ${id} already exists`);
        const now = new Date().toISOString();
        const row: Row = { id, collection: args.payload.collection, data: args.payload.data, created_at: now, updated_at: now, deleted: false };
        rows.set(row.id, row);
        return row;
      }
      case 'update_record': {
        // A shallow merge, refused for a record that is gone (db.rs update_record_batched).
        const row = rows.get(args.payload.id);
        if (!row || row.deleted) throw new Error(`Record not found: ${args.payload.id}`);
        if (args.payload.collection !== undefined && row.collection !== args.payload.collection) throw new Error('Refused');
        const updated = { ...row, data: { ...row.data, ...args.payload.data }, updated_at: args.payload.updated_at ?? new Date().toISOString() };
        rows.set(row.id, updated);
        return updated;
      }
      case 'delete_record': {
        // A tombstone, which keeps the record's data (db.rs delete_record).
        const row = rows.get(args.id);
        if (!row) throw new Error(`Record not found: ${args.id}`);
        if (args.collection !== undefined && row.collection !== args.collection) return false;
        rows.set(row.id, { ...row, deleted: true, updated_at: args.updatedAt ?? new Date().toISOString() });
        return true;
      }
      case 'upsert_record': {
        const there = rows.get(args.record.id);
        if (there && there.collection !== args.record.collection) throw new Error('record belongs to another collection');
        rows.set(args.record.id, args.record);
        return args.record;
      }
      case 'upsert_records': {
        const refused: string[] = [];
        for (const record of args.records as Row[]) {
          const there = rows.get(record.id);
          if (there && there.collection !== record.collection) refused.push(record.id);
          else rows.set(record.id, record);
        }
        return refused;
      }
      case 'remove_records': {
        // The rows go, with no tombstone (db.rs remove_records).
        const refused: string[] = [];
        for (const id of args.ids as string[]) {
          const there = rows.get(id);
          if (there && there.collection !== args.collection) refused.push(id);
          else rows.delete(id);
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
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

function note(id: string, minute: number, text: string): Row {
  return { id, collection: 'notes', data: { text }, created_at: at(minute), updated_at: at(minute), deleted: false };
}

const commands = () => invoke.mock.calls.map(([cmd]) => cmd as string);
const writeFailures = (xdb: XDBService) => xdb.getStorageStatus().issues.filter((issue) => issue.kind === 'write-failed');

describe("what a room's peers or the sync host remove for good, on the desktop", () => {
  it('leaves no row behind, one record or several, held here or not', async () => {
    for (let i = 1; i <= 5; i++) rows.set(`n${i}`, note(`n${i}`, i, `note ${i}`));
    const xdb = new XDBService(memoryStorage(), 'r4f-peer', 'r4f-peer-app');
    await xdb.isReady;
    xdb.removeRecords('notes', ['n1', 'n2'], { fromPeer: true });
    xdb.removeRecord('notes', 'n3', { fromPeer: true });
    xdb.deleteFromServer('notes', 'n4');
    await settle();
    expect([...rows.keys()]).toEqual(['n5']);
    expect(xdb.getAllRaw('notes').map((r) => r.id)).toEqual(['n5']);
    expect(writeFailures(xdb)).toEqual([]);
    xdb.destroy();
  });

  it('is no write failure for a record SQLite never had', async () => {
    rows.set('n1', note('n1', 1, 'kept'));
    const xdb = new XDBService(memoryStorage(), 'r4f-ghost', 'r4f-ghost-app');
    await xdb.isReady;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      xdb.removeRecord('notes', 'never-here', { fromPeer: true });
      xdb.removeRecords('notes', ['also-never', 'nor-this'], { fromPeer: true });
      await settle();
      expect(writeFailures(xdb)).toEqual([]);
      expect([...rows.keys()]).toEqual(['n1']);
    } finally {
      quiet.mockRestore();
      xdb.destroy();
    }
  });

  it('is not put back into the room at the next start', async () => {
    rows.set('n1', note('n1', 1, 'secret'));
    rows.set('n2', note('n2', 2, 'kept'));
    const storage = memoryStorage();
    const first = new XDBService(storage, 'r4f-room', 'r4f-room-app');
    await first.isReady;
    const joined = new XDBSyncAdapter(first, { room: 'r', signaling: [], persist: false });
    joined.attachLocal();
    // The room, as its peers hold it; one of them removes n1 for good.
    const room = new Y.Doc();
    Y.applyUpdate(room, Y.encodeStateAsUpdate(joined.doc));
    const seen = Y.encodeStateVector(joined.doc);
    room.getMap('notes').delete('n1');
    Y.applyUpdate(joined.doc, Y.encodeStateAsUpdate(room, seen), 'peer');
    await settle();
    expect(first.get('notes', 'n1')).toBeNull();
    joined.close();
    first.destroy();

    const next = new XDBService(storage, 'r4f-room', 'r4f-room-app');
    await next.isReady;
    const rejoined = new XDBSyncAdapter(next, { room: 'r', signaling: [], persist: false });
    Y.applyUpdate(rejoined.doc, Y.encodeStateAsUpdate(room), 'peer');
    rejoined.attachLocal();
    Y.applyUpdate(room, Y.encodeStateAsUpdate(rejoined.doc, Y.encodeStateVector(room)));
    expect(room.getMap('notes').has('n1')).toBe(false);
    expect(rows.has('n1')).toBe(false);
    rejoined.close();
    next.destroy();
  });
});

describe('text the desktop native store cannot read', () => {
  const cut = 'half an emoji: \ud83d';

  it('is refused by create and update before anything changes, as an import refuses it', async () => {
    rows.set('n1', note('n1', 1, 'as it was'));
    const xdb = new XDBService(memoryStorage(), 'r4f-lone', 'r4f-lone-app');
    await xdb.isReady;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      invoke.mockClear();
      const refusals: unknown[] = [];
      const attempt = (write: () => unknown) => {
        try {
          write();
        } catch (error) {
          refusals.push(error);
        }
      };
      attempt(() => xdb.create('notes', { text: cut }));
      attempt(() => xdb.create('notes', { [cut]: 'a key, too' }));
      attempt(() => xdb.update('n1', { text: cut }));
      attempt(() => xdb.updateInCollection('notes', 'n1', { text: `\udc00${cut}` }));
      await expect(xdb.createAsync('notes', { text: cut })).rejects.toBeInstanceOf(XDBStorageError);
      await expect(xdb.updateAsync('n1', { text: cut })).rejects.toBeInstanceOf(XDBStorageError);
      expect(refusals).toHaveLength(4);
      for (const refusal of refusals) {
        expect(refusal).toBeInstanceOf(XDBStorageError);
        expect((refusal as XDBStorageError).kind).toBe('invalid-data');
      }
      await settle();
      expect(commands().filter((cmd) => cmd === 'create_record' || cmd === 'update_record')).toEqual([]);
      expect(xdb.getAll('notes').map((r) => r.data.text)).toEqual(['as it was']);
      expect(rows.get('n1')?.data.text).toBe('as it was');
      expect(writeFailures(xdb)).toEqual([]);
      // Whole pairs are text like any other.
      const emoji = xdb.create('notes', { text: 'a whole one: 😀' });
      await settle();
      expect(rows.get(emoji.id)?.data.text).toBe('a whole one: 😀');
    } finally {
      quiet.mockRestore();
      xdb.destroy();
    }
  });

  it('is kept as before by browser storage', () => {
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    const xdb = new XDBService(memoryStorage(), 'r4f-lone-browser', undefined, { backend: 'storage' });
    const record = xdb.create('notes', { text: cut });
    expect(xdb.get('notes', record.id)?.data.text).toBe(cut);
    expect(xdb.update(record.id, { text: `${cut}!` })?.data.text).toBe(`${cut}!`);
  });
});

describe("one record's native writes on the desktop", () => {
  // Tauri runs each command on a thread of its own: a second write sent before the first was
  // answered could take the database first, and the first then wrote its older value over it.
  it('land in the order they were made, though the native side would take a later one first', async () => {
    rows.set('n1', note('n1', 1, 'first'));
    const xdb = new XDBService(memoryStorage(), 'r4f-order', 'r4f-order-app');
    await xdb.isReady;
    const release = holdFirst('update_record');
    xdb.update('n1', { text: 'second' });
    xdb.update('n1', { text: 'third' });
    await settle();
    release();
    await settle();
    expect(rows.get('n1')?.data.text).toBe('third');
    expect(xdb.get('notes', 'n1')?.data.text).toBe('third');
    expect(writeFailures(xdb)).toEqual([]);
    xdb.destroy();
  });

  it('send a deletion or a removal only after the edit before it', async () => {
    rows.set('n1', note('n1', 1, 'edited, then deleted'));
    rows.set('n2', note('n2', 2, 'edited, then removed'));
    rows.set('n3', note('n3', 3, 'edited in its collection, then deleted there'));
    const xdb = new XDBService(memoryStorage(), 'r4f-order-delete', 'r4f-order-delete-app');
    await xdb.isReady;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let release = holdFirst('update_record');
      xdb.update('n1', { text: 'edited' });
      expect(xdb.delete('n1')).toBe(true);
      await settle();
      release();
      await settle();
      release = holdFirst('update_record');
      xdb.update('n2', { text: 'edited' });
      expect(xdb.hardDelete('notes', 'n2')).toBe(true);
      await settle();
      release();
      await settle();
      release = holdFirst('update_record');
      xdb.updateInCollection('notes', 'n3', { text: 'edited' });
      expect(xdb.deleteFromCollection('notes', 'n3')).toBe(true);
      await settle();
      release();
      await settle();
      // Landed in order, the edit refused nothing: the record was there to edit.
      expect(writeFailures(xdb)).toEqual([]);
      expect(rows.get('n1')).toMatchObject({ deleted: true, data: { text: 'edited' } });
      expect(rows.has('n2')).toBe(false);
      expect(rows.get('n3')).toMatchObject({ deleted: true, data: { text: 'edited' } });
    } finally {
      quiet.mockRestore();
      xdb.destroy();
    }
  });

  it("send a room's copy only after an edit of the record still on its way", async () => {
    rows.set('n1', note('n1', 1, 'mine'));
    const xdb = new XDBService(memoryStorage(), 'r4f-order-peer', 'r4f-order-peer-app');
    await xdb.isReady;
    const release = holdFirst('update_record');
    xdb.update('n1', { text: 'edited here' });
    const theirs = { ...note('n1', 1, 'from the room'), updated_at: new Date(Date.now() + 60_000).toISOString() };
    xdb.writeRecord('notes', theirs);
    await settle();
    release();
    await settle();
    // What the page holds is what SQLite holds: the room's copy, written last.
    expect(xdb.get('notes', 'n1')?.data.text).toBe('from the room');
    expect(rows.get('n1')?.data.text).toBe('from the room');
    xdb.destroy();
  });

  it('are counted as on their way while they wait their turn', async () => {
    rows.set('n1', note('n1', 1, 'first'));
    const xdb = new XDBService(memoryStorage(), 'r4f-order-pending', 'r4f-order-pending-app');
    await xdb.isReady;
    const release = holdFirst('update_record');
    xdb.update('n1', { text: 'second' });
    xdb.update('n1', { text: 'third' });
    let idle = false;
    const waiting = xdb.whenIdle().then(() => { idle = true; });
    await settle();
    expect(xdb.hasPendingWrites()).toBe(true);
    expect(idle).toBe(false);
    release();
    await waiting;
    expect(rows.get('n1')?.data.text).toBe('third');
    expect(xdb.hasPendingWrites()).toBe(false);
    xdb.destroy();
  });
});
