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

function connect(store: XDBService, wsUrl = WS_URL) {
  const sync = new XDBServerSync(store, { wsUrl, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
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

describe('an app moved to another sync host', () => {
  const MOVED = 'wss://elsewhere.example.test/sync';
  type Op = { id: string; operation: string; recordId: string; data?: { title?: string } };

  // The mark of where listening stopped was the old host's, and the scan looked only past it:
  // the new host was never sent a record the store already had.
  it('sends the new host every record the store has', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const before = connect(store);
    before.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.create('notes', { title: 'made here' });
    await tick();
    before.socket.receive({ type: 'sync_ack', opIds: (pushed(before.socket) as unknown as Op[]).map((op) => op.id) });
    await tick();
    before.sync.disconnect();
    vi.advanceTimersByTime(1000);

    const moved = connect(page(backing), MOVED);
    const refused: string[] = [];
    moved.sync.on('reject', (...args: unknown[]) => refused.push(String(args[0])));
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    // Its pull says it has none of them: each goes as a create.
    const ops = (pushed(moved.socket) as unknown as Op[]).map((op) => [op.operation, op.data?.title]).sort();
    expect(ops).toEqual([['create', 'made here'], ['create', 'v1']]);
    expect(refused).toEqual([]);
  });

  // An update of each at its own stamp was taken by a host holding the same records (the
  // address changed, not the host): each rewritten, broadcast, and handed to its hooks.
  it('sends nothing to a host that holds the same records', async () => {
    const backing = storage();
    await synced(backing);
    vi.advanceTimersByTime(1000);
    const moved = connect(page(backing), `${WS_URL}/`);
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    await tick();
    expect(pushed(moved.socket)).toEqual([]);
    // And this host has a mark now: the next visit looks only past it.
    moved.sync.disconnect();
    expect(JSON.parse(backing.getItem('xdb:app::sync-watched')!).marks[`${WS_URL}/`]).toBeGreaterThan(0);
  });

  // The whole pull wrote the host's older copy before any create went, and the host keeps the
  // copy it has of an id a create names: the device's newer record was undone.
  it('keeps a newer record than a host the records were moved to holds, and sends it there', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const before = connect(store);
    before.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.updateInCollection('notes', 'n1', { title: 'newer here' });
    await tick();
    before.socket.receive({ type: 'sync_ack', opIds: (pushed(before.socket) as unknown as Op[]).map((op) => op.id) });
    await tick();
    before.sync.disconnect();
    vi.advanceTimersByTime(1000);

    // The new host was seeded from an older copy of the records.
    const moved = connect(page(backing), MOVED);
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'seeded', '2026-02-01T00:00:00.000Z')] });
    await tick();
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('newer here');
    const first = (pushed(moved.socket) as unknown as Op[]).find((op) => op.recordId === 'n1');
    expect([first?.operation, first?.data?.title]).toEqual(['update', 'newer here']);
  });

  it('sends a deletion made here after the copy a seeded host holds, and does not bring the record back', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const before = connect(store);
    before.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.deleteFromCollection('notes', 'n1');
    await tick();
    before.socket.receive({ type: 'sync_ack', opIds: (pushed(before.socket) as unknown as Op[]).map((op) => op.id) });
    await tick();
    before.sync.disconnect();
    vi.advanceTimersByTime(1000);

    const moved = connect(page(backing), MOVED);
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'seeded', '2026-02-01T00:00:00.000Z')] });
    await tick();
    expect(page(backing).get('notes', 'n1')).toBeNull();
    expect((pushed(moved.socket) as unknown as Op[]).map((op) => [op.operation, op.recordId])).toEqual([['delete', 'n1']]);
  });

  // The host sends a page of a pull in pieces, each but the last with no `more`: the first piece
  // was taken for the whole pull, a create went for every record not in it, and the next
  // piece's older copies were written over newer ones here.
  it('weighs every piece of a pull, however the host splits it, and keeps what is newer here', async () => {
    const backing = storage();
    await synced(backing);
    await editedOnTheOldHost(backing);
    const moved = connect(page(backing), MOVED);
    const seeded = '2026-01-01T00:00:00.000Z';
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n0', 'v0', '2026-02-01T00:00:00.000Z')] });
    await tick();
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'seeded', seeded)] });
    await tick();
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('newer here');
    const ops = (pushed(moved.socket) as unknown as Op[]).filter((op) => op.recordId === 'n1');
    // The create went before the piece that held n1 came; the update follows its answer.
    expect(ops.map((op) => op.operation)).toEqual(['create']);
    moved.socket.receive({ type: 'sync_ack', opIds: [(ops[0] as unknown as { id: string }).id] });
    moved.socket.receive({ type: 'sync_delta', ops: [{ id: (ops[0] as unknown as { id: string }).id, collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'seeded' }, timestamp: seeded, clientId: 'server' }] });
    await tick();
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('newer here');
    const then = (pushed(moved.socket) as unknown as Op[]).filter((op) => op.recordId === 'n1');
    expect(then.map((op) => [op.operation, op.data?.title])).toEqual([['create', 'newer here'], ['update', 'newer here']]);
  });

  /** A store whose last visit pulled n0…n(count-1) from the old host and edited n1 there, answered. */
  async function editedOnTheOldHost(backing: ReturnType<typeof storage>, count = 2) {
    const store = page(backing);
    const before = connect(store);
    before.socket.receive({ type: 'sync_state', collection: 'notes', records: Array.from({ length: count }, (_, i) => row(`n${i}`, `v${i}`, '2026-02-01T00:00:00.000Z')) });
    store.updateInCollection('notes', 'n1', { title: 'newer here' });
    await tick();
    before.socket.receive({ type: 'sync_ack', opIds: (pushed(before.socket) as unknown as Op[]).map((op) => op.id) });
    await tick();
    before.sync.disconnect();
    vi.advanceTimersByTime(1000);
  }

  // Each record newer here read the whole collection again.
  it("reads the collection once for a pull's records, however many are newer here", async () => {
    const backing = storage();
    let reads = 0;
    const counting = { ...backing, getItem: (key: string) => { if (key === 'xdb:app:notes') reads++; return backing.getItem(key); } };
    const store = page(counting);
    const before = connect(store);
    const rows = (at: string) => Array.from({ length: 200 }, (_, i) => row(`n${i}`, `v${i}`, at));
    before.socket.receive({ type: 'sync_state', collection: 'notes', records: rows('2026-02-01T00:00:00.000Z') });
    await tick();
    before.sync.disconnect();
    vi.advanceTimersByTime(1000);

    const moved = connect(page(counting), MOVED);
    reads = 0;
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: rows('2026-01-01T00:00:00.000Z') });
    expect(reads).toBeLessThanOrEqual(3);
    await tick();
    expect((pushed(moved.socket) as unknown as Op[]).filter((op) => op.operation === 'update')).toHaveLength(200);
  });

  // An update at the scan's time took the place of the edit, stamped before it.
  it('sends an edit made while the move waits at its own time', async () => {
    const backing = storage();
    await synced(backing);
    await editedOnTheOldHost(backing);
    const store = page(backing);
    const moved = connect(store, MOVED);
    vi.advanceTimersByTime(65_000);
    const editedAt = Date.now();
    store.updateInCollection('notes', 'n1', { title: 'edited while moving' });
    await tick();
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'seeded', '2026-01-01T00:00:00.000Z')] });
    await tick();
    const ops = (pushed(moved.socket) as unknown as Array<Op & { timestamp: string }>).filter((op) => op.recordId === 'n1');
    expect(ops.map((op) => [op.operation, op.data?.title])).toEqual([['update', 'edited while moving']]);
    expect(Date.parse(ops[0].timestamp)).toBeGreaterThanOrEqual(editedAt);
  });

  it("keeps a newer record here when another client's older change of it arrives while the move waits", async () => {
    const backing = storage();
    await synced(backing);
    await editedOnTheOldHost(backing);
    const moved = connect(page(backing), MOVED);
    moved.socket.receive({ type: 'sync_delta', ops: [{ id: 'd1', collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'older elsewhere' }, timestamp: '2026-01-15T00:00:00.000Z', clientId: 'c9' }] });
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('newer here');
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'older elsewhere', '2026-01-15T00:00:00.000Z')] });
    await tick();
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('newer here');
    expect((pushed(moved.socket) as unknown as Op[]).filter((op) => op.recordId === 'n1').map((op) => [op.operation, op.data?.title])).toEqual([['update', 'newer here']]);
  });

  it('keeps a newer record here when one delta carries two older changes of it while the move waits', async () => {
    const backing = storage();
    await synced(backing);
    await editedOnTheOldHost(backing);
    const moved = connect(page(backing), MOVED);
    const op = (id: string, title: string, at: string) => ({ id, collection: 'notes', operation: 'update', recordId: 'n1', data: { title }, timestamp: at, clientId: 'c9' });
    moved.socket.receive({ type: 'sync_delta', ops: [op('d1', 'older a', '2026-01-15T00:00:00.000Z'), op('d2', 'older b', '2026-01-16T00:00:00.000Z')] });
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('newer here');
  });

  // Let go before its creates were queued, a collection pulled after another sent its held
  // changes first, which the host refused, and the person was told a change was not taken.
  it('sends the creates of a collection pulled after another before the changes that waited', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const sync = new XDBServerSync(store, { wsUrl: MOVED, appVersion: '1', collections: ['tasks', 'notes'], reconnectDelay: 60_000 });
    const refused: string[] = [];
    sync.on('reject', (...args: unknown[]) => refused.push(String(args[0])));
    sync.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c-moved', serverTime: hostTime() });
    store.updateInCollection('notes', 'n1', { title: 'edited while moving' });
    await tick();
    socket.receive({ type: 'sync_state', collection: 'tasks', records: [] });
    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    const ops = (pushed(socket) as unknown as Array<Op & { id: string }>).filter((op) => op.recordId === 'n1');
    expect(ops.map((op) => op.operation)).toEqual(['create']);
    socket.receive({ type: 'sync_ack', opIds: [ops[0].id] });
    await tick();
    const then = (pushed(socket) as unknown as Op[]).filter((op) => op.recordId === 'n1');
    expect(then.map((op) => [op.operation, op.data?.title])).toEqual([['create', 'v1'], ['update', 'edited while moving']]);
    expect(refused).toEqual([]);
    sync.disconnect();
  });

  // The page closed before the move's creates were answered, and saved the new host a mark of 0:
  // the next page took the host for one it had synced with, and wrote its older copies over the
  // newer records here.
  it('picks the move up again on the next page when one closed partway, and keeps what is newer here', async () => {
    const backing = storage();
    await synced(backing);
    await editedOnTheOldHost(backing);
    const closing = connect(page(backing), MOVED);
    expect(pushed(closing.socket)).toEqual([]);
    closing.sync.disconnect();
    expect(JSON.parse(backing.getItem('xdb:app::sync-watched')!).pending).toEqual([MOVED]);
    vi.advanceTimersByTime(1000);

    const moved = connect(page(backing), MOVED);
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n0', 'v0', '2026-02-01T00:00:00.000Z'), row('n1', 'seeded', '2026-01-01T00:00:00.000Z')] });
    await tick();
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('newer here');
    const n1 = (pushed(moved.socket) as unknown as Op[]).filter((op) => op.recordId === 'n1');
    expect(n1.map((op) => [op.operation, op.data?.title])).toEqual([['update', 'newer here']]);
    // Every create answered (none was left to send), the move is done.
    moved.socket.receive({ type: 'sync_ack', opIds: (pushed(moved.socket) as unknown as Array<{ id: string }>).map((op) => op.id) });
    await tick();
    moved.sync.disconnect();
    const mark = JSON.parse(backing.getItem('xdb:app::sync-watched')!);
    expect(mark.pending).toBeUndefined();
    expect(mark.marks[MOVED]).toBeGreaterThan(0);
  });

  // A tombstone gets no create, so the move was done once the creates were answered; the page
  // went before the pull brought the host's live copy, and the next page, no longer moving,
  // wrote that copy over the deletion made here.
  it('does not bring back a record deleted here when the pull brings the host its older copy later', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const before = connect(store);
    before.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.deleteFromCollection('notes', 'n1');
    await tick();
    before.socket.receive({ type: 'sync_ack', opIds: (pushed(before.socket) as unknown as Array<{ id: string }>).map((op) => op.id) });
    await tick();
    before.sync.disconnect();
    vi.advanceTimersByTime(1000);
    // On the new host the page sends nothing (a tombstone has no create), and goes.
    const closing = connect(page(backing), MOVED);
    closing.sync.disconnect();
    vi.advanceTimersByTime(1000);

    const moved = connect(page(backing), MOVED);
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    await tick();
    expect(page(backing).get('notes', 'n1')).toBeNull();
    expect((pushed(moved.socket) as unknown as Op[]).map((op) => [op.operation, op.recordId])).toEqual([['delete', 'n1']]);
  });

  /** A client of `store` on WS_URL whose host's clock is `lead` ms ahead of this device's (behind, below 0). */
  function connectWithLead(store: XDBService, lead: number) {
    const sync = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    sync.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: `c${FakeSocket.made.length}`, serverTime: new Date(Date.now() + lead).toISOString() });
    return { sync, socket };
  }

  // On a device whose clock runs ahead of the host's, a deletion made on an earlier page, in
  // this device's time, outweighed another device's edit the host had taken after it (the copy
  // that answered the deletion lost with the page), and the deletion undid that edit.
  it("does not take a deletion made here for newer than a host's copy within the clocks' difference", async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const before = connectWithLead(store, -60_000);
    before.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.deleteFromCollection('notes', 'n1');
    await tick();
    const deletedAt = Date.now();
    before.socket.receive({ type: 'sync_ack', opIds: (pushed(before.socket) as unknown as Array<{ id: string }>).map((op) => op.id) });
    await tick();
    // The page goes on a while, and its mark with it, past the deletion.
    vi.advanceTimersByTime(5000);
    before.sync.disconnect();
    vi.advanceTimersByTime(1000);

    // Another device's edit, 30 seconds after the deletion in the host's time.
    const next = connectWithLead(page(backing), -60_000);
    next.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'edited elsewhere', new Date(deletedAt - 60_000 + 30_000).toISOString())] });
    await tick();
    expect(pushed(next.socket)).toEqual([]);
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('edited elsewhere');
  });

  // The clock was set right between the pages: weighed with the offset of the second, which is
  // none, the deletion outweighed the edit the host took after it.
  it("does not take a deletion for newer than a host's copy when the clock was set right since", async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const before = connectWithLead(store, -60_000);
    before.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.deleteFromCollection('notes', 'n1');
    await tick();
    const deletedAt = Date.now();
    before.socket.receive({ type: 'sync_ack', opIds: (pushed(before.socket) as unknown as Array<{ id: string }>).map((op) => op.id) });
    await tick();
    vi.advanceTimersByTime(5000);
    before.sync.disconnect();
    // Set right: 60 seconds back, the host's time.
    vi.setSystemTime(Date.now() - 60_000);

    const next = connectWithLead(page(backing), 0);
    next.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'edited elsewhere', new Date(deletedAt - 60_000 + 30_000).toISOString())] });
    await tick();
    expect(pushed(next.socket)).toEqual([]);
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('edited elsewhere');
  });

  // A fixed five minutes' margin kept the host's copy of a record deleted within five minutes of
  // its last edit, the clocks agreeing: a move to a host seeded with that edit brought it back.
  it('keeps a deletion made minutes after the copy a seeded host holds, the clocks agreeing', async () => {
    const backing = storage();
    const store = page(backing);
    const before = connectWithLead(store, 0);
    const edited = new Date(Date.now() - 180_000).toISOString();
    before.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', edited)] });
    await tick();
    store.deleteFromCollection('notes', 'n1');
    await tick();
    before.socket.receive({ type: 'sync_ack', opIds: (pushed(before.socket) as unknown as Array<{ id: string }>).map((op) => op.id) });
    await tick();
    vi.advanceTimersByTime(5000);
    before.sync.disconnect();
    vi.advanceTimersByTime(1000);

    const moved = new XDBServerSync(page(backing), { wsUrl: MOVED, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    moved.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c-moved', serverTime: new Date().toISOString() });
    socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', edited)] });
    await tick();
    expect(page(backing).get('notes', 'n1')).toBeNull();
    expect((pushed(socket) as unknown as Op[]).map((op) => [op.operation, op.recordId])).toEqual([['delete', 'n1']]);
    moved.disconnect();
  });

  // The page after the clock was set back saved a mark from the corrected clock, earlier than the
  // stamps edits had while it ran ahead: every page after sent those again, at those stamps, and
  // the host took them over other devices' edits made since.
  it('does not send again, after the clock was set back, what was edited and answered while it ran ahead', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const ahead = connectWithLead(store, -60_000);
    ahead.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.updateInCollection('notes', 'n1', { title: 'mine' });
    await tick();
    ahead.socket.receive({ type: 'sync_ack', opIds: (pushed(ahead.socket) as unknown as Array<{ id: string }>).map((op) => op.id) });
    await tick();
    vi.advanceTimersByTime(5000);
    ahead.sync.disconnect();
    vi.setSystemTime(Date.now() - 60_000);

    const between = connectWithLead(page(backing), 0);
    between.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    between.sync.disconnect();
    vi.advanceTimersByTime(2000);

    const third = connectWithLead(page(backing), 0);
    expect((pushed(third.socket) as unknown as Op[]).filter((op) => op.recordId === 'n1')).toEqual([]);
    third.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'edited elsewhere', new Date().toISOString())] });
    await tick();
    expect((pushed(third.socket) as unknown as Op[]).filter((op) => op.recordId === 'n1')).toEqual([]);
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('edited elsewhere');
    third.sync.disconnect();
  });

  // The mark only moves forward, and the note lets go first of the edits the scan of stamps is to
  // find: after the clock was set back, one let go for want of room was earlier than the mark,
  // and never went.
  it('sends, after the clock was set back, an edit the note let go of for want of room', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const ahead = connectWithLead(store, -60_000);
    ahead.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.updateInCollection('notes', 'n1', { title: 'mine' });
    await tick();
    ahead.socket.receive({ type: 'sync_ack', opIds: (pushed(ahead.socket) as unknown as Array<{ id: string }>).map((op) => op.id) });
    await tick();
    vi.advanceTimersByTime(5000);
    ahead.sync.disconnect();
    vi.setSystemTime(Date.now() - 60_000);
    const between = connectWithLead(page(backing), 0);
    between.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    between.sync.disconnect();
    vi.advanceTimersByTime(2000);

    // Room for no entry a record, only for what the note keeps of the edits it lets go.
    const full = { ...backing, setItem: (key: string, value: string) => { if (key.endsWith('::sync-unheard') && value.length > 60) throw new DOMException('full', 'QuotaExceededError'); backing.setItem(key, value); } };
    page(full).create('notes', { title: 'made while the note was full' }, { id: 'n2' });
    await tick();
    vi.advanceTimersByTime(1000);

    const next = connectWithLead(page(backing), 0);
    next.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    expect((pushed(next.socket) as unknown as Op[]).filter((op) => op.recordId === 'n2').map((op) => op.data?.title)).toEqual(['made while the note was full']);
    next.sync.disconnect();
  });

  // Written by a clock a year ahead, the mark held every scan back for a year, and the week's
  // largest offset stayed fresh for a year.
  it('trusts no mark or offset a clock far ahead wrote, once it is set right', async () => {
    const backing = storage();
    await synced(backing);
    const year = 365 * 24 * 3600e3;
    vi.setSystemTime(Date.now() + year);
    const ahead = connectWithLead(page(backing), -year);
    ahead.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    ahead.sync.disconnect();
    vi.setSystemTime(Date.now() - year);
    const after = connectWithLead(page(backing), 0);
    after.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    after.sync.disconnect();
    const kept = JSON.parse(backing.getItem('xdb:app::sync-watched')!);
    expect(kept.marks[WS_URL]).toBeLessThanOrEqual(Date.now());
    expect(Math.abs(kept.peak.at - Date.now())).toBeLessThan(24 * 3600e3);
  });

  // The offset was kept under one host's address, and a new host had none: a deletion made while
  // the clock ran ten minutes ahead, weighed on the move after it was set right, outweighed
  // another device's later edit, and the deletion undid it on the new host.
  it('weighs a deletion made under a clock set right since with that clock\'s offset on a move as well', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const ahead = connectWithLead(store, -600_000);
    ahead.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.deleteFromCollection('notes', 'n1');
    await tick();
    ahead.socket.receive({ type: 'sync_ack', opIds: (pushed(ahead.socket) as unknown as Array<{ id: string }>).map((op) => op.id) });
    await tick();
    vi.advanceTimersByTime(5000);
    ahead.sync.disconnect();
    vi.setSystemTime(Date.now() - 600_000);

    const moved = new XDBServerSync(page(backing), { wsUrl: MOVED, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    moved.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c-moved', serverTime: new Date().toISOString() });
    socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'edited elsewhere', new Date(Date.now() + 60_000).toISOString())] });
    await tick();
    expect((pushed(socket) as unknown as Op[]).filter((op) => op.recordId === 'n1').map((op) => op.operation)).not.toContain('delete');
    moved.disconnect();
  });

  // The margin was taken off every stamp this page did not give, heard ones too: on a device
  // whose clock was off, a newer edit heard from the old host lost to a seeded copy older than it.
  it('keeps a newer edit heard from the old host against a seeded copy, on a device whose clock is off', async () => {
    const backing = storage();
    const store = page(backing);
    const old = connectWithLead(store, 600_000);
    const seed = new Date(Date.now() + 600_000 - 3_600_000).toISOString();
    const heard = new Date(Date.parse(seed) + 300_000).toISOString();
    old.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v2', heard)] });
    await tick();
    old.sync.disconnect();
    vi.advanceTimersByTime(1000);

    const moved = new XDBServerSync(page(backing), { wsUrl: MOVED, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    moved.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c-moved', serverTime: new Date(Date.now() + 600_000).toISOString() });
    socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', seed)] });
    await tick();
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('v2');
    moved.disconnect();
  });

  // A host from before sends no record back for a deletion it refuses, so the tombstone stayed,
  // and every whole pull sent the deletion again, refused again, the person told each time.
  it('does not send again a deletion the host refused', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const live = connect(store);
    live.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    store.deleteFromCollection('notes', 'n1');
    await tick();
    const [deletion] = pushed(live.socket) as unknown as Array<{ id: string }>;
    live.socket.receive({ type: 'sync_reject', opId: deletion.id, reason: 'Rejected by onBeforeSync' });
    await tick();
    live.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    await tick();
    expect(pushed(live.socket)).toHaveLength(1);
    live.sync.disconnect();
  });

  // One mark, the last host's: a page on the first host after a tab on another (an update of the
  // app moved it) took the store for one moved there, sent a create of every record, and the
  // host's answers undid what the other host had been sent.
  it('keeps a mark for each host: back on the first after a visit to another is no move', async () => {
    const backing = storage();
    await synced(backing);
    const pulledHere = backing.getItem('xdb:app::sync-pulled');
    const store = page(backing);
    const other = connect(store, MOVED);
    other.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    await tick();
    store.updateInCollection('notes', 'n1', { title: 'edited on the other host' });
    await tick();
    other.socket.receive({ type: 'sync_ack', opIds: (pushed(other.socket) as unknown as Array<{ id: string }>).map((op) => op.id) });
    await tick();
    other.sync.disconnect();
    // The tab on the first host left its pull positions as they were.
    backing.setItem('xdb:app::sync-pulled', pulledHere!);
    vi.advanceTimersByTime(1000);

    const { socket } = await nextVisit(backing);
    const ops = (pushed(socket) as unknown as Op[]).map((op) => [op.operation, op.recordId, op.data?.title]);
    expect(ops).toEqual([['update', 'n1', 'edited on the other host']]);
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('edited on the other host');
  });

  it('sends what was queued for the old host too, after the create of a record the new host has no copy of', async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const queued = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    queued.connect();
    store.updateInCollection('notes', 'n1', { title: 'edited offline' });
    await tick();
    queued.disconnect();
    vi.advanceTimersByTime(1000);

    const moved = connect(page(backing), MOVED);
    const refused: string[] = [];
    moved.sync.on('reject', (...args: unknown[]) => refused.push(String(args[0])));
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    // An empty host has no n1: the record goes as a create, and the update queued for the old
    // host after it.
    const first = (pushed(moved.socket) as unknown as Op[]).filter((op) => op.recordId === 'n1');
    expect(first.map((op) => [op.operation, op.data?.title])).toEqual([['create', 'edited offline']]);
    moved.socket.receive({ type: 'sync_ack', opIds: [first[0].id] });
    await tick();
    const then = (pushed(moved.socket) as unknown as Op[]).filter((op) => op.recordId === 'n1');
    expect(then.map((op) => [op.operation, op.data?.title])).toEqual([['create', 'edited offline'], ['update', 'edited offline']]);
    expect(refused).toEqual([]);
  });

  // v0.0.26 kept the mark as a number, for no host: it was taken for any host the app named,
  // so a record unchanged since was never sent to the new one, and an edit of it was refused.
  it('is taken for one by a store whose mark v0.0.26 kept as a number, for the host it pulled from', async () => {
    const backing = storage();
    await synced(backing);
    backing.setItem('xdb:app::sync-watched', String(Date.now()));
    expect(JSON.parse(backing.getItem('xdb:app::sync-pulled')!).url).toBe(WS_URL);
    vi.advanceTimersByTime(1000);
    const moved = connect(page(backing), MOVED);
    moved.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    const ops = (pushed(moved.socket) as unknown as Op[]).map((op) => [op.operation, op.recordId]);
    expect(ops).toEqual([['create', 'n1']]);
    moved.sync.disconnect();
    expect(JSON.parse(backing.getItem('xdb:app::sync-watched')!).marks['']).toBeUndefined();
  });

  it("is not taken for one by a store whose mark an earlier client kept as a number", async () => {
    const backing = storage();
    await synced(backing);
    backing.setItem('xdb:app::sync-watched', String(Date.now()));
    vi.advanceTimersByTime(1000);
    const { socket } = await nextVisit(backing);
    expect(pushed(socket)).toEqual([]);
  });
});

describe('a pull place set while the host clock ran ahead', () => {
  // A host whose clock once jumped a year ahead stamped its records then; pulled from that
  // place, every later pull brought nothing written since, deletions included.
  it('is no place once the host is back on time: the collection is pulled whole', async () => {
    const backing = storage();
    await synced(backing);
    // A visit while the host's clock is a year ahead: its pull from the place moves it there.
    const ahead = '2027-03-01T00:00:00.000Z';
    const sync = new XDBServerSync(page(backing), { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    sync.connect();
    const during = FakeSocket.made[FakeSocket.made.length - 1];
    during.open();
    during.receive({ type: 'auth_ok', clientId: 'c-ahead', serverTime: ahead });
    during.receive({ type: 'sync_state', collection: 'notes', records: [row('n2', 'v2', ahead)] });
    await tick();
    sync.disconnect();
    expect(JSON.parse(backing.getItem('xdb:app::sync-pulled')!).collections.notes.at).toBe(ahead);
    vi.advanceTimersByTime(1000);
    const { socket } = connect(page(backing));
    const pulls = socket.sent.filter((m) => m.type === 'sync_pull');
    expect(pulls).toEqual([{ type: 'sync_pull', collections: ['notes'] }]);
  });
});

describe('a large change made while no client listened', () => {
  const many = (n: number, at: string) => Array.from({ length: n }, (_, i) => row(`r${i}`, `t${i}`, at));
  type Op = { operation: string; recordId: string; data?: { title?: string } };

  // The note was cut at 64 KB, oldest first: past a few hundred records, a clear's removals and
  // an import's records reached no host, and nothing else finds them.
  it('a clear of 5,000 records reaches the host whole', async () => {
    const backing = storage();
    const first = connect(page(backing));
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: many(5000, '2026-02-01T00:00:00.000Z') });
    await tick();
    first.sync.disconnect();
    vi.advanceTimersByTime(1000);
    page(backing).clear('notes');
    await tick();

    const { socket } = await nextVisit(backing);
    const deleted = new Set((pushed(socket) as unknown as Op[]).filter((op) => op.operation === 'delete').map((op) => op.recordId));
    expect(deleted.size).toBe(5000);
  });

  it('an import of 5,000 records reaches the host whole', async () => {
    const backing = storage();
    await synced(backing);
    const older = '2026-02-15T00:00:00.000Z';
    const records = Array.from({ length: 5000 }, (_, i) => ({ id: `i${i}`, collection: 'notes', data: { title: `t${i}` }, created_at: older, updated_at: older, deleted: false }));
    page(backing).import({ version: 1, exportedAt: older, collections: { notes: records } }, { merge: true });
    await tick();

    const { socket } = await nextVisit(backing);
    const created = new Set((pushed(socket) as unknown as Op[]).filter((op) => op.operation === 'create').map((op) => op.recordId));
    expect(created.size).toBe(5000);
  });

  it('refused by the store, sheds the edits the scan of stamps finds, and keeps the removals', async () => {
    const backing = storage();
    const first = connect(page(backing));
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: many(300, '2026-02-01T00:00:00.000Z') });
    await tick();
    first.sync.disconnect();
    vi.advanceTimersByTime(1000);
    const tight = { ...backing, setItem: (key: string, value: string) => { if (key.endsWith('::sync-unheard') && value.length > 3_000) throw new DOMException('full', 'QuotaExceededError'); backing.setItem(key, value); } };
    const closed = page(tight);
    for (let i = 0; i < 150; i++) closed.updateInCollection('notes', `r${i}`, { title: `edited ${i}` });
    for (let i = 150; i < 250; i++) closed.hardDelete('notes', `r${i}`);
    await tick();
    const note = page(backing).readUnheardNote();
    expect(note.removals).toHaveLength(100);
    expect(note.edits.length).toBeLessThan(150);

    const { socket } = await nextVisit(backing);
    const ops = pushed(socket) as unknown as Op[];
    expect(new Set(ops.filter((op) => op.operation === 'delete').map((op) => op.recordId)).size).toBe(100);
    expect(new Set(ops.filter((op) => op.operation === 'update').map((op) => op.recordId)).size).toBe(150);
  });

  /** A store that refuses the note when it is longer than `chars`: the app's budget, nearly spent. */
  const tight = (backing: ReturnType<typeof storage>, chars: number) => ({
    ...backing,
    setItem: (key: string, value: string) => {
      if (key.endsWith('::sync-unheard') && value.length > chars) throw new DOMException('full', 'QuotaExceededError');
      backing.setItem(key, value);
    },
  });
  const older = '2026-02-15T00:00:00.000Z';
  const backup = (records: Array<[string, string]>) => ({
    version: 1,
    exportedAt: older,
    collections: { notes: records.map(([id, title]) => ({ id, collection: 'notes', data: { title }, created_at: older, updated_at: older, deleted: false })) },
  });

  it('an import the store will not note a record at a time is kept as the lists of what it made and changed, and all of it sent', async () => {
    const backing = storage();
    await synced(backing);
    page(tight(backing, 40_000)).import(backup(Array.from({ length: 2000 }, (_, i) => [`i${i}`, `t${i}`] as [string, string])), { merge: true });
    await tick();
    const [list] = page(backing).readUnheardNote().imports;
    expect([list.collection, list.creates.length, list.updates.length]).toEqual(['notes', 2000, 0]);

    const { socket } = await nextVisit(backing);
    const created = new Set((pushed(socket) as unknown as Op[]).filter((op) => op.operation === 'create').map((op) => op.recordId));
    for (let i = 0; i < 2000; i++) expect(created.has(`i${i}`)).toBe(true);
    await tick();
    expect(page(backing).readUnheardNote().imports).toEqual([]);
  });

  // Kept as a mark of the collection, every record of it went as a create, which the host
  // answered with its own copy of each it had: the restore was undone on the device.
  it('a restore the store will not note a record at a time goes as an update, and the restored record stays', async () => {
    const backing = storage();
    await synced(backing);
    page(tight(backing, 150)).import(backup([['n1', 'restored'], ['n2', 'new']]), { merge: true });
    await tick();
    expect(page(backing).readUnheardNote().edits).toEqual([]);

    const { socket } = await nextVisit(backing);
    const ops = (pushed(socket) as unknown as Op[]).map((op) => [op.operation, op.recordId, op.data?.title]).sort();
    expect(ops).toEqual([['create', 'n2', 'new'], ['update', 'n1', 'restored']]);
    expect(page(backing).get('notes', 'n1')?.data.title).toBe('restored');
  });

  // The lists' records were passed over wherever the queue held a change of them, however old:
  // an offline edit saved before the import went, and the restore never did.
  it("a restore kept in the lists goes after an older change the queue holds of the record", async () => {
    const backing = storage();
    await synced(backing);
    const store = page(backing);
    const offline = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    offline.connect();
    store.updateInCollection('notes', 'n1', { title: 'edited offline' });
    await tick();
    offline.disconnect();
    vi.advanceTimersByTime(1000);
    page(tight(backing, 150)).import(backup([['n1', 'restored'], ['n2', 'new']]), { merge: true });
    await tick();

    const { socket } = await nextVisit(backing);
    const n1 = (pushed(socket) as unknown as Op[]).filter((op) => op.recordId === 'n1');
    expect(n1.map((op) => [op.operation, op.data?.title]).at(-1)).toEqual(['update', 'restored']);
  });

  it("an edit of a record an import's list names goes as the edit, a create where the import made it", async () => {
    const backing = storage();
    await synced(backing);
    const closed = page(tight(backing, 150));
    closed.import(backup([['n9', 'new'], ['n8', 'gone soon']]), { merge: true });
    await tick();
    closed.updateInCollection('notes', 'n9', { title: 'edited after' });
    closed.hardDelete('notes', 'n8');
    await tick();
    const note = page(backing).readUnheardNote();
    expect(note.edits.map((e) => [e.id, e.kind])).toEqual([['n9', 'create']]);
    expect(note.removals).toEqual([]);
    expect(note.imports.flatMap((list) => [...list.creates, ...list.updates])).toEqual([]);

    const { socket } = await nextVisit(backing);
    expect((pushed(socket) as unknown as Op[]).map((op) => [op.operation, op.recordId, op.data?.title])).toEqual([['create', 'n9', 'edited after']]);
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

describe('a record one tab made with no client, which a listening tab then edited', () => {
  type Op = { operation: string; recordId: string; data?: { title?: string } };
  // The listening tab's edit was refused (the host never had the record), its saves moved the
  // mark past the record, and the note's create no longer matched the record's stamp: taken for
  // stale and forgotten, it never went.
  it('is sent as a create at the next visit', async () => {
    const backing = storage();
    await synced(backing);
    const a = page(backing);
    const listening = connect(a);
    listening.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const made = page(backing).create('notes', { title: 'from B' });
    await tick();
    a.updateInCollection('notes', made.id, { title: 'edited in A' });
    await tick();
    const [edit] = pushed(listening.socket) as unknown as Array<{ id: string }>;
    listening.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${made.id}` });
    await tick();
    listening.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${made.id}` });
    await tick();
    // A goes on a while: its saves move the mark past the record.
    vi.advanceTimersByTime(5000);
    listening.sync.disconnect();
    vi.advanceTimersByTime(1000);

    const { socket } = await nextVisit(backing);
    expect((pushed(socket) as unknown as Op[]).filter((op) => op.recordId === made.id).map((op) => [op.operation, op.data?.title])).toEqual([['create', 'edited in A']]);
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
