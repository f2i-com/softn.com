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

describe('an edit or a removal made just after a write it heard', () => {
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
