/**
 * Peer sync on the desktop, where the records live in SQLite and the page's
 * cache is reloaded from it: a reload says what the native store lists, which
 * is not what this device removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('y-webrtc', () => ({ WebrtcProvider: class {} }));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {} }));

import { XDBService } from '../src/runtime/xdb';
import { XDBSyncAdapter } from '../src/runtime/xdb-sync';

type Row = { id: string; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string; deleted: boolean };

/** The native store: rows by id alone, `get_collection` lists the live ones (as SQLite's query does). */
function nativeStore() {
  const rows = new Map<string, Row>();
  let next = 0;
  const now = () => new Date().toISOString();
  const invoke = vi.fn(async (cmd: string, args: Record<string, any> = {}) => {
    switch (cmd) {
      case 'get_collections':
        return [...new Set([...rows.values()].map((r) => r.collection))];
      case 'get_collection':
        return [...rows.values()].filter((r) => r.collection === args.collection && !r.deleted);
      case 'create_record': {
        const row: Row = { id: `native-${++next}`, collection: args.payload.collection, data: args.payload.data, created_at: now(), updated_at: now(), deleted: false };
        rows.set(row.id, row);
        return row;
      }
      case 'update_record': {
        const row = rows.get(args.payload.id);
        if (!row) throw new Error('Record not found');
        const updated = { ...row, data: { ...row.data, ...args.payload.data }, updated_at: now() };
        rows.set(row.id, updated);
        return updated;
      }
      case 'delete_record': {
        const row = rows.get(args.id);
        if (!row || (args.collection !== undefined && row.collection !== args.collection)) return false;
        rows.set(row.id, { ...row, deleted: true, updated_at: now() });
        return true;
      }
      case 'upsert_record': {
        const record = args.record as Row;
        const held = rows.get(record.id);
        if (held && held.collection !== record.collection) throw new Error('record belongs to another collection');
        rows.set(record.id, record);
        return record;
      }
      case 'get_record': {
        const row = rows.get(args.id);
        if (!row) throw new Error('Record not found');
        return row;
      }
      case 'import_records':
        return { imported: 0, tombstoned: 0, collections: [] };
      default:
        throw new Error(`Unexpected command: ${cmd}`);
    }
  });
  return { rows, invoke };
}

function storage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

class Net {
  docs = new Set<Y.Doc>();
  queue: Array<[Y.Doc, Uint8Array]> = [];
  join(d: Y.Doc): void {
    for (const o of this.docs) Y.applyUpdate(d, Y.encodeStateAsUpdate(o), this);
    this.docs.add(d);
    d.on('update', (u: Uint8Array) => {
      for (const o of this.docs) if (o !== d) this.queue.push([o, u]);
    });
  }
  leave(d: Y.Doc): void {
    this.docs.delete(d);
  }
  flush(): void {
    while (this.queue.length) {
      const [d, u] = this.queue.shift()!;
      if (this.docs.has(d)) Y.applyUpdate(d, u, this);
    }
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let native: ReturnType<typeof nativeStore>;
beforeEach(() => {
  native = nativeStore();
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as any).__TAURI__ = { core: { invoke: native.invoke }, event: { listen: vi.fn(async () => () => {}) } };
});
afterEach(() => {
  delete (globalThis as any).__TAURI__;
});

async function desktop(name: string) {
  const xdb = new XDBService(undefined, name);
  await xdb.isReady;
  const adapter = new XDBSyncAdapter(xdb, { room: 'r', signaling: [], persist: false });
  return { xdb, adapter };
}

function browser(name: string) {
  const xdb = new XDBService(storage(), name, undefined, { backend: 'storage' });
  const adapter = new XDBSyncAdapter(xdb, { room: 'r', signaling: [], persist: false });
  return { xdb, adapter };
}

describe('peer sync on the desktop', () => {
  it('a reload of the native store does not take a deleted record\'s tombstone out of the room', async () => {
    const net = new Net();
    const d = await desktop('desk-tombstone');
    const w = browser('web-tombstone');
    net.join(d.adapter.doc);
    net.join(w.adapter.doc);
    d.adapter.attachLocal();
    w.adapter.attachLocal();
    const t1 = d.xdb.create('notes', { text: 'secret draft' });
    await settle();
    net.flush();
    const id = d.xdb.getAll('notes')[0].id;
    expect(w.xdb.get('notes', id)).not.toBeNull();
    // The browser is closed; the desktop deletes the note, and reads its notes (a <data> read).
    net.leave(w.adapter.doc);
    w.adapter.disconnect();
    d.xdb.delete(id);
    await settle();
    await d.xdb.getAllAsync('notes');
    await settle();
    // And writes something else, which announces the collection again.
    d.xdb.create('notes', { text: 'another' });
    await settle();
    expect((d.adapter.doc.getMap('notes').get(id) as { deleted?: boolean } | undefined)?.deleted).toBe(true);
    // The browser opens the app again, with the note it had.
    const again = new XDBSyncAdapter(w.xdb, { room: 'r', signaling: [], persist: false });
    net.join(again.doc);
    again.attachLocal();
    net.flush();
    await settle();
    expect(d.xdb.get('notes', id)).toBeNull();
    expect(native.rows.get(id)?.deleted).toBe(true);
    expect(w.xdb.get('notes', id)).toBeNull();
    void t1;
  });

  it('a peer\'s record whose native write has not landed stays in the room through a reload and a batch', async () => {
    const net = new Net();
    const d = await desktop('desk-pending');
    const w = browser('web-pending');
    net.join(d.adapter.doc);
    net.join(w.adapter.doc);
    d.adapter.attachLocal();
    w.adapter.attachLocal();
    // The native write of what the room brings lands late.
    const upsert = native.invoke.getMockImplementation()!;
    const held: Array<() => void> = [];
    native.invoke.mockImplementation((cmd: string, args?: Record<string, any>) =>
      cmd === 'upsert_record' ? new Promise((resolve) => held.push(() => resolve(upsert(cmd, args)))) : upsert(cmd, args));
    const fromWeb = w.xdb.create('notes', { text: 'from the browser' });
    net.flush();
    await d.xdb.getAllAsync('notes');
    // A function of the desktop app's writes something: one batch.
    d.xdb.suppressNotifications();
    d.xdb.create('notes', { text: 'desktop' });
    d.xdb.resumeNotifications();
    await settle();
    net.flush();
    expect(d.adapter.doc.getMap('notes').has(fromWeb.id)).toBe(true);
    expect(w.xdb.get('notes', fromWeb.id)).not.toBeNull();
    for (const land of held) land();
  });

  it('a peer\'s record this app removes for good inside a batch leaves the room', async () => {
    const net = new Net();
    const a = browser('remove-a');
    const b = browser('remove-b');
    net.join(a.adapter.doc);
    net.join(b.adapter.doc);
    a.adapter.attachLocal();
    b.adapter.attachLocal();
    const r = b.xdb.create('notes', { text: 'to remove' });
    net.flush();
    expect(a.xdb.get('notes', r.id)).not.toBeNull();
    a.xdb.suppressNotifications();
    a.xdb.hardDelete('notes', r.id);
    a.xdb.resumeNotifications();
    net.flush();
    expect(a.adapter.doc.getMap('notes').has(r.id)).toBe(false);
    expect(b.xdb.get('notes', r.id)).toBeNull();
  });

  it('a reload that finds nothing new announces nothing', async () => {
    const d = await desktop('desk-quiet');
    d.xdb.create('notes', { text: 'one' });
    await settle();
    await d.xdb.getAllAsync('notes');
    const heard = vi.fn();
    const off = d.xdb.subscribe('notes', heard);
    await d.xdb.getAllAsync('notes');
    await d.xdb.getAllAsync('notes');
    off();
    expect(heard).not.toHaveBeenCalled();
  });
});
