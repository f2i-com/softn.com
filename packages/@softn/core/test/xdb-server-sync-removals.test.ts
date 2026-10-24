/**
 * A record removed for good (hardDelete, a prune, clearCollection) while no
 * server sync client listened: before the person allowed sync, while the
 * client's module loaded, or after a stop. Each removal is told to a client
 * that listens, as a delete; one made while none did left no trace (no
 * tombstone for the scan to find), the host kept the record, and the next pull
 * wrote it back here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XDBService } from '../src/runtime/xdb';
import { XDBServerSync } from '../src/runtime/xdb-server-sync';

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static made: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.made.push(this);
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const WS_URL = 'wss://sync.example.test/sync';

function storage() {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => { kept.set(key, value); },
    removeItem: (key: string) => { kept.delete(key); },
  };
}

const page = (backing: ReturnType<typeof storage>) => new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });

const row = (id: string, title: string) => ({
  id, collection: 'notes', data: { title }, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', serverReceivedAt: '2026-02-01T00:00:00.000Z',
});
const HOST_HOLDS = [row('n1', 'one'), row('n2', 'two')];

/** A client that connects and pulls what the host holds; `listed: false` names no collections. */
function connect(store: XDBService, listed = true) {
  const sync = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', ...(listed ? { collections: ['notes'] } : {}), reconnectDelay: 60_000 });
  sync.connect();
  const socket = FakeSocket.made[FakeSocket.made.length - 1];
  socket.open();
  socket.receive({ type: 'auth_ok', clientId: `c${FakeSocket.made.length}`, serverTime: new Date().toISOString() });
  socket.receive({ type: 'sync_state', collection: 'notes', records: HOST_HOLDS });
  return { sync, socket };
}

const pushed = (socket: FakeSocket) =>
  socket.sent.filter((m) => m.type === 'sync_push').flatMap((m) => m.ops as Array<{ id: string; operation: string; recordId: string }>);
const deletes = (socket: FakeSocket) => pushed(socket).filter((op) => op.operation === 'delete').map((op) => op.recordId).sort();
const live = (store: XDBService) => store.getAll('notes').map((r) => r.id).sort();
const tick = () => Promise.resolve();

/** A store that has synced: its last visit pulled n1 and n2, and stopped. */
async function synced(backing: ReturnType<typeof storage>) {
  const first = connect(page(backing));
  await tick();
  vi.advanceTimersByTime(1000);
  first.sync.disconnect();
  vi.advanceTimersByTime(60_000);
}

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers({ now: new Date('2026-03-01T00:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a record removed for good before the client listened', () => {
  it('is deleted on the host when the client starts, and the pull does not bring it back', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    expect(live(store)).toEqual(['n1', 'n2']);
    store.hardDelete('notes', 'n1');
    vi.advanceTimersByTime(500);

    const { socket } = connect(store);
    await tick();
    expect(deletes(socket)).toEqual(['n1']);
    expect(live(store)).toEqual(['n2']);
  });

  it('is told for each record a clearCollection took', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    store.clear('notes');
    const { socket } = connect(store);
    await tick();
    expect(deletes(socket)).toEqual(['n1', 'n2']);
    expect(live(store)).toEqual([]);
  });

  // A clear takes its collection off the store's list, and a client naming no collections
  // looked for removals only in the listed ones.
  it('is told for a cleared collection by a client that names no collections', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    store.clear('notes');
    const { socket } = connect(store, false);
    await tick();
    expect(deletes(socket)).toEqual(['n1', 'n2']);
  });

  it('is told for a record deleted while nothing listened and then taken away by an import', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    store.deleteFromCollection('notes', 'n1');
    store.import({ version: 1, exportedAt: new Date().toISOString(), collections: { notes: [store.get('notes', 'n2')!] } }, { merge: false });
    const { socket } = connect(store);
    await tick();
    expect(deletes(socket)).toEqual(['n1']);
  });

  it('is told for each record an import replacing the collection took', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    store.import({ version: 1, exportedAt: new Date().toISOString(), collections: { notes: [store.get('notes', 'n2')!] } }, { merge: false });
    const { socket } = connect(store);
    await tick();
    expect(deletes(socket)).toEqual(['n1']);
    expect(live(store)).toEqual(['n2']);
  });

  it('is told after the client goes offline and the page closes, by the next visit', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    store.hardDelete('notes', 'n1');
    // A client that starts offline, and the page closes before it connects.
    const sync = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    sync.connect();
    await tick();
    sync.disconnect();

    const { socket } = connect(page(backing));
    await tick();
    expect(deletes(socket)).toEqual(['n1']);
  });

  it('is done when the host says it never had the record, and nothing is reported', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    store.create('notes', { title: 'never sent' }, { id: 'n9' });
    store.hardDelete('notes', 'n9');
    const { sync, socket } = connect(store);
    await tick();
    const removal = pushed(socket).find((op) => op.recordId === 'n9' && op.operation === 'delete');
    expect(removal).toBeDefined();
    const refused = vi.fn();
    sync.on('reject', refused);
    socket.receive({ type: 'sync_reject', opId: removal!.id, reason: 'Operation failed: Record not found: n9' });
    await tick();
    expect(refused).not.toHaveBeenCalled();
    expect(store.getStorageStatus().issues).toEqual([]);
  });
});
