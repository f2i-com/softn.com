/**
 * XDB server sync — what the client does with the socket and with the
 * mutations it makes while the socket is down.
 *
 * The server is driven by hand: a fake WebSocket records what was sent and
 * the test plays the server's answers back into it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XDBService, createEphemeralXDBScope } from '../src/runtime/xdb';
import { XDBServerSync, backoffDelay, syncTicketUrl } from '../src/runtime/xdb-server-sync';
import { createDBNamespace } from '../src/runtime/script-runtime';

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

  /** The server accepted the connection. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** The server said something. */
  receive(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The connection dropped. */
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

function createTestStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
}

function authOk(socket: FakeSocket): void {
  socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: '2026-01-01T00:00:00Z' });
}

let xdb: XDBService;

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  xdb = new XDBService(createTestStorage(), 'server-sync-test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('XDBServerSync', () => {
  it('asks for the next page of a collection the host says has more, until it has it all', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'] });
    sync.connect();
    const socket = FakeSocket.made[0];
    const row = (id: string) => ({ id, collection: 'notes', data: { text: id }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    try {
      socket.open();
      authOk(socket);
      expect(socket.ofType('sync_pull')).toEqual([{ type: 'sync_pull', collections: ['notes'] }]);
      // A full page arrives in pieces; only the last piece says there is more.
      socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a')] });
      expect(socket.ofType('sync_pull')).toHaveLength(1);
      socket.receive({ type: 'sync_state', collection: 'notes', records: [row('b')], more: { at: '2026-01-01T00:00:02Z', id: 'b' } });
      expect(socket.ofType('sync_pull')[1]).toEqual({
        type: 'sync_pull',
        collections: ['notes'],
        cursor: { at: '2026-01-01T00:00:02Z', id: 'b' },
      });
      // The last page is not full and asks for nothing.
      socket.receive({ type: 'sync_state', collection: 'notes', records: [row('c')] });
      expect(socket.ofType('sync_pull')).toHaveLength(2);
      expect(xdb.query('notes').map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
      // Something that is not a cursor is not followed.
      socket.receive({ type: 'sync_state', collection: 'notes', records: [], more: { at: 7 } });
      socket.receive({ type: 'sync_state', collection: 'notes', records: [], more: null });
      expect(socket.ofType('sync_pull')).toHaveLength(2);
    } finally {
      sync.disconnect();
    }
  });

  it('pushes collection-scoped edits and deletes with the original record identity', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    try {
      socket.open();
      authOk(socket);
      // A record the server has.
      const record = { id: 'n1', collection: 'notes', data: { text: 'before' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      socket.receive({ type: 'sync_state', collection: 'notes', records: [record] });
      xdb.updateInCollection('notes', record.id, { text: 'after' });
      xdb.deleteFromCollection('notes', record.id);
      // One op of a record at a time: the delete goes once the update is answered.
      const [update] = socket.ofType('sync_push').flatMap((push) => push.ops as Array<{ id: string }>);
      socket.receive({ type: 'sync_ack', opIds: [update.id] });
      const operations = socket
        .ofType('sync_push')
        .flatMap((push) => push.ops as Array<Record<string, unknown>>);
      expect(operations.map((op) => op.operation)).toEqual(['update', 'delete']);
      expect(operations.every((op) => op.collection === 'notes' && op.recordId === record.id)).toBe(
        true
      );
    } finally {
      sync.disconnect();
    }
  });

  it('refuses a plaintext socket whatever the case of the scheme', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: 'WS://sync.example.test/sync', appVersion: '1' });
    const errors: string[] = [];
    sync.on('error', (err) => errors.push(String(err)));
    sync.connect();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Insecure ws:/);
    expect(FakeSocket.made).toHaveLength(0);
  });

  it('queues what the app writes before the socket is up, and before the client existed, and pushes it after the pull', () => {
    // Written before there was a client at all (it starts after consent).
    xdb.create('notes', { text: 'seed' });
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];

    // Offline: the socket has not opened yet.
    xdb.create('notes', { text: 'written offline' });

    socket.open();
    // Nothing is said on open: the host speaks first.
    expect(socket.sent).toEqual([]);
    authOk(socket);
    expect(socket.ofType('sync_pull')).toHaveLength(1);
    // Not before the pull has answered.
    expect(socket.ofType('sync_push')).toHaveLength(0);

    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const pushes = socket.ofType('sync_push');
    expect(pushes).toHaveLength(1);
    const ops = pushes[0].ops as Array<Record<string, unknown>>;
    expect(ops.map((op) => [op.operation, (op.data as { text: string }).text])).toEqual([
      ['create', 'seed'],
      ['create', 'written offline'],
    ]);
    expect(ops.every((op) => op.clientId === 'c1')).toBe(true);

    sync.disconnect();
  });

  it('pushes straight away when there was nothing to pull', () => {
    // A fresh app: no collections yet, so no pull is sent and the pull is
    // done by definition. Its first record used to sit unpushed forever.
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    socket.open();
    authOk(socket);
    expect(socket.ofType('sync_pull')).toHaveLength(0);

    xdb.create('notes', { text: 'first' });
    expect(socket.ofType('sync_push')).toHaveLength(1);

    sync.disconnect();
  });

  it('does not replay the session on reconnect', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      reconnectDelay: 10,
    });
    sync.connect();
    const first = FakeSocket.made[0];
    first.open();
    authOk(first);
    xdb.create('notes', { text: 'one' });
    xdb.create('notes', { text: 'two' });
    expect(first.ofType('sync_push')).toHaveLength(2);
    // The host stored both.
    for (const push of first.ofType('sync_push')) {
      first.receive({
        type: 'sync_ack',
        opIds: (push.ops as Array<{ id: string }>).map((op) => op.id),
      });
    }

    // Written while down: this one, and only this one, goes out after.
    first.drop();
    xdb.create('notes', { text: 'offline' });

    vi.advanceTimersByTime(20);
    const second = FakeSocket.made[1];
    expect(second).toBeDefined();
    second.open();
    authOk(second);
    second.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const pushes = second.ofType('sync_push');
    expect(pushes).toHaveLength(1);
    const ops = pushes[0].ops as Array<Record<string, unknown>>;
    expect(ops.map((op) => (op.data as { text: string }).text)).toEqual(['offline']);

    sync.disconnect();
  });

  it('sends an op the host never answered again after a reconnect', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      reconnectDelay: 10,
    });
    sync.connect();
    const first = FakeSocket.made[0];
    first.open();
    authOk(first);
    xdb.create('notes', { text: 'stored' });
    xdb.create('notes', { text: 'lost with the connection' });
    const [stored] = first.ofType('sync_push')[0].ops as Array<{ id: string }>;
    first.receive({ type: 'sync_ack', opIds: [stored.id] });
    first.drop();

    vi.advanceTimersByTime(20);
    const second = FakeSocket.made[1];
    second.open();
    authOk(second);
    second.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const ops = second
      .ofType('sync_push')
      .flatMap((p) => p.ops as Array<{ data: { text: string } }>);
    expect(ops.map((op) => op.data.text)).toEqual(['lost with the connection']);
    sync.disconnect();
  });

  it('keeps an op the host asked to retry and pushes it again after a backoff', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      reconnectDelay: 100,
    });
    sync.connect();
    const socket = FakeSocket.made[0];
    socket.open();
    authOk(socket);
    xdb.create('notes', { text: 'quota full' });
    const [op] = socket.ofType('sync_push')[0].ops as Array<{ id: string }>;
    socket.receive({ type: 'sync_retry', opIds: [op.id], reason: 'Storage quota exceeded' });
    // Not straight back into the same refusal.
    expect(socket.ofType('sync_push')).toHaveLength(1);
    vi.advanceTimersByTime(100);
    const pushes = socket.ofType('sync_push');
    expect(pushes).toHaveLength(2);
    expect((pushes[1].ops as Array<{ id: string }>).map((o) => o.id)).toEqual([op.id]);
    // Acknowledged, it is done: nothing more goes out.
    socket.receive({ type: 'sync_ack', opIds: [op.id] });
    vi.advanceTimersByTime(60_000);
    expect(socket.ofType('sync_push')).toHaveLength(2);
    sync.disconnect();
  });

  it('sends a long offline queue in pushes the host accepts', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    for (let i = 0; i < 1200; i++) xdb.create('notes', { text: `offline ${i}` });
    socket.open();
    authOk(socket);
    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const pushes = socket.ofType('sync_push');
    expect(pushes.length).toBeGreaterThan(2);
    for (const push of pushes) {
      expect((push.ops as unknown[]).length).toBeLessThanOrEqual(500);
      expect(JSON.stringify(push).length).toBeLessThan(4 * 1024 * 1024);
    }
    expect(pushes.reduce((n, p) => n + (p.ops as unknown[]).length, 0)).toBe(1200);
    sync.disconnect();
  });

  it('lets a socket closing late leave the one that replaced it alone', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      reconnectDelay: 10,
    });
    sync.connect();
    const first = FakeSocket.made[0];
    first.open();
    authOk(first);
    expect(sync.status.connected).toBe(true);

    sync.disconnect();
    expect(sync.status.connected).toBe(false);
    sync.connect();
    const second = FakeSocket.made[1];
    second.open();
    authOk(second);

    // The browser fires the first socket's close after disconnect() asked
    // for it. It used to null out the second socket and schedule a third.
    first.onclose?.();
    expect(sync.status.connected).toBe(true);
    vi.advanceTimersByTime(50);
    expect(FakeSocket.made).toHaveLength(2);

    xdb.create('notes', { text: 'still routed' });
    expect(second.ofType('sync_push')).toHaveLength(1);
    expect(first.ofType('sync_push')).toHaveLength(0);

    sync.disconnect();
  });
});

/**
 * A record this device deleted, which the server kept.
 *
 * The host weighs a delete by when it was made: one older than the record's
 * last change is acknowledged without being applied, and the pusher is sent
 * the record as it stands (apps/softn-host-rust/src/sync.rs). The client kept
 * a record it had deleted deleted whatever an update delta said, so it went
 * on hiding a record the server and every other device still had. Its own
 * delete holds only while the server has not answered it; after that, what
 * the server sends is the record.
 */
describe('a record deleted here that the server says still stands', () => {
  const stamp = '2026-01-02T00:00:00Z';
  const row = { id: 'n1', collection: 'notes', data: { title: 'final' }, createdAt: stamp, updatedAt: stamp };

  /** A synced app with n1 on both sides, and n1 then deleted here. */
  function deletedHere() {
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'] });
    sync.connect();
    const socket = FakeSocket.made[0];
    socket.open();
    authOk(socket);
    socket.receive({ type: 'sync_state', collection: 'notes', records: [row] });
    expect(xdb.query('notes').map((r) => r.id)).toEqual(['n1']);
    xdb.deleteFromCollection('notes', 'n1');
    const pushed = socket.ofType('sync_push').flatMap((push) => push.ops as Array<Record<string, unknown>>);
    const deleteOp = pushed.find((op) => op.operation === 'delete' && op.recordId === 'n1');
    expect(deleteOp).toBeDefined();
    const current = {
      type: 'sync_delta',
      ops: [{ id: 'cur1', collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'final' }, timestamp: stamp, clientId: 'server' }],
    };
    return { sync, socket, deleteOp: deleteOp!, current };
  }

  it('stays hidden while the delete has not been answered', () => {
    const { sync, socket, current } = deletedHere();
    try {
      socket.receive(current);
      expect(xdb.query('notes')).toEqual([]);
    } finally {
      sync.disconnect();
    }
  });

  it('comes back when the server has answered the delete and sends the record as it stands', () => {
    const { sync, socket, deleteOp, current } = deletedHere();
    try {
      socket.receive({ type: 'sync_ack', opIds: [deleteOp.id] });
      socket.receive(current);
      const shown = xdb.query('notes');
      expect(shown.map((r) => r.id)).toEqual(['n1']);
      expect(shown[0].data).toEqual({ title: 'final' });
    } finally {
      sync.disconnect();
    }
  });

  it('comes back when the server sends the record as it stands before it acknowledges the delete', () => {
    const { sync, socket, deleteOp } = deletedHere();
    try {
      // The host answers the delete it did not apply under the delete's own id.
      const answer = { id: deleteOp.id as string, collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'final' }, timestamp: stamp, clientId: 'server' };
      socket.receive({ type: 'sync_delta', ops: [answer] });
      expect(xdb.query('notes').map((r) => r.id)).toEqual(['n1']);
      socket.receive({ type: 'sync_ack', opIds: [deleteOp.id] });
      expect(xdb.query('notes').map((r) => r.id)).toEqual(['n1']);
    } finally {
      sync.disconnect();
    }
  });

  it('stays hidden for the answer to another op, and for another client\'s edit', () => {
    const { sync, socket, deleteOp } = deletedHere();
    try {
      const edit = { collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'final' }, timestamp: stamp };
      // Another device's op ids are made as this one's are, and may match.
      socket.receive({ type: 'sync_delta', ops: [{ ...edit, id: deleteOp.id, clientId: 'c9' }] });
      socket.receive({ type: 'sync_delta', ops: [{ ...edit, id: 'op_1_1', clientId: 'server' }] });
      expect(xdb.query('notes')).toEqual([]);
    } finally {
      sync.disconnect();
    }
  });

  it('comes back from a pull once the delete was refused', () => {
    const { sync, socket, deleteOp } = deletedHere();
    try {
      socket.receive({ type: 'sync_reject', opId: deleteOp.id, reason: 'no' });
      socket.receive({ type: 'sync_state', collection: 'notes', records: [row] });
      expect(xdb.query('notes').map((r) => r.id)).toEqual(['n1']);
    } finally {
      sync.disconnect();
    }
  });
});

/**
 * The host weighs an edit by its stamp against the record's last change, and
 * stamps what it writes itself (a hook's `db.update`) by its own clock. An
 * edit stamped by a device clock behind the host's lost to any such write
 * made in the gap: acknowledged, not applied, and sent back undone. Edits are
 * stamped in the host's time, from the `serverTime` of its `auth_ok`.
 */
describe("an edit is stamped in the host's time", () => {
  const device = '2026-03-01T12:00:00.000Z';
  const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
  const minute = 60_000;
  const pushed = (socket: FakeSocket) =>
    socket.ofType('sync_push').flatMap((push) => push.ops as Array<{ data: { text: string }; timestamp: string }>);

  it('when the device clock is behind, made offline or online, and sent again unchanged', () => {
    vi.useFakeTimers({ now: new Date(device) });
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', reconnectDelay: 10 });
    sync.connect();
    const first = FakeSocket.made[0];
    try {
      xdb.create('notes', { text: 'offline' });
      vi.advanceTimersByTime(minute);
      first.open();
      // The host's clock is ten minutes ahead of this device's.
      first.receive({ type: 'auth_ok', clientId: 'c1', serverTime: later(device, 11 * minute) });
      first.receive({ type: 'sync_state', collection: 'notes', records: [] });
      xdb.create('notes', { text: 'online' });
      const stamps = pushed(first).map((op) => [op.data.text, op.timestamp]);
      expect(stamps).toEqual([
        ['offline', later(device, 10 * minute)],
        ['online', later(device, 11 * minute)],
      ]);
      // Unanswered, they go again on the next connection as they went.
      first.drop();
      vi.advanceTimersByTime(minute);
      const second = FakeSocket.made[1];
      second.open();
      second.receive({ type: 'auth_ok', clientId: 'c2', serverTime: later(device, 32 * minute) });
      second.receive({ type: 'sync_state', collection: 'notes', records: [] });
      expect(pushed(second).map((op) => [op.data.text, op.timestamp])).toEqual(stamps);
    } finally {
      sync.disconnect();
    }
  });

  it('not when the clocks are within a second, or the host gave no time it can read', () => {
    for (const serverTime of [later(device, 400), 'soon', undefined]) {
      vi.useFakeTimers({ now: new Date(device) });
      FakeSocket.made = [];
      // A store of its own each time: the op left unanswered by the one
      // before would otherwise be taken up and sent again.
      xdb = new XDBService(createTestStorage(), 'server-sync-test');
      const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
      sync.connect();
      const socket = FakeSocket.made[0];
      try {
        socket.open();
        socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime });
        xdb.create('notes', { text: String(serverTime) });
        socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
        expect(pushed(socket).map((op) => op.timestamp)).toEqual([device]);
      } finally {
        sync.disconnect();
        vi.useRealTimers();
      }
    }
  });
});

/** Every op this socket has pushed, in order. */
function pushedOps(socket: FakeSocket): Array<{ id: string; operation: string; recordId: string; data?: Record<string, unknown> }> {
  return socket.ofType('sync_push').flatMap((push) => push.ops as Array<{ id: string; operation: string; recordId: string; data?: Record<string, unknown> }>);
}

/**
 * An edit made here that the server has not answered yet.
 *
 * On reconnect the queued edit went out straight after the pull was asked
 * for, and the host answers a pull before it reads the push sent after it:
 * the pull brought the record as it was before the edit and it was written
 * over the edit. The host never sends a pusher its own edit back, so this
 * device kept the old value, and its next edit sent the old value to the
 * server as well.
 */
describe('an edit made here that the server has not answered', () => {
  const stamp = '2026-01-02T00:00:00Z';
  const before = { id: 'n1', collection: 'notes', data: { title: 'old', body: 'b' }, createdAt: stamp, updatedAt: stamp };

  it('is not undone by the pull of a reconnect, and the next edit sends it on', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'], reconnectDelay: 10 });
    sync.connect();
    const first = FakeSocket.made[0];
    try {
      first.open();
      authOk(first);
      first.receive({ type: 'sync_state', collection: 'notes', records: [before] });
      first.drop();
      xdb.updateInCollection('notes', 'n1', { title: 'new' });

      vi.advanceTimersByTime(20);
      const second = FakeSocket.made[1];
      second.open();
      authOk(second);
      // The pull is answered with the record as it stood before the push.
      second.receive({ type: 'sync_state', collection: 'notes', records: [before] });
      expect(xdb.get('notes', 'n1')?.data).toEqual({ title: 'new', body: 'b' });
      const sent = pushedOps(second);
      expect(sent.map((op) => [op.operation, op.data])).toEqual([['update', { title: 'new', body: 'b' }]]);
      second.receive({ type: 'sync_ack', opIds: sent.map((op) => op.id) });

      xdb.updateInCollection('notes', 'n1', { body: 'b2' });
      expect(pushedOps(second).at(-1)?.data).toEqual({ title: 'new', body: 'b2' });
    } finally {
      sync.disconnect();
    }
  });

  it('is not undone by the first pull when it was made before the socket was up', () => {
    // A store that has synced before, and has n1 from the server.
    const earlier = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'] });
    earlier.connect();
    FakeSocket.made[0].open();
    authOk(FakeSocket.made[0]);
    FakeSocket.made[0].receive({ type: 'sync_state', collection: 'notes', records: [before] });
    earlier.disconnect();

    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'] });
    sync.connect();
    const socket = FakeSocket.made[1];
    try {
      xdb.updateInCollection('notes', 'n1', { title: 'new' });
      socket.open();
      authOk(socket);
      socket.receive({ type: 'sync_state', collection: 'notes', records: [before] });
      expect(xdb.get('notes', 'n1')?.data).toEqual({ title: 'new', body: 'b' });
      expect(pushedOps(socket).map((op) => op.data)).toEqual([{ title: 'new', body: 'b' }]);
    } finally {
      sync.disconnect();
    }
  });

  it('gives way to what the server sends once it has answered the edit', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'] });
    sync.connect();
    const socket = FakeSocket.made[0];
    try {
      socket.open();
      authOk(socket);
      socket.receive({ type: 'sync_state', collection: 'notes', records: [before] });
      xdb.updateInCollection('notes', 'n1', { title: 'mine' });
      const [edit] = pushedOps(socket);
      // Overtaken by a newer edit: acknowledged, and answered with the record
      // as it stands, under the edit's own id.
      socket.receive({ type: 'sync_ack', opIds: [edit.id] });
      socket.receive({
        type: 'sync_delta',
        ops: [{ id: edit.id, collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'theirs', body: 'b' }, timestamp: stamp, clientId: 'server' }],
      });
      expect(xdb.get('notes', 'n1')?.data).toEqual({ title: 'theirs', body: 'b' });
      // And another device's edit after that is shown as it comes.
      socket.receive({
        type: 'sync_delta',
        ops: [{ id: 'op_9_1', collection: 'notes', operation: 'update', recordId: 'n1', data: { title: 'later', body: 'b' }, timestamp: stamp, clientId: 'c9' }],
      });
      expect(xdb.get('notes', 'n1')?.data).toEqual({ title: 'later', body: 'b' });
    } finally {
      sync.disconnect();
    }
  });
});

/**
 * A record removed for good here: `hardDelete`, and `db.prune` and
 * `db.clearCollection`, which remove records with it. It told the page and
 * nobody else, so the server kept the record and the next pull brought it
 * back.
 */
describe('a record removed for good here', () => {
  const stamp = '2026-01-02T00:00:00Z';
  const row = (id: string) => ({ id, collection: 'notes', data: { title: id }, createdAt: stamp, updatedAt: stamp });

  it('is deleted on the server, and a pull answered before that does not bring it back', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'], reconnectDelay: 10 });
    sync.connect();
    const first = FakeSocket.made[0];
    try {
      first.open();
      authOk(first);
      first.receive({ type: 'sync_state', collection: 'notes', records: [row('a'), row('b')] });
      const made = xdb.create('notes', { title: 'c' });
      xdb.hardDelete('notes', made.id);
      xdb.hardDelete('notes', 'a');
      // The delete of the record just made waits for its create to be answered.
      first.receive({ type: 'sync_ack', opIds: [pushedOps(first)[0].id] });
      expect(pushedOps(first).map((op) => [op.operation, op.recordId])).toEqual([
        ['create', made.id],
        ['delete', 'a'],
        ['delete', made.id],
      ]);
      // Not yet answered: a pull still has it, and it stays gone.
      first.receive({ type: 'sync_state', collection: 'notes', records: [row('a'), row('b')] });
      expect(xdb.query('notes').map((r) => r.id)).toEqual(['b']);

      // Removed while offline: the pull of the reconnect is answered first.
      first.drop();
      xdb.hardDelete('notes', 'b');
      vi.advanceTimersByTime(20);
      const second = FakeSocket.made[1];
      second.open();
      authOk(second);
      second.receive({ type: 'sync_state', collection: 'notes', records: [row('b')] });
      expect(xdb.query('notes')).toEqual([]);
      expect(pushedOps(second).filter((op) => op.recordId === 'b').map((op) => op.operation)).toEqual(['delete']);
    } finally {
      sync.disconnect();
    }
  });

  it('by prune or clearCollection is deleted on the server', async () => {
    const scope = createEphemeralXDBScope();
    const sync = new XDBServerSync(scope.xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['log'] });
    sync.connect();
    const socket = FakeSocket.made[0];
    try {
      socket.open();
      authOk(socket);
      socket.receive({
        type: 'sync_state',
        collection: 'log',
        records: ['x', 'y', 'z'].map((id, i) => ({ id, collection: 'log', data: {}, createdAt: `2026-01-0${i + 1}T00:00:00Z`, updatedAt: stamp })),
      });
      const db = createDBNamespace(undefined, scope.appId);
      await db.ready();
      expect(db.prune('log', 1)).toBe(2);
      db.clearCollection('log');
      expect(pushedOps(socket).map((op) => [op.operation, op.recordId])).toEqual([
        ['delete', 'x'],
        ['delete', 'y'],
        ['delete', 'z'],
      ]);
    } finally {
      sync.disconnect();
      scope.dispose();
    }
  });
});

/**
 * A record from the server that could not be written here. The store was
 * told the writes it was making were the server's, so as not to push them
 * back, and was never told they had stopped: from then on every edit made
 * here was taken for the server's and never pushed.
 */
describe('a server write that fails', () => {
  it('leaves the edits made here after it to be pushed', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    const op = { collection: 'notes', recordId: 'r9', data: { text: 'theirs' }, timestamp: '2026-01-02T00:00:00Z', clientId: 'c9' };
    try {
      socket.open();
      authOk(socket);
      vi.spyOn(xdb, 'writeRecord').mockImplementationOnce(() => {
        throw new Error('quota exceeded');
      });
      socket.receive({ type: 'sync_delta', ops: [{ ...op, id: 'd1', operation: 'create' }] });
      xdb.create('notes', { text: 'after a failed write' });
      expect(pushedOps(socket).map((o) => o.data?.text)).toEqual(['after a failed write']);

      vi.spyOn(xdb, 'removeRecord').mockImplementationOnce(() => {
        throw new Error('quota exceeded');
      });
      socket.receive({ type: 'sync_delta', ops: [{ ...op, id: 'd2', operation: 'delete' }] });
      xdb.create('notes', { text: 'after a failed delete' });
      expect(pushedOps(socket).map((o) => o.data?.text)).toEqual(['after a failed write', 'after a failed delete']);
    } finally {
      sync.disconnect();
    }
  });
});

const WS_URL = 'wss://sync.example.test/sync';

/** A store on `storage` with its sync connected and authenticated. */
function visit(storage: ReturnType<typeof createTestStorage>, prefix = 'xdb:app', url = WS_URL) {
  const store = new XDBService(storage, prefix, undefined, { backend: 'storage' });
  const sync = new XDBServerSync(store, { wsUrl: url, appVersion: '1', collections: ['notes'], reconnectDelay: 10 });
  sync.connect();
  const socket = FakeSocket.made[FakeSocket.made.length - 1];
  socket.open();
  authOk(socket);
  return { store, sync, socket };
}

/**
 * Changes made offline, with the app then closed before it reconnected.
 *
 * The changes the server had not answered were held in memory alone, so
 * closing the app lost them. The host never heard of them, and the first
 * pull of the next visit wrote the host's copy over the edit and brought the
 * deleted record back, and a record created offline stayed on this device
 * alone. The queue is kept in the store's own storage, under the app's own
 * prefix, and the next sync of that store takes it up.
 */
describe('changes made offline, and the app closed before it reconnected', () => {
  const stamp = '2026-01-02T00:00:00Z';
  const row = { id: 'n1', collection: 'notes', data: { title: 'v1' }, createdAt: stamp, updatedAt: stamp };
  const shown = (store: XDBService) => store.query('notes').map((r) => `${r.id}:${r.data.title}`);
  const cases: Array<[string, (store: XDBService) => unknown, string[], string[][]]> = [
    ['an edit', (store) => store.updateInCollection('notes', 'n1', { title: 'v2' }), ['n1:v2'], [['update', 'n1']]],
    ['a delete', (store) => store.deleteFromCollection('notes', 'n1'), [], [['delete', 'n1']]],
    ['a removal for good', (store) => store.hardDelete('notes', 'n1'), [], [['delete', 'n1']]],
    ['a new record', (store) => store.create('notes', { title: 'new' }, { id: 'n2' }), ['n1:v1', 'n2:new'], [['create', 'n2']]],
  ];

  for (const [what, change, expected, sent] of cases) {
    it(`${what} reaches the server on the next visit, and its pull does not undo it`, () => {
      const storage = createTestStorage();
      const first = visit(storage);
      first.socket.receive({ type: 'sync_state', collection: 'notes', records: [row] });
      first.socket.drop();
      change(first.store);
      // The page closes.
      first.sync.disconnect();
      first.store.destroy();

      const second = visit(storage);
      // The host still has the record as it was.
      second.socket.receive({ type: 'sync_state', collection: 'notes', records: [row] });
      try {
        expect(shown(second.store)).toEqual(expected);
        expect(pushedOps(second.socket).map((op) => [op.operation, op.recordId])).toEqual(sent);
      } finally {
        second.sync.disconnect();
      }
    });
  }

  it('is sent until answered and not after, and belongs to its own app', () => {
    // Time moves on between the visits, as it does between page loads.
    vi.useFakeTimers({ now: new Date('2026-02-01T00:00:00Z') });
    const storage = createTestStorage();
    const first = visit(storage);
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    first.socket.drop();
    first.store.create('notes', { title: 'offline' }, { id: 'n2' });
    first.sync.disconnect();

    // Another app on the same storage has a queue of its own, and this is not in it.
    const other = visit(storage, 'xdb:other');
    other.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    expect(pushedOps(other.socket)).toEqual([]);
    other.sync.disconnect();

    const second = visit(storage);
    second.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const [op] = pushedOps(second.socket);
    expect([op.operation, op.recordId]).toEqual(['create', 'n2']);
    second.socket.receive({ type: 'sync_ack', opIds: [op.id] });
    vi.advanceTimersByTime(5);
    second.sync.disconnect();

    const third = visit(storage);
    third.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    expect(pushedOps(third.socket)).toEqual([]);
    third.sync.disconnect();
  });
});

/**
 * A change to a record whose earlier change the host has not answered.
 *
 * Every op went out as soon as it was made. The host answers each op of a
 * push on its own, and may ask for one to be sent again (`sync_retry`, or a
 * push it could not take at all: "Server busy"). A create it asked for again,
 * with an update of the same record already on its way, left the update
 * refused ("not found") and dropped, and the record stored as first created;
 * a delete was undone the same way. A record has one op in flight now, and
 * the next goes once that one is answered.
 */
describe('a change to a record whose earlier change is unanswered', () => {
  for (const answer of ['sync_retry', 'error'] as const) {
    it(`goes once the earlier one is stored, when the host asks for that again (${answer})`, () => {
      vi.useFakeTimers();
      const sync = new XDBServerSync(xdb, { wsUrl: WS_URL, appVersion: '1', reconnectDelay: 10 });
      sync.connect();
      const socket = FakeSocket.made[0];
      try {
        socket.open();
        authOk(socket);
        xdb.create('notes', { title: 'draft' }, { id: 'n1' });
        xdb.update('n1', { title: 'final' });
        const [create] = pushedOps(socket);
        expect(pushedOps(socket).map((op) => op.operation)).toEqual(['create']);
        socket.receive(
          answer === 'sync_retry'
            ? { type: 'sync_retry', opIds: [create.id], reason: 'Database transaction failed — retry later' }
            : { type: 'error', message: 'Server busy' }
        );
        vi.advanceTimersByTime(100);
        expect(pushedOps(socket).map((op) => [op.operation, op.data?.title])).toEqual([
          ['create', 'draft'],
          ['create', 'draft'],
        ]);
        socket.receive({ type: 'sync_ack', opIds: [create.id] });
        expect(pushedOps(socket).map((op) => [op.operation, op.data?.title]).at(-1)).toEqual(['update', 'final']);
      } finally {
        sync.disconnect();
      }
    });
  }

  it('goes as the newest of the changes made while it waited, one op for them all', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: WS_URL, appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    try {
      socket.open();
      authOk(socket);
      xdb.create('notes', { title: 'a' }, { id: 'n1' });
      xdb.update('n1', { title: 'b' });
      xdb.update('n1', { title: 'c' });
      xdb.create('notes', { title: 'other' }, { id: 'n2' });
      // Another record is not held back by this one.
      expect(pushedOps(socket).map((op) => [op.operation, op.recordId])).toEqual([['create', 'n1'], ['create', 'n2']]);
      socket.receive({ type: 'sync_ack', opIds: [pushedOps(socket)[0].id] });
      expect(pushedOps(socket).slice(2).map((op) => [op.operation, op.data?.title])).toEqual([['update', 'c']]);
    } finally {
      sync.disconnect();
    }
  });
});

/**
 * A record deleted on another device while this one was away.
 *
 * A pull asked for whole collections, and a whole pull lists live records
 * only: a record deleted while this device was offline was in no pull and in
 * no delta it heard, and stayed here for good. The host answers a pull that
 * names a point (`lastSync` and `lastId`: the receipt time and id of the
 * newest record received) with what it received after it, deleted records
 * included. The point is kept per collection and per host, and a host that
 * does not read it answers with the whole collection, as before.
 */
describe('a pull from where the last one ended', () => {
  const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
  const row = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
    id, collection: 'notes', data: { title: id }, createdAt: at(1), updatedAt: at(n), serverReceivedAt: at(n), ...extra,
  });
  const ids = (store: XDBService) => store.query('notes').map((r) => r.id);
  // A pull asks from the millisecond before its place (see the last test here).
  const before = (iso: string) => new Date(Date.parse(iso) - 1).toISOString();

  it('removes a record deleted on the host while this device was away', () => {
    const storage = createTestStorage();
    const first = visit(storage);
    expect(first.socket.ofType('sync_pull')).toEqual([{ type: 'sync_pull', collections: ['notes'] }]);
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a', 1), row('b', 2)] });
    first.socket.drop();
    first.sync.disconnect();

    const second = visit(storage);
    try {
      expect(second.socket.ofType('sync_pull')).toEqual([
        { type: 'sync_pull', collections: ['notes'], lastSync: before(at(2)), lastId: '' },
      ]);
      second.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a', 3, { deleted: true }), row('c', 4)] });
      expect(ids(second.store)).toEqual(['b', 'c']);
    } finally {
      second.sync.disconnect();
    }
  });

  /** A store on `storage` connected to a host whose clock (`auth_ok`) reads `serverTime`. */
  const open = (storage: ReturnType<typeof createTestStorage>, serverTime: string) => {
    const store = new XDBService(storage, 'xdb:app', undefined, { backend: 'storage' });
    const sync = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'] });
    sync.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime });
    return { store, sync, socket };
  };
  const delta = (recordId: string, n: number) => ({
    type: 'sync_delta',
    ops: [{ id: `op_${n}_1`, collection: 'notes', operation: 'create', recordId, data: { title: 'theirs' }, timestamp: at(n), clientId: 'c9' }],
  });

  it('starts from the host\'s clock when the collection was empty, so a record that came by a delta can go too', () => {
    const storage = createTestStorage();
    const first = open(storage, '2026-01-05T00:00:00.000Z');
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    first.socket.receive(delta('n1', 6));
    expect(ids(first.store)).toEqual(['n1']);
    first.sync.disconnect();

    const second = open(storage, '2026-01-08T00:00:00.000Z');
    try {
      expect(second.socket.ofType('sync_pull')).toEqual([
        { type: 'sync_pull', collections: ['notes'], lastSync: '2026-01-04T23:59:59.999Z', lastId: '' },
      ]);
      second.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 7, { deleted: true })] });
      expect(ids(second.store)).toEqual([]);
    } finally {
      second.sync.disconnect();
    }
  });

  it('places a whole pull no later than the first connection that asked for one, so a record from before it was answered can go too', () => {
    const storage = createTestStorage();
    // A record comes by a delta before the pull is answered, and the connection drops.
    const first = open(storage, '2026-01-05T00:00:00.000Z');
    first.socket.receive(delta('n1', 5));
    first.socket.drop();
    first.sync.disconnect();

    // n1 was deleted meanwhile; the whole pull lists live records alone, one
    // of them received after the deletion, and cannot say n1 went. What
    // changed since the first connection is asked for with it.
    const second = open(storage, '2026-01-08T00:00:00.000Z');
    expect(second.socket.ofType('sync_pull')).toEqual([
      { type: 'sync_pull', collections: ['notes'] },
      { type: 'sync_pull', collections: ['notes'], lastSync: '2026-01-04T23:59:59.999Z', lastId: '' },
    ]);
    second.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n2', 7)] });
    expect(ids(second.store)).toEqual(['n1', 'n2']);
    // The connection drops before the second answer.
    second.sync.disconnect();

    const third = open(storage, '2026-01-09T00:00:00.000Z');
    try {
      expect(third.socket.ofType('sync_pull')).toEqual([
        { type: 'sync_pull', collections: ['notes'], lastSync: '2026-01-04T23:59:59.999Z', lastId: '' },
      ]);
      third.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('n1', 6, { deleted: true }), row('n2', 7)] });
      expect(ids(third.store)).toEqual(['n2']);
    } finally {
      third.sync.disconnect();
    }
  });

  it('starts over with another host, and works with one that answers it as a whole pull', () => {
    const storage = createTestStorage();
    const first = visit(storage);
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a', 1), row('b', 2)] });
    first.sync.disconnect();

    const elsewhere = visit(storage, 'xdb:app', 'wss://other.example.test/sync');
    expect(elsewhere.socket.ofType('sync_pull')).toEqual([{ type: 'sync_pull', collections: ['notes'] }]);
    elsewhere.sync.disconnect();

    // A host that does not read the point sends every live record, and no
    // deletions: everything is written, nothing is removed.
    const second = visit(storage);
    try {
      expect(second.socket.ofType('sync_pull')[0]).toMatchObject({ lastSync: before(at(2)), lastId: '' });
      second.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a', 1), { ...row('b', 2), data: { title: 'b2' } }] });
      expect(second.store.query('notes').map((r) => [r.id, r.data.title])).toEqual([['a', 'a'], ['b', 'b2']]);
    } finally {
      second.sync.disconnect();
    }
  });

  it('does not go past a record that could not be saved here, so the next pull brings it again', () => {
    const storage = createTestStorage();
    const setItem = storage.setItem;
    storage.setItem = (key: string, value: string) => {
      if (value.includes('"too big"')) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      return setItem(key, value);
    };
    const first = visit(storage);
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a', 1), { ...row('b', 2), data: { title: 'too big' } }, row('c', 3)] });
    expect(ids(first.store)).toEqual(['a', 'c']);
    first.sync.disconnect();

    const second = visit(storage);
    try {
      expect(second.socket.ofType('sync_pull')).toEqual([
        { type: 'sync_pull', collections: ['notes'], lastSync: before(at(1)), lastId: '' },
      ]);
    } finally {
      second.sync.disconnect();
    }
  });

  /**
   * The host marks when it received a record to the millisecond, and orders
   * records of one millisecond by id. One it received later in the same
   * millisecond as the last record a pull read, with an id that sorts before
   * that one's, is behind the place: asked for from the place itself, it came
   * in no pull. A connection asks from the millisecond before.
   */
  it('asks again for the millisecond its place is in, where the host may have received more since', () => {
    const storage = createTestStorage();
    const first = visit(storage);
    first.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('r9', 2)] });
    first.sync.disconnect();

    // r10 was received in that millisecond after the pull was read; it sorts before r9.
    const second = visit(storage);
    try {
      expect(second.socket.ofType('sync_pull')).toEqual([
        { type: 'sync_pull', collections: ['notes'], lastSync: before(at(2)), lastId: '' },
      ]);
      second.socket.receive({ type: 'sync_state', collection: 'notes', records: [row('r10', 2), row('r9', 2)] });
      expect(ids(second.store).sort()).toEqual(['r10', 'r9']);
    } finally {
      second.sync.disconnect();
    }
  });
});

/**
 * `clear(collection)` on a synced device. It told the page and nobody else:
 * the server kept every record, and the next pull brought them all back.
 */
describe('a collection cleared here', () => {
  it('is deleted on the server record by record, and a pull answered before that does not bring it back', () => {
    const stamp = '2026-01-02T00:00:00Z';
    const row = (id: string) => ({ id, collection: 'notes', data: { title: id }, createdAt: stamp, updatedAt: stamp });
    const { store, sync, socket } = visit(createTestStorage());
    try {
      socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a'), row('b')] });
      store.clear('notes');
      expect(pushedOps(socket).map((op) => [op.operation, op.recordId])).toEqual([['delete', 'a'], ['delete', 'b']]);
      socket.receive({ type: 'sync_state', collection: 'notes', records: [row('a'), row('b')] });
      expect(store.query('notes')).toEqual([]);
    } finally {
      sync.disconnect();
    }
  });
});

/**
 * A store opened again, with records, and a sync told no collections. The
 * pull named the collections the page had touched since it opened, which on
 * a fresh page was none: nothing the store held was ever pulled.
 */
describe('a sync that names no collections', () => {
  it('pulls the collections the store holds: only names the host takes, and at most a hundred a pull', () => {
    const storage = createTestStorage();
    const before = new XDBService(storage, 'xdb:app', undefined, { backend: 'storage' });
    const names = ['notes', ...Array.from({ length: 120 }, (_, i) => `c${i}`)];
    for (const name of names) before.create(name, { n: 1 });
    // The host takes [A-Za-z0-9_-] alone, and answers a pull naming another with an error.
    before.create('with space', { n: 1 });

    const store = new XDBService(storage, 'xdb:app', undefined, { backend: 'storage' });
    const sync = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    try {
      socket.open();
      authOk(socket);
      const pulls = socket.ofType('sync_pull') as Array<{ collections: string[] }>;
      expect(pulls.flatMap((pull) => pull.collections).sort()).toEqual([...names].sort());
      expect(pulls.every((pull) => pull.collections.length <= 100)).toBe(true);
    } finally {
      sync.disconnect();
    }
  });
});

/**
 * A record from a pull that cannot be saved here (a nearly full store).
 *
 * It threw out of the pull: the records after it were never written, and
 * the first pull never counted as done, so nothing made on this device was
 * pushed from then on. It is passed over, and the pull goes on.
 */
describe('a pulled record that cannot be saved here', () => {
  it('leaves the rest of the pull written, and the changes made here pushed', () => {
    const storage = createTestStorage();
    const setItem = storage.setItem;
    storage.setItem = (key: string, value: string) => {
      if (value.length > 2000) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      return setItem(key, value);
    };
    const store = new XDBService(storage, 'xdb:app', undefined, { backend: 'storage' });
    const sync = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'] });
    sync.connect();
    const socket = FakeSocket.made[0];
    const stamp = '2026-01-02T00:00:00Z';
    const row = (id: string, data: Record<string, unknown>) => ({ id, collection: 'notes', data, createdAt: stamp, updatedAt: stamp });
    try {
      // Made before the socket is up: it waits for the first pull.
      store.create('tasks', { mine: true }, { id: 't1' });
      socket.open();
      authOk(socket);
      socket.receive({ type: 'sync_state', collection: 'notes', records: [row('big', { body: 'x'.repeat(3000) }), row('small', { n: 1 })] });
      expect(store.query('notes').map((r) => r.id)).toEqual(['small']);
      expect(pushedOps(socket).map((op) => [op.operation, op.recordId])).toEqual([['create', 't1']]);
    } finally {
      sync.disconnect();
    }
  });
});

/**
 * A change too large for any message the host takes: it closes the socket
 * on a message over 4 MiB, counted in UTF-8 bytes, where the client counted
 * characters. The change was sent alone, the socket closed, the change went
 * first again on the next connection, and nothing queued behind it reached
 * the host. It is reported as refused, and the rest go.
 */
describe('a change larger than the host takes in one message', () => {
  it('is refused and reported, and the changes after it are pushed', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: WS_URL, appVersion: '1' });
    const refused: string[] = [];
    sync.on('reject', (opId) => refused.push(String(opId)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sync.connect();
    const socket = FakeSocket.made[0];
    try {
      socket.open();
      authOk(socket);
      // 1.5 million characters, 4.5 MB as UTF-8.
      xdb.create('notes', { blob: '日'.repeat(1_500_000) }, { id: 'huge' });
      xdb.create('notes', { title: 'small' }, { id: 'n2' });
      expect(pushedOps(socket).map((op) => op.recordId)).toEqual(['n2']);
      expect(refused).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      sync.disconnect();
    }
  });

  it('packs a queue of such text into pushes by its UTF-8 size', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: WS_URL, appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    try {
      // 90 KB each as UTF-8, a third of that in characters; queued offline.
      for (let i = 0; i < 40; i++) xdb.create('notes', { body: '日'.repeat(30_000) });
      socket.open();
      authOk(socket);
      socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
      const pushes = socket.ofType('sync_push');
      expect(pushedOps(socket)).toHaveLength(40);
      for (const push of pushes) expect(new TextEncoder().encode(JSON.stringify(push)).length).toBeLessThanOrEqual(1024 * 1024);
    } finally {
      sync.disconnect();
    }
  });
});

describe('XDBServerSync with a token', () => {
  function ticketFetch(answer: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer();
    });
    vi.stubGlobal('fetch', fetchStub);
    return calls;
  }

  it('trades the token for a ticket and never puts the token on the socket', async () => {
    const calls = ticketFetch(
      () => new Response(JSON.stringify({ ticket: 'tkt-1' }), { status: 200 })
    );
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'long-lived-secret',
    });
    sync.connect();
    // The socket waits for the ticket: the host authenticates the handshake,
    // and a bare upgrade is refused before any message could carry a token.
    expect(FakeSocket.made).toHaveLength(0);
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sync.example.test/sync/ticket');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer long-lived-secret'
    );

    const socket = FakeSocket.made[0];
    const url = new URL(socket.url);
    expect(url.searchParams.get('ticket')).toBe('tkt-1');
    expect(socket.url).not.toContain('long-lived-secret');

    socket.open();
    authOk(socket);
    xdb.create('notes', { text: 'hello' });
    expect(sync.status.connected).toBe(true);
    expect(JSON.stringify(socket.sent)).not.toContain('long-lived-secret');
    sync.disconnect();
  });

  it('reports a refused token once and does not hammer the host', async () => {
    vi.useFakeTimers();
    const calls = ticketFetch(() => new Response('Authentication failed', { status: 401 }));
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'wrong',
      reconnectDelay: 10,
    });
    const errors: string[] = [];
    sync.on('error', (err) => errors.push(String(err)));
    sync.connect();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatch(/401/);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(FakeSocket.made).toHaveLength(0);
    sync.disconnect();
  });

  it('retries a ticket request that failed in transit', async () => {
    vi.useFakeTimers();
    let fail = true;
    const calls = ticketFetch(() => {
      if (fail) throw new TypeError('network down');
      return new Response(JSON.stringify({ ticket: 'tkt-2' }), { status: 200 });
    });
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'secret',
      reconnectDelay: 10,
    });
    sync.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(2);
    expect(FakeSocket.made).toHaveLength(1);
    expect(new URL(FakeSocket.made[0].url).searchParams.get('ticket')).toBe('tkt-2');
    sync.disconnect();
  });

  it('waits as long as a throttled host asks before asking again', async () => {
    vi.useFakeTimers();
    let throttled = true;
    const calls = ticketFetch(() =>
      throttled
        ? new Response(JSON.stringify({ error: 'Too many ticket requests' }), {
            status: 429,
            headers: { 'Retry-After': '30' },
          })
        : new Response(JSON.stringify({ ticket: 'tkt-3' }), { status: 200 })
    );
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'secret',
      reconnectDelay: 10,
    });
    sync.connect();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toHaveLength(1);
    throttled = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toHaveLength(2);
    expect(FakeSocket.made).toHaveLength(1);
    sync.disconnect();
  });

  it('backs off between failed attempts instead of retrying at a fixed pace', async () => {
    vi.useFakeTimers();
    const calls = ticketFetch(() => {
      throw new TypeError('network down');
    });
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'secret',
      reconnectDelay: 1_000,
    });
    sync.connect();
    // A fixed 1 s delay would have asked 60 times in this minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.length).toBeLessThanOrEqual(7);
    sync.disconnect();
  });

  it('opens nothing when disconnected while the ticket is on its way', async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve)))
    );
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 't',
    });
    sync.connect();
    sync.disconnect();
    release(new Response(JSON.stringify({ ticket: 'late' }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeSocket.made).toHaveLength(0);
  });

  it('spreads the backoff between half and all of a doubling ceiling', () => {
    expect(backoffDelay(1000, 0, () => 0)).toBe(500);
    expect(backoffDelay(1000, 0, () => 1)).toBe(1000);
    expect(backoffDelay(1000, 3, () => 1)).toBe(8000);
    expect(backoffDelay(1000, 50, () => 1)).toBe(60_000);
  });

  it('derives the ticket address from the sync address', () => {
    expect(syncTicketUrl('wss://h.example/sync')).toBe('https://h.example/sync/ticket');
    expect(syncTicketUrl('ws://localhost:3000/tenant-a/sync/?x=1')).toBe(
      'http://localhost:3000/tenant-a/sync/ticket'
    );
  });
});
