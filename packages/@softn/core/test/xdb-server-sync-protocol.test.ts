/**
 * XDB server sync — what the client does with the host's answers that the
 * audit of 2026-10-21 found it mishandled, and the limits it shares with the
 * host (apps/softn-host-rust/sync-protocol.json).
 *
 * The server is driven by hand, as in xdb-server-sync.test.ts: a fake
 * WebSocket records what was sent and the test plays the server's answers.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XDBService } from '../src/runtime/xdb';
import { SYNC_LIMITS, XDBServerSync } from '../src/runtime/xdb-server-sync';

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
    this.receiveRaw(JSON.stringify(msg));
  }

  receiveRaw(data: string): void {
    this.onmessage?.({ data });
  }

  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

type Op = { id: string; collection: string; operation: string; recordId: string; data?: Record<string, unknown>; timestamp: string };

function storage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

const WS_URL = 'wss://sync.example.test/sync';

function authOk(socket: FakeSocket, serverTime = '2026-01-01T00:00:00.000Z'): void {
  socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime });
}

function pushed(socket: FakeSocket): Op[] {
  return socket.ofType('sync_push').flatMap((push) => push.ops as Op[]);
}

/**
 * A client of `xdb` connected and authenticated on a socket of its own, the
 * host's clock at `serverTime` (a whole pull places a collection no later
 * than that).
 */
function connected(xdb: XDBService, config: { collections?: string[]; reconnectDelay?: number } = {}, serverTime?: string) {
  const sync = new XDBServerSync(xdb, { wsUrl: WS_URL, ...config });
  sync.connect();
  const socket = FakeSocket.made[FakeSocket.made.length - 1];
  socket.open();
  authOk(socket, serverTime);
  return { sync, socket };
}

let xdb: XDBService;

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  xdb = new XDBService(storage(), 'server-sync-protocol');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('limits shared with the host', () => {
  const protocol = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../apps/softn-host-rust/sync-protocol.json'), 'utf8')
  ) as Record<string, unknown> & { collectionNames: { valid: string[]; invalid: string[] } };

  it('are the ones this client holds to, or within them', () => {
    expect(SYNC_LIMITS.maxMessageBytes).toBe(protocol.maxMessageBytes);
    expect(SYNC_LIMITS.maxPullCollections).toBe(protocol.maxPullCollections);
    expect(SYNC_LIMITS.pageRows).toBe(protocol.pageRows);
    expect(SYNC_LIMITS.collectionName).toBe(protocol.collectionName);
    // A push the host takes: no more ops than it reads, and well inside a message.
    expect(SYNC_LIMITS.maxOpsPerPush).toBeLessThanOrEqual(protocol.maxOpsPerPush as number);
    expect(SYNC_LIMITS.maxPushBytes).toBeLessThanOrEqual(protocol.maxPushDataBytes as number);
    expect(SYNC_LIMITS.maxPushBytes).toBeLessThan(protocol.maxMessageBytes as number);
    // What the host sends in pieces fits in a message this client takes.
    expect(protocol.pieceBytes as number).toBeLessThan(SYNC_LIMITS.maxMessageBytes);
    expect(protocol.maxOpDataBytes as number).toBeLessThan(protocol.pieceBytes as number);
  });

  it('name collections as the host does', () => {
    const rule = new RegExp(SYNC_LIMITS.collectionName);
    for (const name of protocol.collectionNames.valid) expect(rule.test(name), name).toBe(true);
    for (const name of protocol.collectionNames.invalid) expect(rule.test(name), name).toBe(false);
  });
});

describe('the socket', () => {
  it('says nothing on open, and subscribes to its collections, none yet included', () => {
    const { sync, socket } = connected(xdb);
    try {
      expect(socket.sent.map((m) => m.type)).toEqual(['subscribe']);
      expect(socket.sent[0]).toEqual({ type: 'subscribe', collections: [] });
    } finally {
      sync.disconnect();
    }
  });

  it('gives each client op ids of its own', () => {
    const a = new XDBService(storage(), 'a');
    const b = new XDBService(storage(), 'b');
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const one = connected(a);
    const two = connected(b);
    try {
      a.create('notes', { n: 1 });
      b.create('notes', { n: 1 });
      const [x] = pushed(one.socket);
      const [y] = pushed(two.socket);
      // Made in the same millisecond, the first op of each page.
      expect(x.id).not.toBe(y.id);
    } finally {
      one.sync.disconnect();
      two.sync.disconnect();
    }
  });
});

/**
 * Records written before the client started listening: before it existed
 * (the renderer starts it after consent and after an async import), or
 * between a disconnect and the next connect. They were never pushed, and the
 * host refused every later edit of them ("Record not found").
 */
describe('a record written while no client listened', () => {
  it('reaches the server when the client connects, and so do its later edits', () => {
    const early = xdb.create('notes', { title: 'before sync started' });
    const { sync, socket } = connected(xdb, { collections: ['notes'] });
    try {
      socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
      const [create] = pushed(socket);
      expect([create.operation, create.recordId, create.data]).toEqual(['create', early.id, { title: 'before sync started' }]);
      socket.receive({ type: 'sync_ack', opIds: [create.id] });
      xdb.update(early.id, { title: 'edited' });
      expect(pushed(socket).map((op) => [op.operation, op.recordId])).toEqual([['create', early.id], ['update', early.id]]);
    } finally {
      sync.disconnect();
    }
  });

  it('goes at the time it was made, not when the client found it', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    xdb.create('notes', { title: 'old' });
    vi.advanceTimersByTime(60_000);
    // The host's clock and this device's agree.
    const { sync, socket } = connected(xdb, { collections: ['notes'] }, '2026-01-01T00:01:00.000Z');
    try {
      socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
      expect(pushed(socket)[0].timestamp).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      sync.disconnect();
    }
  });

  it('between a disconnect and a connect is found, as the right op, and nothing else is', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const first = connected(xdb, { collections: ['notes'] });
    const theirs = (id: string) => ({ id, collection: 'notes', data: { title: id }, createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z' });
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [theirs('kept'), theirs('edited'), theirs('deleted')] });
    vi.advanceTimersByTime(10);
    first.sync.disconnect();

    // Nothing listens: an effect's cleanup and re-run, or a reload before consent.
    vi.advanceTimersByTime(10);
    xdb.updateInCollection('notes', 'edited', { title: 'edited here' });
    xdb.deleteFromCollection('notes', 'deleted');
    const created = xdb.create('notes', { title: 'new' });
    const fleeting = xdb.create('notes', { title: 'gone again' });
    xdb.deleteFromCollection('notes', fleeting.id);

    const second = new XDBServerSync(xdb, { wsUrl: WS_URL, collections: ['notes'] });
    second.connect();
    const socket = FakeSocket.made[1];
    try {
      socket.open();
      authOk(socket);
      socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
      const sent = pushed(socket).map((op) => [op.operation, op.recordId]);
      expect(sent).toEqual([
        ['update', 'edited'],
        ['delete', 'deleted'],
        ['create', created.id],
      ]);
    } finally {
      second.disconnect();
    }
  });

  it('is not looked for in a store an older client synced, which has no mark', () => {
    // An older client left a place and no mark of where listening stopped.
    const shared = storage();
    shared.setItem('upgraded::sync-pulled', JSON.stringify({ v: 1, url: WS_URL, collections: { notes: { at: '2025-12-01T00:00:00.000Z', id: 'x' } } }));
    const store = new XDBService(shared, 'upgraded');
    store.create('notes', { title: 'synced long ago' });
    const { sync, socket } = connected(store, { collections: ['notes'] });
    try {
      socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
      expect(pushed(socket)).toEqual([]);
    } finally {
      sync.disconnect();
    }
  });
});

/**
 * An edit made here that the host overruled, while this device was away.
 * The host answered the push with the records as they stand, all in one
 * message, which was larger than this client took (2 MB): it dropped it and
 * kept the edits that lost. Its reconnect pull had passed over the same
 * records (an edit was waiting on them) and moved its place past them, so no
 * later pull brought them again.
 */
describe('a record the pull passed over for an edit made here', () => {
  const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
  const row = (id: string, n: number, title: string) => ({ id, collection: 'notes', data: { title }, createdAt: at(0), updatedAt: at(n), serverReceivedAt: at(n) });

  it('holds the place before it, so the next pull brings it again', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:01:00.000Z') });
    const shared = storage();
    const store = new XDBService(shared, 'held');
    const first = connected(store, { collections: ['notes'], reconnectDelay: 10 }, '2026-01-01T00:00:30.000Z');
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a', 1, 'a'), row('b', 2, 'b'), row('c', 3, 'c')] });
    first.socket.drop();
    store.updateInCollection('notes', 'b', { title: 'mine' });

    vi.advanceTimersByTime(20);
    const second = FakeSocket.made[1];
    second.open();
    authOk(second, '2026-01-01T00:02:00.000Z');
    // b changed on the host meanwhile, and so did d after it.
    second.receive({ type: 'sync_state', collection: 'notes', records: [row('b', 5, 'theirs'), row('d', 6, 'd')] });
    try {
      expect(store.get('notes', 'b')?.data).toEqual({ title: 'mine' });
      expect(store.get('notes', 'd')?.data).toEqual({ title: 'd' });
      // The answer that would have put b right never comes; the page closes.
      first.sync.disconnect();
      store.destroy();

      const again = new XDBService(shared, 'held');
      const third = connected(again, { collections: ['notes'] });
      const [pull] = third.socket.ofType('sync_pull');
      // From before b, not from d.
      expect(pull.lastSync! < at(5)).toBe(true);
      third.sync.disconnect();
    } finally {
      first.sync.disconnect();
    }
  });

  it('does not keep the rest of a long catch-up waiting: it is asked for from where the pull read to', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:01:00.000Z') });
    const first = connected(xdb, { collections: ['notes'], reconnectDelay: 10 });
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a', 1, 'a')] });
    first.socket.drop();
    xdb.updateInCollection('notes', 'a', { title: 'mine' });
    vi.advanceTimersByTime(20);
    const second = FakeSocket.made[1];
    second.open();
    authOk(second);
    try {
      const pulls = () => second.ofType('sync_pull');
      expect(pulls()).toHaveLength(1);
      // A full answer from a point: a, held, then the rest of ten thousand
      // (deletions of records this device never had, which cost nothing to apply).
      const records: Array<ReturnType<typeof row> & { deleted?: boolean }> = [row('a', 2, 'theirs')];
      for (let i = 0; i < 9999; i++) records.push({ ...row(`r${String(i).padStart(5, '0')}`, 3, 'x'), deleted: true });
      second.receive({ type: 'sync_state', collection: 'notes', records });
      expect(pulls()).toHaveLength(2);
      expect(pulls()[1]).toMatchObject({ lastSync: at(3), lastId: 'r09998' });
    } finally {
      first.sync.disconnect();
    }
  });

  it('takes a message of the size the host sends, and holds the place of one too large to take', () => {
    const { sync, socket } = connected(xdb, { collections: ['notes'] }, '2026-01-01T00:00:30.000Z');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Three records of a megabyte: more than the 2 MB this client used to take.
      const big = 'x'.repeat(1024 * 1024);
      const records = ['a', 'b', 'c'].map((id, n) => ({ ...row(id, n + 1, id), data: { big } }));
      socket.receive({ type: 'sync_state', collection: 'notes', records });
      expect(xdb.query('notes')).toHaveLength(3);
      // Over the limit both sides hold to: dropped, and the next piece moves no place.
      socket.receiveRaw(JSON.stringify({ type: 'sync_state', collection: 'notes', records: [{ ...row('d', 4, 'd'), data: { big: 'y'.repeat(5 * 1024 * 1024) } }] }));
      expect(warn).toHaveBeenCalled();
      socket.receive({ type: 'sync_state', collection: 'notes', records: [row('e', 5, 'e')] });
      expect(xdb.get('notes', 'e')).not.toBeNull();
      socket.drop();
    } finally {
      sync.disconnect();
    }
    const again = connected(xdb, { collections: ['notes'] });
    try {
      const [pull] = again.socket.ofType('sync_pull');
      expect(pull.lastSync! < at(4)).toBe(true);
    } finally {
      again.sync.disconnect();
    }
  });
});

/**
 * A pull the host refused for now ("Server busy"). The client never asked
 * again, and its pushes, which wait for the first pull, waited for good.
 */
describe('a pull the host refused', () => {
  it('is asked for again after the time the host gave, and the pushes go once it is answered', () => {
    vi.useFakeTimers();
    const { sync, socket } = connected(xdb, { collections: ['notes', 'tags'], reconnectDelay: 100 });
    try {
      xdb.create('notes', { title: 'waiting' });
      socket.receive({ type: 'error', message: 'Server busy', for: 'pull', collections: ['notes', 'tags'], retryAfter: 2 });
      expect(socket.ofType('sync_pull')).toHaveLength(1);
      vi.advanceTimersByTime(1500);
      expect(socket.ofType('sync_pull')).toHaveLength(1);
      vi.advanceTimersByTime(600);
      expect(socket.ofType('sync_pull').slice(1)).toEqual([{ type: 'sync_pull', collections: ['notes', 'tags'] }]);
      expect(pushed(socket)).toEqual([]);
      socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
      expect(pushed(socket).map((op) => op.operation)).toEqual(['create']);
    } finally {
      sync.disconnect();
    }
  });

  it('leaves the pushes in flight alone', () => {
    vi.useFakeTimers();
    const { sync, socket } = connected(xdb, { reconnectDelay: 100 });
    try {
      xdb.create('notes', { title: 'one' });
      expect(pushed(socket)).toHaveLength(1);
      // The first use of notes pulled it; the host refuses that pull.
      socket.receive({ type: 'error', message: 'Server busy', for: 'pull', collections: ['notes'], retryAfter: 1 });
      vi.advanceTimersByTime(60_000);
      expect(pushed(socket)).toHaveLength(1);
    } finally {
      sync.disconnect();
    }
  });

  it('is not asked for again when the host refuses it for good', () => {
    vi.useFakeTimers();
    const { sync, socket } = connected(xdb, { collections: ['notes'] });
    try {
      socket.receive({ type: 'error', message: 'Invalid collection name', for: 'pull', collections: ['notes'] });
      vi.advanceTimersByTime(120_000);
      expect(socket.ofType('sync_pull')).toHaveLength(1);
    } finally {
      sync.disconnect();
    }
  });

  it('from a host that does not say what it refused, is asked for again when it was the first pull', () => {
    vi.useFakeTimers();
    const { sync, socket } = connected(xdb, { collections: ['notes'], reconnectDelay: 100 });
    try {
      socket.receive({ type: 'error', message: 'Server busy — too many concurrent sync operations, retry later' });
      vi.advanceTimersByTime(200);
      expect(socket.ofType('sync_pull')).toHaveLength(2);
    } finally {
      sync.disconnect();
    }
  });
});

/**
 * An op put back in the queue by an error that was not about it, and then
 * acknowledged. The acknowledgement was ignored, and the op went again: the
 * host applied and broadcast it twice.
 */
describe('an op acknowledged after it was put back in the queue', () => {
  it('is not sent again', () => {
    vi.useFakeTimers();
    const { sync, socket } = connected(xdb, { reconnectDelay: 100 });
    try {
      xdb.create('notes', { title: 'once' });
      const [op] = pushed(socket);
      // A host from before says nothing of what it refused.
      socket.receive({ type: 'error', message: 'Invalid collection name: x' });
      socket.receive({ type: 'sync_ack', opIds: [op.id] });
      vi.advanceTimersByTime(60_000);
      expect(pushed(socket).map((o) => o.id)).toEqual([op.id]);
    } finally {
      sync.disconnect();
    }
  });
});

/** The `collections` setting: what the server sends of other collections is not written here. */
describe('a client with a list of collections', () => {
  const rec = (collection: string, id: string) => ({ id, collection, data: { id }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

  it('writes only its own', () => {
    const { sync, socket } = connected(xdb, { collections: ['notes'] });
    try {
      socket.receive({ type: 'sync_state', collection: 'notes', records: [rec('notes', 'n1')] });
      socket.receive({ type: 'sync_state', collection: 'secrets', records: [rec('secrets', 's1')] });
      socket.receive({
        type: 'sync_delta',
        ops: [
          { id: 'o1', collection: 'other', operation: 'create', recordId: 'x1', data: { a: 1 }, timestamp: '2026-01-01T00:00:00.000Z', clientId: 'c9' },
          { id: 'o2', collection: 'notes', operation: 'create', recordId: 'n2', data: { a: 1 }, timestamp: '2026-01-01T00:00:00.000Z', clientId: 'c9' },
        ],
      });
      expect(xdb.getCollections().sort()).toEqual(['notes']);
      expect(xdb.query('notes').map((r) => r.id).sort()).toEqual(['n1', 'n2']);
      expect(socket.ofType('subscribe')).toEqual([{ type: 'subscribe', collections: ['notes'] }]);
    } finally {
      sync.disconnect();
    }
  });

  it('and one it writes to itself', () => {
    const { sync, socket } = connected(xdb, { collections: ['notes'] });
    try {
      socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
      const mine = xdb.create('drafts', { title: 'here' });
      const [op] = pushed(socket);
      // The host's answer to it: the record as a hook stored it.
      socket.receive({ type: 'sync_ack', opIds: [op.id] });
      socket.receive({
        type: 'sync_delta',
        ops: [{ id: op.id, collection: 'drafts', operation: 'update', recordId: mine.id, data: { title: 'here', stampedBy: 'server' }, timestamp: '2026-01-01T00:00:00.000Z', clientId: 'server' }],
      });
      expect(xdb.get('drafts', mine.id)?.data).toEqual({ title: 'here', stampedBy: 'server' });
    } finally {
      sync.disconnect();
    }
  });

  it('and one it wrote to before a reload, whose op is still waiting', () => {
    const shared = storage();
    const store = new XDBService(shared, 'reloaded');
    const first = connected(store, { collections: ['notes'] });
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const mine = store.create('drafts', { title: 'here' });
    first.sync.disconnect();
    store.destroy();

    const again = new XDBService(shared, 'reloaded');
    const second = connected(again, { collections: ['notes'] });
    try {
      second.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
      const [op] = pushed(second.socket);
      expect([op.collection, op.recordId]).toEqual(['drafts', mine.id]);
      second.socket.receive({ type: 'sync_ack', opIds: [op.id] });
      second.socket.receive({
        type: 'sync_delta',
        ops: [{ id: op.id, collection: 'drafts', operation: 'update', recordId: mine.id, data: { title: 'here', stampedBy: 'server' }, timestamp: '2026-01-01T00:00:00.000Z', clientId: 'server' }],
      });
      expect(again.get('drafts', mine.id)?.data).toEqual({ title: 'here', stampedBy: 'server' });
    } finally {
      second.sync.disconnect();
    }
  });

  it('does not ask for a name the host would refuse', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sync, socket } = connected(xdb, { collections: ['notes', 'bad name'] });
    try {
      expect(socket.ofType('sync_pull')).toEqual([{ type: 'sync_pull', collections: ['notes'] }]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      sync.disconnect();
    }
  });
});

/**
 * A collection first used after the client connected. A client with no list
 * pulled the collections it knew when it connected, and no other until it
 * connected again.
 */
describe('a collection first used while connected', () => {
  it('is pulled then, once', () => {
    const { sync, socket } = connected(xdb);
    try {
      expect(socket.ofType('sync_pull')).toEqual([]);
      xdb.create('notes', { title: 'first' });
      xdb.create('notes', { title: 'second' });
      expect(socket.ofType('sync_pull')).toEqual([{ type: 'sync_pull', collections: ['notes'] }]);
      // And pushed as well: the pull does not hold it back.
      expect(pushed(socket)).toHaveLength(2);
    } finally {
      sync.disconnect();
    }
  });
});
