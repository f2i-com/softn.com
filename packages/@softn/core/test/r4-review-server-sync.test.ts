/**
 * Server sync: changes that were lost or rolled back (audit round 4, from the
 * probes in scratchpad r4/regress-core/agent-xdb).
 *
 * - A delete the host refused as "not found" (another tab's create of the
 *   record not yet landed) was dropped, not retried as an update is, and the
 *   create then brought the record back everywhere.
 * - While this device had an unanswered edit of a record, every delta for it
 *   was skipped. Applied first on the host, the edit was answered with an ack
 *   alone, and another device's newer edit broadcast before that ack was lost
 *   here, and overwritten everywhere by this device's next edit.
 * - `lastOpFor` kept an entry for every record ever changed in the session.
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

function storage() {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
    get length() {
      return kept.size;
    },
    key: (i: number) => [...kept.keys()][i] ?? null,
  };
}

const tab = (backing: ReturnType<typeof storage>) => new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });

function offline(store: XDBService) {
  const sync = new XDBServerSync(store, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
  sync.connect();
  return { sync, socket: FakeSocket.made[FakeSocket.made.length - 1] };
}

function online(store: XDBService) {
  const client = offline(store);
  client.socket.open();
  client.socket.receive({ type: 'auth_ok', clientId: `c${FakeSocket.made.length}`, serverTime: new Date().toISOString() });
  client.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
  return client;
}

type Op = { id: string; operation: string; recordId: string; collection: string; timestamp: string; clientId: string; data?: Record<string, unknown> };
const pushed = (socket: FakeSocket) => socket.sent.filter((m) => m.type === 'sync_push').flatMap((m) => m.ops as Op[]);
const tick = () => Promise.resolve();

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers({ now: new Date('2026-03-01T00:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a delete the host refused as not found', () => {
  it('is sent again after the other tab’s create, and the record stays deleted', async () => {
    const backing = storage();
    const a = tab(backing);
    const b = tab(backing);
    const sb = online(b);
    const sa = offline(a);
    const r1 = a.create('notes', { title: 'made in A' });
    await tick();
    vi.advanceTimersByTime(5000);
    expect(b.delete(r1.id)).toBe(true);
    await tick();
    const del = pushed(sb.socket).find((op) => op.operation === 'delete')!;
    sb.socket.receive({ type: 'sync_reject', opId: del.id, reason: `Record not found: ${r1.id}` });
    await tick();
    // B sends A's saved create first, then, once it is answered, its delete again.
    const adopted = pushed(sb.socket).find((op) => op.recordId === r1.id && op.operation === 'create');
    expect(adopted).toBeDefined();
    sb.socket.receive({ type: 'sync_ack', opIds: [adopted!.id] });
    await tick();
    expect(pushed(sb.socket).filter((op) => op.recordId === r1.id).map((op) => op.operation)).toEqual(['delete', 'create', 'delete']);

    // A comes back and its create is heard by B: B's delete is still the last word.
    sa.socket.open();
    sa.socket.receive({ type: 'auth_ok', clientId: 'ca', serverTime: new Date().toISOString() });
    sa.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    const create = pushed(sa.socket).find((op) => op.recordId === r1.id);
    if (create) sb.socket.receive({ type: 'sync_delta', ops: [{ ...create, clientId: 'ca' }] });
    await tick();
    expect(b.get('notes', r1.id)).toBeNull();
    sa.sync.disconnect();
    sb.sync.disconnect();
  });
});

describe('another device’s newer edit broadcast before this device’s own edit is acknowledged', () => {
  it('is kept here once the own edit is acknowledged', async () => {
    const store = tab(storage());
    const d = online(store);
    const r = store.create('notes', { title: 'v0', body: 'b0' });
    await tick();
    d.socket.receive({ type: 'sync_ack', opIds: pushed(d.socket).map((op) => op.id) });
    vi.advanceTimersByTime(1000);
    store.update(r.id, { title: 'title from D' });
    await tick();
    const u = pushed(d.socket).find((op) => op.operation === 'update')!;
    vi.advanceTimersByTime(500);
    d.socket.receive({
      type: 'sync_delta',
      ops: [{ id: 'op_other_1', collection: 'notes', operation: 'update', recordId: r.id, data: { title: 'title from D', body: 'body from E' }, timestamp: new Date().toISOString(), clientId: 'device-e' }],
    });
    d.socket.receive({ type: 'sync_ack', opIds: [u.id] });
    await tick();
    expect(store.get('notes', r.id)?.data.body).toBe('body from E');
    d.sync.disconnect();
  });

  it('is still left to the answer when it is not newer than the own edit', async () => {
    const store = tab(storage());
    const d = online(store);
    const r = store.create('notes', { title: 'v0', body: 'b0' });
    await tick();
    d.socket.receive({ type: 'sync_ack', opIds: pushed(d.socket).map((op) => op.id) });
    vi.advanceTimersByTime(1000);
    const older = new Date(Date.now() - 500).toISOString();
    store.update(r.id, { title: 'title from D' });
    await tick();
    d.socket.receive({
      type: 'sync_delta',
      ops: [{ id: 'op_other_2', collection: 'notes', operation: 'update', recordId: r.id, data: { title: 'old', body: 'old' }, timestamp: older, clientId: 'device-e' }],
    });
    await tick();
    expect(store.get('notes', r.id)?.data.title).toBe('title from D');
    d.sync.disconnect();
  });
});

describe('the catch-up pull from a floor beside a whole pull in pages', () => {
  // A connection whose whole pull had no answer leaves a floor; the next one pulls the collection
  // whole and what changed since the floor. Both answer as `sync_state`, so sent together the
  // catch-up's answer could move the place to the floor between two pages of the whole pull,
  // and a drop before the next page lost what it held here.
  const rec = (id: string, at: string) => ({ id, collection: 'notes', data: { title: id }, createdAt: at, updatedAt: at, serverReceivedAt: at });
  const catchUps = (socket: FakeSocket) => socket.sent.filter((m) => m.type === 'sync_pull' && m.lastSync !== undefined);

  /** Connection 1, whose whole pull is never answered, then connection 2 an hour later. */
  function afterAnUnansweredPull() {
    const backing = storage();
    const first = offline(tab(backing));
    first.socket.open();
    first.socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: '2026-03-01T00:00:00.000Z' });
    first.sync.disconnect();
    vi.advanceTimersByTime(3600_000);
    const second = offline(tab(backing));
    second.socket.open();
    second.socket.receive({ type: 'auth_ok', clientId: 'c2', serverTime: '2026-03-01T01:00:00.000Z' });
    return { backing, second };
  }

  it('is asked for once the whole pull’s last page is in, so a drop mid-pull loses nothing', async () => {
    const { backing, second } = afterAnUnansweredPull();
    expect(catchUps(second.socket)).toEqual([]);
    second.socket.receive({
      type: 'sync_state', collection: 'notes',
      records: [rec('a', '2026-02-01T00:00:00.000Z'), rec('b', '2026-02-02T00:00:00.000Z')],
      more: { at: '2026-02-02T00:00:00.000Z', id: 'b' },
    });
    await tick();
    expect(catchUps(second.socket)).toEqual([]);
    // Page 2 (a record received on 2026-02-15) never arrives: the socket drops.
    second.sync.disconnect();
    const third = offline(tab(backing));
    third.socket.open();
    third.socket.receive({ type: 'auth_ok', clientId: 'c3', serverTime: '2026-03-01T02:00:00.000Z' });
    const pulls = third.socket.sent.filter((m) => m.type === 'sync_pull');
    expect(pulls.some((p) => p.lastSync === undefined || String(p.lastSync) < '2026-02-15T00:00:00.000Z')).toBe(true);
    third.sync.disconnect();
  });

  it('is asked for after a whole pull that ends on its first page', async () => {
    const { second } = afterAnUnansweredPull();
    second.socket.receive({ type: 'sync_state', collection: 'notes', records: [rec('a', '2026-02-01T00:00:00.000Z')] });
    await tick();
    expect(catchUps(second.socket)).toHaveLength(1);
    expect(catchUps(second.socket)[0]).toMatchObject({ collections: ['notes'] });
    second.sync.disconnect();
  });

  it('is asked for once, when the pulls are asked for again while it waits', async () => {
    const { second } = afterAnUnansweredPull();
    const retry = (second.sync as unknown as { retryPull(collections: string[], atLeastMs: number): void }).retryPull.bind(second.sync);
    retry(['notes'], 0);
    vi.advanceTimersByTime(120_000);
    retry(['notes'], 0);
    vi.advanceTimersByTime(120_000);
    expect(catchUps(second.socket)).toEqual([]);
    second.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    expect(catchUps(second.socket)).toHaveLength(1);
    second.sync.disconnect();
  });
});

describe('what server sync keeps of each record’s last op', () => {
  it('is let go once the op is answered', async () => {
    const store = tab(storage());
    const d = online(store);
    for (let i = 0; i < 50; i++) store.create('notes', { n: i });
    await tick();
    d.socket.receive({ type: 'sync_ack', opIds: pushed(d.socket).map((op) => op.id) });
    await tick();
    expect((d.sync as unknown as { lastOpFor: Map<string, string> }).lastOpFor.size).toBe(0);
    d.sync.disconnect();
  });
});
