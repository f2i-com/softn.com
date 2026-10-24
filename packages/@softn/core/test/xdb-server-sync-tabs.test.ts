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
