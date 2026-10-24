/**
 * The store's note of changes made while no server sync client listened
 * (XDBService.noteUnheard), kept beside the records for a store that has
 * synced, for the next page whose client starts.
 *
 * A page that wrote and closed before its client listened left nothing the
 * next page could tell from a record heard from the host: its edits went at
 * their own stamps, without the offset, so on a device behind the host they
 * lost to edits other devices made in between; an import's records, at the
 * backup's older stamps, were not found at all.
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
    kept,
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => { kept.set(key, value); },
    removeItem: (key: string) => { kept.delete(key); },
  };
}

const page = (backing: Pick<ReturnType<typeof storage>, 'getItem' | 'setItem' | 'removeItem'>) => new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });

/** The host's clock, a minute ahead of this device's. */
const hostTime = () => new Date(Date.now() + 60_000).toISOString();

function connect(store: XDBService) {
  const sync = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
  sync.connect();
  const socket = FakeSocket.made[FakeSocket.made.length - 1];
  socket.open();
  socket.receive({ type: 'auth_ok', clientId: `c${FakeSocket.made.length}`, serverTime: hostTime() });
  return { sync, socket };
}

const row = (id: string, title: string, at: string) => ({ id, collection: 'notes', data: { title }, createdAt: at, updatedAt: at, serverReceivedAt: at });
const pushed = (socket: FakeSocket) =>
  socket.sent.filter((m) => m.type === 'sync_push').flatMap((m) => m.ops as Array<{ operation: string; recordId: string; timestamp: string; data?: { title?: string } }>);
const tick = () => Promise.resolve();

/** A store whose last visit pulled n1 from the host and stopped. */
async function synced(backing: ReturnType<typeof storage>) {
  const first = connect(page(backing));
  first.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
  await tick();
  first.sync.disconnect();
  vi.advanceTimersByTime(1000);
}

/** The next visit's client: what it pushes once the pull is in. */
async function nextVisit(backing: ReturnType<typeof storage>) {
  const visit = connect(page(backing));
  visit.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
  await tick();
  return visit;
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

describe('an edit made on a page that closed before its client started', () => {
  it('goes in the host time at the next visit, on a device behind the host', async () => {
    const backing = storage();
    await synced(backing);
    const closed = page(backing);
    const editedAt = Date.now();
    closed.updateInCollection('notes', 'n1', { title: 'closed page' });
    await tick();
    vi.advanceTimersByTime(1000);

    const { socket } = await nextVisit(backing);
    const op = pushed(socket).find((o) => o.recordId === 'n1');
    expect(op?.data?.title).toBe('closed page');
    expect(Date.parse(op!.timestamp)).toBe(editedAt + 60_000);
  });
});

/**
 * The ops a change of n1 goes as, made with a client listening and made on a page that closed
 * before its client started, n1 pulled from the host first with the stamp `pulled`.
 */
async function bothWays(pulled: string, change: (store: XDBService) => void) {
  const ops = (socket: FakeSocket) => pushed(socket).filter((o) => o.recordId === 'n1').map((o) => [o.operation, o.timestamp, o.data?.title]);
  const start = Date.now();
  const listening = page(storage());
  const live = connect(listening);
  live.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', pulled)] });
  await tick();
  vi.advanceTimersByTime(1000);
  change(listening);
  await tick();
  const heard = ops(live.socket);
  live.sync.disconnect();

  vi.setSystemTime(start);
  const backing = storage();
  const first = connect(page(backing));
  first.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', pulled)] });
  await tick();
  first.sync.disconnect();
  vi.advanceTimersByTime(1000);
  change(page(backing));
  await tick();
  const { socket } = await nextVisit(backing);
  return { heard, unheard: ops(socket) };
}

describe('a change made while no client listened goes as it would have with one listening', () => {
  it('an edit', async () => {
    const { heard, unheard } = await bothWays('2026-02-01T00:00:00.000Z', (store) => store.updateInCollection('notes', 'n1', { title: 'mine' }));
    expect(heard).toHaveLength(1);
    expect(unheard).toEqual(heard);
  });

  // The copy is ahead of this clock, by less than the host is: the edit took the stamp just
  // after it, and the note sent it at that stamp, not at its time with the host's lead.
  it('an edit of a copy stamped ahead of this clock', async () => {
    const editedAt = Date.now() + 1000;
    const { heard, unheard } = await bothWays(new Date(Date.now() + 10_000).toISOString(), (store) => store.updateInCollection('notes', 'n1', { title: 'mine' }));
    expect(heard).toHaveLength(1);
    expect(Date.parse(String(heard[0][1]))).toBe(editedAt + 60_000);
    expect(unheard).toEqual(heard);
  });

  it('a deletion of a copy stamped ahead of this clock', async () => {
    const { heard, unheard } = await bothWays(new Date(Date.now() + 10_000).toISOString(), (store) => store.deleteFromCollection('notes', 'n1'));
    expect(heard.map((op) => op[0])).toEqual(['delete']);
    expect(unheard).toEqual(heard);
  });

  it('an import', async () => {
    const older = '2026-02-15T00:00:00.000Z';
    const restored = { id: 'n1', collection: 'notes', data: { title: 'restored' }, created_at: older, updated_at: older, deleted: false };
    const { heard, unheard } = await bothWays('2026-02-01T00:00:00.000Z', (store) => store.import({ version: 1, exportedAt: older, collections: { notes: [restored] } }, { merge: false }));
    expect(heard.map((op) => op[0])).toEqual(['update']);
    expect(unheard).toEqual(heard);
  });
});

describe('an import made while no client listened', () => {
  it('is sent at the next visit, a record new here as a create and one changed as an update', async () => {
    const backing = storage();
    await synced(backing);
    const older = '2026-02-15T00:00:00.000Z';
    const record = (id: string, title: string) => ({ id, collection: 'notes', data: { title }, created_at: older, updated_at: older, deleted: false });
    page(backing).import({ version: 1, exportedAt: older, collections: { notes: [record('n1', 'restored'), record('n9', 'new')] } }, { merge: false });
    await tick();

    const { socket } = await nextVisit(backing);
    const ops = pushed(socket).map((o) => [o.operation, o.recordId, o.data?.title]).sort();
    expect(ops).toEqual([['create', 'n9', 'new'], ['update', 'n1', 'restored']]);
  });
});

describe('a noted edit', () => {
  it('is not sent once its record has changed since, and is taken out of the note', async () => {
    const backing = storage();
    await synced(backing);
    page(backing).updateInCollection('notes', 'n1', { title: 'noted' });
    await tick();
    vi.advanceTimersByTime(1000);
    // Another tab, listening, edits it again and the host takes that.
    const other = connect(page(backing));
    other.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    // That tab heard nothing of the note's edit: it is the note's to send, and it sends it.
    await tick();
    other.socket.receive({ type: 'sync_ack', opIds: other.socket.sent.filter((m) => m.type === 'sync_push').flatMap((m) => (m.ops as Array<{ id: string }>).map((o) => o.id)) });
    await tick();
    vi.advanceTimersByTime(1000);
    const after = page(backing);
    after.updateInCollection('notes', 'n1', { title: 'later' });
    await tick();
    expect(after.readUnheardNote().edits.map((e) => e.id)).toEqual(['n1']);
    other.sync.disconnect();
    vi.advanceTimersByTime(1000);
    // A pull brings another device's copy over n1 before the next client reads the note.
    const pulled = page(backing);
    pulled.upsertFromServer('notes', { id: 'n1', collection: 'notes', data: { title: 'theirs' }, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: new Date(Date.now() + 120_000).toISOString() });

    const { socket } = await nextVisit(backing);
    expect(pushed(socket).filter((o) => o.data?.title === 'later')).toEqual([]);
    await tick();
    expect(page(backing).readUnheardNote().edits).toEqual([]);
  });

  it('is kept until the queue holding its op is saved: a page closing in between leaves it', async () => {
    const backing = storage();
    await synced(backing);
    page(backing).updateInCollection('notes', 'n1', { title: 'noted' });
    await tick();
    const reading = page(backing);
    const sync = new XDBServerSync(reading, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    sync.connect();
    // Before the save at the end of the task, the note still holds it.
    expect(page(backing).readUnheardNote().edits.map((e) => e.id)).toEqual(['n1']);
    await tick();
    expect(page(backing).readUnheardNote().edits).toEqual([]);
    // And the op is in the saved queue.
    expect(backing.getItem('xdb:app::sync-queue')).toContain('"recordId":"n1"');
  });
});

describe('two tabs noting at once', () => {
  it('keeps both, and the next visit sends both', async () => {
    const backing = storage();
    await synced(backing);
    const a = page(backing);
    const b = page(backing);
    a.create('notes', { title: 'from A' });
    b.create('notes', { title: 'from B' });
    await tick();
    expect(page(backing).readUnheardNote().edits).toHaveLength(2);
    const { socket } = await nextVisit(backing);
    expect(pushed(socket).map((o) => o.data?.title).sort()).toEqual(['from A', 'from B']);
  });
});

describe('the note', () => {
  it('is not written by a store that has never synced', async () => {
    const backing = storage();
    page(backing).create('notes', { title: 'local' });
    await tick();
    expect([...backing.kept.keys()].filter((key) => key.endsWith('::sync-unheard'))).toEqual([]);
  });

  it('refused by the store, refuses nothing of the app, and the change is still found and sent', async () => {
    const backing = storage();
    await synced(backing);
    const refusing = { ...backing, setItem: (key: string, value: string) => { if (key.endsWith('::sync-unheard')) throw new DOMException('full', 'QuotaExceededError'); backing.setItem(key, value); } };
    const closed = page(refusing);
    expect(() => closed.updateInCollection('notes', 'n1', { title: 'still sent' })).not.toThrow();
    await tick();
    const { socket } = await nextVisit(backing);
    expect(pushed(socket).map((o) => o.data?.title)).toContain('still sent');
  });
});
