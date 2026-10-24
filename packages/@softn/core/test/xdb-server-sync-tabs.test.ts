/**
 * Two tabs of one app, each with its own server sync client, over one store.
 *
 * The queue of changes not yet sent is saved under the app's name, and each
 * client wrote its own queue over the other's: a change one tab made offline
 * was gone from it once the other tab saved (with nothing left to send, it
 * saved none), and the next visit never sent it. Nor did its scan find it:
 * that looks for changes made since the store's mark of where listening
 * stopped, which the other tab had moved past the change with its saves. A
 * change a tab made before its client listened (while the person was asked to
 * allow sync) was missed the same way.
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

/** A tab of the app: its own store over the one storage, as a page has. */
const tab = (backing: ReturnType<typeof storage>) => new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' });

/** A client started, its socket made and not answered: offline. */
function offline(store: XDBService) {
  const sync = new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
  sync.connect();
  return { sync, socket: FakeSocket.made[FakeSocket.made.length - 1] };
}

/** A client started and connected, the host holding nothing yet. */
function online(store: XDBService) {
  const client = offline(store);
  client.socket.open();
  client.socket.receive({ type: 'auth_ok', clientId: `c${FakeSocket.made.length}`, serverTime: new Date().toISOString() });
  client.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
  return client;
}

const pushed = (socket: FakeSocket) =>
  socket.sent.filter((m) => m.type === 'sync_push').flatMap((m) => m.ops as Array<{ id: string; operation: string; data?: { title?: string } }>);
const titles = (socket: FakeSocket) => pushed(socket).map((op) => op.data?.title).sort();
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

describe('two tabs, both offline', () => {
  it('keeps the changes of both for the next visit, which sends them all', async () => {
    const backing = storage();
    const a = tab(backing);
    const b = tab(backing);
    offline(a);
    offline(b);
    a.create('notes', { title: 'from A' });
    await tick();
    vi.advanceTimersByTime(1000);
    b.create('notes', { title: 'from B' });
    await tick();
    vi.advanceTimersByTime(1000);

    // Both tabs closed. The next visit:
    const next = online(tab(backing));
    await tick();
    expect(titles(next.socket)).toEqual(['from A', 'from B']);
  });
});

describe('one tab offline, the other online', () => {
  it("clears from the saved queue only what the online tab's host answered", async () => {
    const backing = storage();
    const a = tab(backing);
    const b = tab(backing);
    const live = online(b);
    offline(a);
    a.create('notes', { title: 'from A' });
    await tick();
    vi.advanceTimersByTime(1000);
    b.create('notes', { title: 'from B' });
    await tick();
    const [sent] = pushed(live.socket);
    expect(pushed(live.socket)).toHaveLength(1);
    expect(sent.data?.title).toBe('from B');
    vi.advanceTimersByTime(1000);
    live.socket.receive({ type: 'sync_ack', opIds: [sent.id] });
    await tick();
    vi.advanceTimersByTime(1000);

    const next = online(tab(backing));
    await tick();
    // A's change is still to go; B's is answered, and is not sent again.
    expect(titles(next.socket)).toEqual(['from A']);
  });
});

describe("one tab's edit of a record another tab created, both offline", () => {
  // Saving put the other tab's ops ahead of its own: tab A's later save sent B's edit of the
  // record before A's create of it, and the host refused the edit (the record was not there).
  it('goes after the create at the next visit', async () => {
    const backing = storage();
    const a = tab(backing);
    const b = tab(backing);
    offline(a);
    offline(b);
    const r1 = a.create('notes', { title: 'made in A' });
    await tick();
    vi.advanceTimersByTime(1000);
    b.update(r1.id, { title: 'edited in B' });
    await tick();
    vi.advanceTimersByTime(1000);
    a.create('notes', { title: 'more in A' });
    await tick();

    const next = online(tab(backing));
    await tick();
    const first = pushed(next.socket).find((op) => (op as { recordId?: string }).recordId === r1.id);
    expect(first?.operation).toBe('create');
  });
});

describe("one tab's edit of a record the other tab's create was sent for, unanswered", () => {
  // The sent create was ordered by its stamp, in the host's time: with the host a minute ahead,
  // it looked later than the edit made ten seconds after it, which went first and was refused.
  it('goes after the create at the next visit, whatever the host clock', async () => {
    const backing = storage();
    const a = tab(backing);
    const b = tab(backing);
    offline(b);
    const sending = offline(a);
    sending.socket.open();
    sending.socket.receive({ type: 'auth_ok', clientId: 'ca', serverTime: new Date(Date.now() + 60_000).toISOString() });
    sending.socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const r1 = a.create('notes', { title: 'made in A' });
    await tick();
    expect(pushed(sending.socket)).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    b.update(r1.id, { title: 'edited in B' });
    await tick();

    const next = online(tab(backing));
    await tick();
    const first = pushed(next.socket).find((op) => (op as { recordId?: string }).recordId === r1.id);
    expect(first?.operation).toBe('create');
  });
});

describe("one tab's edit of a record the other tab made, both online, the edit reaching the host first", () => {
  type Op = { id: string; operation: string; recordId: string; collection: string; timestamp: string; data?: { title?: string } };
  const opsOf = (socket: FakeSocket) => pushed(socket) as unknown as Op[];

  /** Tab A's create of r1, unanswered, and tab B's edit of r1 sent after it. */
  async function editOfAnotherTabsRecord() {
    const backing = storage();
    const a = tab(backing);
    const b = tab(backing);
    const sa = online(a);
    const sb = online(b);
    const r1 = a.create('notes', { title: 'made in A' });
    await tick();
    const [create] = opsOf(sa.socket);
    vi.advanceTimersByTime(1000);
    b.update(r1.id, { title: 'edited in B' });
    await tick();
    const [edit] = opsOf(sb.socket);
    expect(edit.operation).toBe('update');
    const refused: string[] = [];
    sb.sync.on('reject', (...args: unknown[]) => refused.push(String(args[0])));
    return { b, sa, sb, r1, create, edit, refused };
  }

  // The host refused the edit (no such record yet), and the create, landing after it, wrote the
  // record as first made over the edit, here and on every device.
  it("sends the other tab's create itself, then the edit, and the record keeps the edit", async () => {
    const { b, sa, sb, r1, create, edit, refused } = await editOfAnotherTabsRecord();
    // The host reads B's push first.
    sb.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${r1.id}` });
    await tick();
    expect(opsOf(sb.socket).map((op) => [op.operation, op.id])).toEqual([['update', edit.id], ['create', create.id]]);
    // The host takes the create from B, and the edit after it.
    sb.socket.receive({ type: 'sync_ack', opIds: [create.id] });
    expect(opsOf(sb.socket).slice(2).map((op) => [op.operation, op.id, op.data?.title])).toEqual([['update', edit.id, 'edited in B']]);
    sb.socket.receive({ type: 'sync_ack', opIds: [edit.id] });
    // A's own create comes the better part of a minute later (its socket backed off): the
    // host has the record, and answers it as one it has had.
    vi.advanceTimersByTime(45_000);
    sa.socket.receive({ type: 'sync_ack', opIds: [create.id] });
    await tick();
    expect(b.get('notes', r1.id)?.data.title).toBe('edited in B');
    expect(refused).toEqual([]);
  });

  it('keeps the edit when the create reaches it from the host while the edit waits behind it', async () => {
    const { b, sb, r1, create, edit } = await editOfAnotherTabsRecord();
    sb.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${r1.id}` });
    await tick();
    // A's create landed first after all, and its delta reaches B.
    sb.socket.receive({ type: 'sync_delta', ops: [{ ...create, clientId: 'ca' }] });
    expect(b.get('notes', r1.id)?.data.title).toBe('edited in B');
  });

  // The other tab's create landed, and its delta reached B, before the refusal of the edit B sent
  // first: A had saved its queue without the create, and the refusal was final.
  it('sends the edit again, once, when the host named the record after the edit went', async () => {
    const { b, sa, sb, r1, create, edit, refused } = await editOfAnotherTabsRecord();
    sa.socket.receive({ type: 'sync_ack', opIds: [create.id] });
    await tick();
    sb.socket.receive({ type: 'sync_delta', ops: [{ ...create, clientId: 'ca' }] });
    sb.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${r1.id}` });
    await tick();
    expect(opsOf(sb.socket).map((op) => [op.operation, op.id])).toEqual([['update', edit.id], ['update', edit.id]]);
    expect(refused).toEqual([]);
    expect(b.get('notes', r1.id)?.data.title).toBe('edited in B');
    // Refused again: reported, and not sent a third time.
    sb.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${r1.id}` });
    expect(refused).toEqual([edit.id]);
    expect(opsOf(sb.socket)).toHaveLength(2);
  });

  it("reports both once when the host refuses the other tab's create, and sends neither again", async () => {
    const { sb, r1, create, edit, refused } = await editOfAnotherTabsRecord();
    sb.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${r1.id}` });
    await tick();
    sb.socket.receive({ type: 'sync_reject', opId: create.id, reason: 'Rejected by onBeforeSync' });
    expect(opsOf(sb.socket).map((op) => op.id)).toEqual([edit.id, create.id, edit.id]);
    sb.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${r1.id}` });
    await tick();
    expect(refused).toEqual([create.id, edit.id]);
    expect(opsOf(sb.socket)).toHaveLength(3);
  });

  it('is sent again once when no other tab holds a create of the record, then refused as before', async () => {
    const backing = storage();
    const b = tab(backing);
    const sb = online(b);
    const r1 = b.create('notes', { title: 'mine' });
    await tick();
    sb.socket.receive({ type: 'sync_ack', opIds: opsOf(sb.socket).map((op) => op.id) });
    b.update(r1.id, { title: 'edited' });
    await tick();
    const refused: string[] = [];
    sb.sync.on('reject', (...args: unknown[]) => refused.push(String(args[0])));
    const edit = opsOf(sb.socket).find((op) => op.operation === 'update')!;
    sb.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${r1.id}` });
    expect(refused).toEqual([]);
    expect(opsOf(sb.socket).filter((op) => op.id === edit.id)).toHaveLength(2);
    sb.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${r1.id}` });
    expect(refused).toEqual([edit.id]);
  });

  // The other tab's create landed and its queue was saved without it before this tab heard the
  // refusal of its edit, and its delta came after: nothing here said the host had the record.
  it('keeps the edit when the other tab saved its queue before the refusal, and the delta came after', async () => {
    const { b, sa, sb, r1, create, edit, refused } = await editOfAnotherTabsRecord();
    sa.socket.receive({ type: 'sync_ack', opIds: [create.id] });
    await tick();
    sb.socket.receive({ type: 'sync_reject', opId: edit.id, reason: `Record not found: ${r1.id}` });
    sb.socket.receive({ type: 'sync_delta', ops: [{ ...create, clientId: 'ca' }] });
    await tick();
    expect(opsOf(sb.socket).map((op) => [op.operation, op.id])).toEqual([['update', edit.id], ['update', edit.id]]);
    expect(b.get('notes', r1.id)?.data.title).toBe('edited in B');
    expect(refused).toEqual([]);
  });
});

describe('a change a tab made before its client listened', () => {
  it('is sent when the client starts, though another tab moved the mark on meanwhile', async () => {
    const backing = storage();
    const a = tab(backing);
    const b = tab(backing);
    const live = online(b);
    // A writes while its person is still asked whether to allow sync.
    a.create('notes', { title: 'before consent' });
    vi.advanceTimersByTime(1000);
    // B goes on: its saves move the store's mark past A's change.
    b.create('notes', { title: 'from B' });
    await tick();
    live.socket.receive({ type: 'sync_ack', opIds: pushed(live.socket).map((op) => op.id) });
    await tick();
    vi.advanceTimersByTime(1000);

    const started = online(a);
    await tick();
    expect(titles(started.socket)).toContain('before consent');
  });
});
