/**
 * What the desktop keeps of a record removed for good (audit round 4): `hardDelete`, and
 * `db.prune` and `db.clearCollection` through `hardDeleteMany`, "remove the record outright,
 * without a tombstone". The native store could only write a tombstone, which keeps the
 * record's data: the page loaded it again at its next start, and its peer sync put it, data
 * and all, back into the room the removal was for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('y-webrtc', () => ({ WebrtcProvider: class {} }));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {} }));

import { XDBService } from '../src/runtime/xdb';
import { XDBSyncAdapter } from '../src/runtime/xdb-sync';

type Row = { id: string; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string; deleted: boolean };

let rows: Map<string, Row>;
let gate: Map<string, Promise<void>>;
let invoke: ReturnType<typeof vi.fn>;

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
  gate = new Map();
  // The commands as crates/softn-xdb answers them.
  invoke = vi.fn(async (cmd: string, args: Record<string, any> = {}) => {
    const held = gate.get(cmd);
    if (held) await held;
    switch (cmd) {
      case 'get_collections':
        return [...new Set([...rows.values()].map((r) => r.collection))];
      case 'get_collection':
        return [...rows.values()].filter((r) => r.collection === args.collection && (args.includeDeleted === true || !r.deleted));
      case 'create_record': {
        if (rows.has(args.payload.id)) throw new Error(`A record with id ${args.payload.id} already exists`);
        const now = new Date().toISOString();
        const row: Row = { id: args.payload.id, collection: args.payload.collection, data: args.payload.data, created_at: now, updated_at: now, deleted: false };
        rows.set(row.id, row);
        return row;
      }
      case 'delete_record': {
        // A tombstone, which keeps the record's data (db.rs delete_record).
        const row = rows.get(args.id);
        if (!row) throw new Error(`Record not found: ${args.id}`);
        if (args.collection !== undefined && row.collection !== args.collection) return false;
        rows.set(row.id, { ...row, deleted: true, updated_at: args.updatedAt ?? new Date().toISOString() });
        return true;
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
      case 'get_record': {
        const row = rows.get(args.id);
        if (!row) throw new Error(`Record not found: ${args.id}`);
        return row;
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
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** What the page keeps beside its records (the removals a room is still to be told of). */
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

describe('a record removed for good on the desktop', () => {
  it('leaves no row behind, and is not loaded again at the next start', async () => {
    rows.set('n1', note('n1', 1, 'secret'));
    rows.set('n2', note('n2', 2, 'kept'));
    const storage = memoryStorage();
    const first = new XDBService(storage, 'r4-remove', 'r4-remove-app');
    await first.isReady;
    expect(first.hardDelete('notes', 'n1')).toBe(true);
    await settle();
    expect(first.getStorageStatus().issues).toEqual([]);
    first.destroy();
    expect(rows.has('n1')).toBe(false);

    const next = new XDBService(storage, 'r4-remove', 'r4-remove-app');
    await next.isReady;
    expect(next.getAllRaw('notes').map((r) => r.id)).toEqual(['n2']);
    next.destroy();
  });

  it('by a prune of several, leaves no rows behind, in one native call', async () => {
    for (let i = 0; i < 6; i++) rows.set(`n${i}`, note(`n${i}`, i, `note ${i}`));
    const xdb = new XDBService(memoryStorage(), 'r4-prune', 'r4-prune-app');
    await xdb.isReady;
    invoke.mockClear();
    expect(xdb.hardDeleteMany('notes', ['n0', 'n1', 'n2', 'n3'])).toBe(4);
    await settle();
    const commands = invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands.filter((cmd) => cmd === 'remove_records')).toHaveLength(1);
    expect([...rows.keys()].sort()).toEqual(['n4', 'n5']);
    expect(xdb.getAllRaw('notes').map((r) => r.id)).toEqual(['n4', 'n5']);
    expect(xdb.getStorageStatus().state).toBe('ready');
    xdb.destroy();
  });

  it('while its create is on its way, leaves no row once the create lands', async () => {
    const xdb = new XDBService(memoryStorage(), 'r4-unborn', 'r4-unborn-app');
    await xdb.isReady;
    const land = hold('create_record');
    const pending = xdb.create('notes', { text: 'gone before it was stored' });
    expect(xdb.hardDelete('notes', pending.id)).toBe(true);
    land();
    await settle();
    expect(rows.has(pending.id)).toBe(false);
    expect(xdb.getAllRaw('notes')).toEqual([]);
    expect(xdb.getStorageStatus().issues).toEqual([]);
    xdb.destroy();
  });

  it('is not brought back by a read made while its native removal is on its way', async () => {
    rows.set('n1', note('n1', 1, 'secret'));
    rows.set('n2', note('n2', 2, 'kept'));
    const xdb = new XDBService(memoryStorage(), 'r4-in-flight', 'r4-in-flight-app');
    await xdb.isReady;
    const land = hold('remove_records');
    expect(xdb.hardDelete('notes', 'n1')).toBe(true);
    // What a desktop <data> block reads after a write, and a script's getAsync: SQLite still
    // holds the record until the removal lands.
    expect((await xdb.getAllAsync('notes')).map((r) => r.id)).toEqual(['n2']);
    expect(await xdb.getAsync('notes', 'n1')).toBeNull();
    land();
    await settle();
    expect(rows.has('n1')).toBe(false);
    expect(xdb.getAllRaw('notes').map((r) => r.id)).toEqual(['n2']);
    xdb.destroy();
  });

  it('is not put back into the room by the next start, and the room is told', async () => {
    rows.set('n1', note('n1', 1, 'secret'));
    rows.set('n2', note('n2', 2, 'kept'));
    const storage = memoryStorage();
    // The room, as its peers hold it: this device put both notes there.
    const room = new Y.Doc();
    const first = new XDBService(storage, 'r4-room', 'r4-room-app');
    await first.isReady;
    const joined = new XDBSyncAdapter(first, { room: 'r', signaling: [], persist: false });
    joined.attachLocal();
    Y.applyUpdate(room, Y.encodeStateAsUpdate(joined.doc));
    expect(room.getMap('notes').has('n1')).toBe(true);
    joined.close();

    // Removed while the app is out of the room, then SoftN is closed.
    expect(first.hardDelete('notes', 'n1')).toBe(true);
    await settle();
    first.destroy();

    const next = new XDBService(storage, 'r4-room', 'r4-room-app');
    await next.isReady;
    const rejoined = new XDBSyncAdapter(next, { room: 'r', signaling: [], persist: false });
    Y.applyUpdate(rejoined.doc, Y.encodeStateAsUpdate(room), 'peer');
    rejoined.attachLocal();
    Y.applyUpdate(room, Y.encodeStateAsUpdate(rejoined.doc, Y.encodeStateVector(room)));
    expect(room.getMap('notes').has('n1')).toBe(false);
    expect(next.getAllRaw('notes').map((r) => r.id)).toEqual(['n2']);
    rejoined.close();
    next.destroy();
  });
});
