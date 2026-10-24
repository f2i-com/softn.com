/**
 * How an op is stamped for the sync host, which applies an edit unless its
 * stamp is older than the record's last change.
 *
 * A record heard from the host carries the host's clock. The scan at the
 * next load found every such record changed since this device's watermark
 * (kept by its own clock) when the host ran a second or more ahead, and the
 * flush added the host's offset to the record's stamp as to a time of this
 * device's: the old copy went back stamped later than edits other devices
 * had made since, and replaced them. And an edit made here was stamped with
 * this device's clock alone, though the store stamps it after the copy it
 * edits: one made just after a write it had heard lost to it on the host.
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

function connectTo(store: XDBService, serverTime: string) {
  const sync = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 10 });
  sync.connect();
  const socket = FakeSocket.made[FakeSocket.made.length - 1];
  socket.open();
  socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime });
  return { sync, socket };
}

const row = (id: string, title: string, at: string, received = at) => ({
  id, collection: 'notes', data: { title }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: at, serverReceivedAt: received,
});

const pushedOps = (socket: FakeSocket) =>
  socket.sent.filter((m) => m.type === 'sync_push').flatMap((m) => m.ops as Array<{ operation: string; recordId: string; timestamp: string; data?: unknown }>);
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

describe('a record heard from a host whose clock runs ahead', () => {
  it('does not go back at the next load stamped past edits made since', async () => {
    const backing = storage();
    const s = new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });
    // The host's clock is a minute ahead of this device's.
    const a = connectTo(s, '2026-03-01T00:01:00.000Z');
    a.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    a.socket.receive({ type: 'sync_delta', ops: [{ id: 'op_x', collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'E1' }, timestamp: '2026-03-01T00:01:00.500Z', clientId: 'c2' }] });
    await tick();
    vi.advanceTimersByTime(1000);
    a.sync.disconnect();
    vi.advanceTimersByTime(3 * 3600e3);

    // The next load: another device edited n1 thirty seconds after E1.
    const b = connectTo(s, '2026-03-01T03:01:01.000Z');
    b.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'E2', '2026-03-01T00:01:30.000Z', '2026-03-01T00:01:30.010Z')] });
    await tick();
    vi.advanceTimersByTime(1000);
    const sent = pushedOps(b.socket).filter((op) => op.recordId === 'n1');
    // Sent again at the record's own stamp, E1's: older than E2, which the
    // host keeps (it was sent a minute past E2, and replaced it).
    expect(sent.length).toBeGreaterThan(0);
    for (const op of sent) expect(Date.parse(op.timestamp)).toBeLessThan(Date.parse('2026-03-01T00:01:30.000Z'));
  });
});

describe('a pull of many records', () => {
  // Each record of a pull read and wrote its whole collection: quadratic in the records pulled,
  // and on the desktop a native rewrite of the collection's stored document a record.
  it('writes its collection once a message, with every record in it', async () => {
    const backing = storage();
    let writes = 0;
    const counted = { ...backing, setItem: (key: string, value: string) => { if (key === 'xdb:app:notes') writes++; backing.setItem(key, value); } };
    const s = new XDBService(counted, 'xdb:app', 'app', { backend: 'storage' });
    const c = connectTo(s, '2026-03-01T00:00:00.000Z');
    const records = Array.from({ length: 50 }, (_, n) => row(`n${n}`, `t${n}`, '2026-02-01T00:00:00.000Z'));
    c.socket.receive({ type: 'sync_state', collection: 'notes', records });
    await tick();
    expect(writes).toBe(1);
    expect(s.getAll('notes')).toHaveLength(50);
    expect(s.get('notes', 'n7')?.data.title).toBe('t7');
  });
});

describe('an edit sent and not yet answered when the page reloads', () => {
  // The restored op was weighed by its stamp, in the host's time, against records stamped by
  // this device's clock: on a device a minute behind, a newer edit made before the next client
  // listened was taken for one the queue held, never sent, and the pull wrote over it.
  it('leaves room for a newer edit made before the next client listens, on a device behind the host', async () => {
    const backing = storage();
    const ahead = () => new Date(Date.now() + 60_000).toISOString();
    const first = new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });
    const a = connectTo(first, ahead());
    a.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    vi.advanceTimersByTime(100);
    first.updateInCollection('notes', 'n1', { title: 'E1' });
    await tick();
    vi.advanceTimersByTime(5000);
    // The page reloads; the app edits the record before its client listens.
    const second = new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });
    second.updateInCollection('notes', 'n1', { title: 'E2' });
    vi.advanceTimersByTime(200);
    const b = connectTo(second, ahead());
    b.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    b.socket.receive({ type: 'sync_ack', opIds: b.socket.sent.filter((m) => m.type === 'sync_push').flatMap((m) => (m.ops as Array<{ id: string }>).map((o) => o.id)) });
    await tick();
    const sent = pushedOps(b.socket).filter((o) => o.recordId === 'n1');
    const titles = sent.map((o) => (o.data as { title?: string } | undefined)?.title);
    expect(titles).toContain('E2');
    // In the host's time, after E1's: the host keeps it.
    const e1 = sent.find((o) => (o.data as { title?: string } | undefined)?.title === 'E1')!;
    const e2 = sent.find((o) => (o.data as { title?: string } | undefined)?.title === 'E2')!;
    expect(Date.parse(e2.timestamp)).toBeGreaterThan(Date.parse(e1.timestamp));
  });

  // An edit made offline after a copy heard ahead of this clock gave its record that copy's stamp
  // + 1; weighed at the next load by when it was made, it was taken for older than its own record,
  // and replaced by the record as it stood, without the offset: in the host's past.
  it('keeps an offline edit made after a copy heard ahead of this clock, in the host time', async () => {
    const backing = storage();
    const ahead = () => new Date(Date.now() + 60_000).toISOString();
    const first = new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });
    const a = connectTo(first, ahead());
    a.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    a.socket.receive({ type: 'sync_delta', ops: [{ id: 'other-1', collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'other' }, timestamp: new Date(Date.now() + 30_000).toISOString(), clientId: 'c2' }] });
    a.socket.readyState = FakeSocket.CLOSED;
    a.socket.onclose?.();
    vi.advanceTimersByTime(100);
    const editedAt = Date.now();
    first.updateInCollection('notes', 'n1', { title: 'mine' });
    await tick();
    vi.advanceTimersByTime(1000);
    const second = new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });
    const b = connectTo(second, ahead());
    b.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    const op = pushedOps(b.socket).find((o) => o.recordId === 'n1');
    expect((op?.data as { title?: string } | undefined)?.title).toBe('mine');
    expect(Date.parse(op!.timestamp)).toBeGreaterThanOrEqual(editedAt + 60_000);
  });

  // The other way: weighed by a stamp a minute behind the record's, the edit sent was taken for
  // older than the record and sent again as it stood, in this clock's time, a minute ahead.
  it('is not sent again in this clock time, on a device ahead of the host', async () => {
    const backing = storage();
    const behind = () => new Date(Date.now() - 60_000).toISOString();
    const first = new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });
    const a = connectTo(first, behind());
    a.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    vi.advanceTimersByTime(100);
    first.updateInCollection('notes', 'n1', { title: 'E1' });
    await tick();
    const second = new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });
    const b = connectTo(second, behind());
    b.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    // Answered, what the queue held after it for the record goes next.
    b.socket.receive({ type: 'sync_ack', opIds: b.socket.sent.filter((m) => m.type === 'sync_push').flatMap((m) => (m.ops as Array<{ id: string }>).map((o) => o.id)) });
    await tick();
    expect(pushedOps(b.socket).length).toBeGreaterThan(0);
    for (const op of pushedOps(b.socket)) expect(Date.parse(op.timestamp), op.operation).toBeLessThan(Date.now() - 50_000);
  });
});

describe('an edit or a removal made just after a write it heard', () => {
  // A removal made while no client listened kept only its time, and went out unfloored, before
  // the write it came after: the host took it for older and sent the record back.
  it('is stamped after that write when no client listened as it was made', async () => {
    const s = new XDBService(storage(), 'xdb:app', 'app', { backend: 'storage' });
    const c = connectTo(s, '2026-03-01T00:00:00.900Z');
    c.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    c.socket.receive({ type: 'sync_delta', ops: [{ id: 'server-1', collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'from hook' }, timestamp: '2026-03-01T00:00:00.950Z', clientId: 'server' }] });
    c.sync.disconnect();
    vi.advanceTimersByTime(100);
    s.hardDelete('notes', 'n1');
    const d = connectTo(s, '2026-03-01T00:00:01.000Z');
    d.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    await tick();
    const op = pushedOps(d.socket).find((o) => o.recordId === 'n1' && o.operation === 'delete');
    expect(op).toBeDefined();
    expect(Date.parse(op!.timestamp)).toBeGreaterThan(Date.parse('2026-03-01T00:00:00.950Z'));
  });

  it('is stamped after that write, deletions and removals too', async () => {
    for (const remove of ['deleteFromCollection', 'hardDelete'] as const) {
      const s = new XDBService(storage(), 'xdb:app', 'app', { backend: 'storage' });
      const c = connectTo(s, '2026-03-01T00:00:00.900Z');
      c.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
      c.socket.receive({ type: 'sync_delta', ops: [{ id: 'server-1', collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'from hook' }, timestamp: '2026-03-01T00:00:00.950Z', clientId: 'server' }] });
      vi.advanceTimersByTime(100);
      if (remove === 'deleteFromCollection') s.deleteFromCollection('notes', 'n1');
      else s.hardDelete('notes', 'n1');
      await tick();
      const op = pushedOps(c.socket).find((o) => o.recordId === 'n1');
      expect(op?.operation, remove).toBe('delete');
      expect(Date.parse(op!.timestamp), remove).toBeGreaterThan(Date.parse('2026-03-01T00:00:00.950Z'));
      c.sync.disconnect();
    }
  });

  // The floor was the record's new stamp, this clock's time: on a device ahead of the host it
  // stood in for the offset, and the op went out in this clock's time, past edits other devices
  // made in between, which the host then took for older and undid.
  it('is stamped in the host time on a device whose clock runs fast', async () => {
    const s = new XDBService(storage(), 'xdb:app', 'app', { backend: 'storage' });
    // The host's clock is a minute behind this device's.
    const c = connectTo(s, '2026-02-28T23:59:00.000Z');
    c.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    vi.advanceTimersByTime(100);
    s.updateInCollection('notes', 'n1', { title: 'edited' });
    await tick();
    const op = pushedOps(c.socket).find((o) => o.recordId === 'n1');
    expect(op?.timestamp).toBe('2026-02-28T23:59:00.100Z');
  });

  // The first edit's stamp followed the host's copy, in the host's time; taken for this
  // device's own, the next edit went out unfloored, before it, and the host dropped it.
  it('stamps a second edit after the first, when the first followed a write it heard', async () => {
    const s = new XDBService(storage(), 'xdb:app', 'app', { backend: 'storage' });
    const c = connectTo(s, '2026-03-01T00:00:00.900Z');
    c.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    c.socket.receive({ type: 'sync_delta', ops: [{ id: 'server-1', collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'from hook' }, timestamp: '2026-03-01T00:00:00.950Z', clientId: 'server' }] });
    vi.advanceTimersByTime(100);
    s.updateInCollection('notes', 'n1', { title: 'one' });
    await tick();
    const [first] = pushedOps(c.socket);
    c.socket.receive({ type: 'sync_ack', opIds: [(first as { id?: string }).id] });
    vi.advanceTimersByTime(100);
    s.updateInCollection('notes', 'n1', { title: 'two' });
    await tick();
    const [, second] = pushedOps(c.socket);
    expect(Date.parse(first.timestamp)).toBeGreaterThan(Date.parse('2026-03-01T00:00:00.950Z'));
    expect(Date.parse(second.timestamp)).toBeGreaterThan(Date.parse(first.timestamp));
  });

  // A create and an edit of it in one millisecond: the create's own stamp, this clock's time,
  // counted as a copy the edit followed, and the edit went out in this clock's time.
  it('is stamped in the host time when edited in the millisecond it was made, on a fast device', async () => {
    const s = new XDBService(storage(), 'xdb:app', 'app', { backend: 'storage' });
    const c = connectTo(s, '2026-02-28T23:59:00.000Z');
    c.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    vi.advanceTimersByTime(100);
    const made = s.create('notes', { title: 'one' });
    s.updateInCollection('notes', made.id, { title: 'two' });
    s.updateInCollection('notes', made.id, { title: 'three' });
    await tick();
    c.socket.receive({ type: 'sync_ack', opIds: pushedOps(c.socket).map((o) => (o as { id?: string }).id) });
    await tick();
    for (const op of pushedOps(c.socket)) expect(op.timestamp, op.operation).toBe('2026-02-28T23:59:00.100Z');
    expect(pushedOps(c.socket).map((o) => o.operation)).toEqual(['create', 'update']);
  });

  // The stamp was read back from the record for every change heard: the whole collection
  // parsed once a record, so an import of thousands held the tab for seconds.
  it('reads nothing back from the store to stamp a change', async () => {
    const s = new XDBService(storage(), 'xdb:app', 'app', { backend: 'storage' });
    const c = connectTo(s, '2026-03-01T00:00:00.000Z');
    c.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const get = vi.spyOn(s, 'get');
    const created = s.create('notes', { title: 'one' });
    s.update(created.id, { title: 'two' });
    s.delete(created.id);
    await tick();
    expect(get).not.toHaveBeenCalled();
    expect(pushedOps(c.socket).map((o) => o.operation)).toEqual(['create']);
  });

  it('is stamped after that write, whatever this clock says', async () => {
    const s = new XDBService(storage(), 'xdb:app', 'app', { backend: 'storage' });
    // This device is 900 ms behind the host: under a second counts as no offset.
    const c = connectTo(s, '2026-03-01T00:00:00.900Z');
    c.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 'v1', '2026-02-01T00:00:00.000Z')] });
    c.socket.receive({ type: 'sync_delta', ops: [{ id: 'server-1', collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'from hook' }, timestamp: '2026-03-01T00:00:00.950Z', clientId: 'server' }] });
    vi.advanceTimersByTime(100);
    s.updateInCollection('notes', 'n1', { title: 'after' });
    await tick();
    const op = pushedOps(c.socket).find((o) => o.recordId === 'n1');
    expect(op).toBeDefined();
    expect(Date.parse(op!.timestamp)).toBeGreaterThan(Date.parse('2026-03-01T00:00:00.950Z'));
  });
});
