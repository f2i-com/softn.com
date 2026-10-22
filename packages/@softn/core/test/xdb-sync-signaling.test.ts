/**
 * The signaling sockets behind peer-to-peer sync, with y-webrtc itself and a
 * stand-in WebSocket. y-webrtc shares one socket per signaling URL among the
 * rooms on it, and two of its habits left sockets open:
 *
 * - destroy() alone keeps the provider on its signaling connections, so a
 *   room's socket stayed open, reconnecting, for the life of the page;
 * - disconnect() keeps the provider's list of connections and connect()
 *   adds to it, so a room paused and resumed (its app hidden and shown)
 *   kept the closed socket beside the new one, and when it left it struck
 *   the URL from y-webrtc's table under the room still on the live socket:
 *   the next room opened a second socket to the same server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAppView, type AppView } from '../src/runtime/sync-activity';
import { startSync, stopAllSync } from '../src/runtime/xdb-sync';

class FakeSocket {
  static made: FakeSocket[] = [];
  closed = false;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
  }
}

const SIGNALING = 'wss://signaling.example.test';
const openSockets = () => FakeSocket.made.filter((socket) => !socket.closed).length;

const views: AppView[] = [];
const app = (appId: string, room: string): AppView => {
  const opened = openAppView(appId);
  views.push(opened);
  startSync({ room, appId, signaling: [SIGNALING], persist: false });
  return opened;
};

afterEach(() => {
  for (const opened of views.splice(0)) opened.close();
  stopAllSync();
  vi.unstubAllGlobals();
  FakeSocket.made = [];
});

describe('the signaling sockets of apps that sync', () => {
  it('are shared, let go when no room is on them, and not doubled by a room hidden and shown', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const first = app('signal-a', 'one');
    const second = app('signal-b', 'two');
    expect(openSockets()).toBe(1);

    first.setShown(false);
    expect(openSockets()).toBe(1);
    second.setShown(false);
    expect(openSockets()).toBe(0);

    first.setShown(true);
    second.setShown(true);
    expect(openSockets()).toBe(1);

    first.close();
    expect(openSockets()).toBe(1);
    app('signal-c', 'three');
    expect(openSockets()).toBe(1);

    for (const opened of views.splice(0)) opened.close();
    expect(openSockets()).toBe(0);
  });
});

describe('a room hidden and shown', () => {
  // Leaving a room clears this peer's awareness, and rejoining sends what is
  // left: nothing, so its peers no longer knew its name.
  it('keeps the name this peer goes by', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const opened = openAppView('named');
    views.push(opened);
    const adapter = startSync({ room: 'named', appId: 'named', signaling: [SIGNALING], persist: false, displayName: 'Ada' });
    const name = () => (adapter.getAwareness().get(adapter.doc.clientID) as { user?: { name?: string } } | undefined)?.user?.name;
    // y-webrtc opens the room a tick after the provider.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(name()).toBe('Ada');

    opened.setShown(false);
    opened.setShown(true);
    expect(name()).toBe('Ada');
  });
});
