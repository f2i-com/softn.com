/**
 * A room's document is held to a size.
 *
 * What reaches the store from a peer was bounded, but the document itself took every update a
 * peer sent, into maps the room does not carry and with values that are no record, and kept
 * it in the cache beside it. A peer of a shared room is anyone who knows its name: one that
 * kept sending grew the document until the page died, and the room an app goes back to after
 * a reload loaded the same cache and died again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    connected = false;
    awareness = { setLocalStateField() {}, setLocalState() {}, getLocalState: () => null, getStates: () => new Map() };
    connect() {}
    disconnect() {}
    destroy() {}
  },
}));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {} }));

import { XDBService } from '../src/runtime/xdb';
import { MAX_ROOM_DOC_BYTES, ROOM_MEASURE_EVERY_BYTES, XDBSyncAdapter, startSync, stopSync } from '../src/runtime/xdb-sync';
import { getSyncRoomKey } from '../src/runtime/xdb-sync-key';

function storage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

/** What a peer sends: `bytes` of text in a map the room does not carry. */
function fromAPeer(bytes: number, key = 'k'): Uint8Array {
  const remote = new Y.Doc();
  remote.getMap('_not-a-collection').set(key, 'x'.repeat(bytes));
  return Y.encodeStateAsUpdate(remote);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a room’s document', () => {
  it('is measured for what the room sends, not for this device’s own writes', () => {
    expect(ROOM_MEASURE_EVERY_BYTES).toBeLessThan(MAX_ROOM_DOC_BYTES);
    const xdb = new XDBService(storage(), 'own-writes', undefined, { backend: 'storage' });
    const adapter = new XDBSyncAdapter(xdb, { room: 'r', signaling: [], persist: false });
    const overgrown = vi.fn();
    adapter.onOvergrown = overgrown;
    const taken = (): number => (adapter as unknown as { takenSinceMeasured: number }).takenSinceMeasured;

    // This device's own write, larger than the room is measured by: not the room's doing.
    adapter.doc.transact(() => {
      adapter.doc.getMap('notes').set('n1', 'y'.repeat(ROOM_MEASURE_EVERY_BYTES + 1024));
    });
    expect(taken()).toBe(0);

    // A peer's are counted, and the document measured once enough has come in: under the bound, it is left alone.
    Y.applyUpdate(adapter.doc, fromAPeer(1024, 'small'), 'peer');
    expect(taken()).toBeGreaterThan(1024);
    Y.applyUpdate(adapter.doc, fromAPeer(ROOM_MEASURE_EVERY_BYTES + 1024, 'large'), 'peer');
    expect(taken()).toBe(0);
    expect(overgrown).not.toHaveBeenCalled();
    adapter.close();
  });

  it('that a peer grows past the bound has the room left, its cache deleted, and is not gone back to', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appId = 'room-size-app';
    const adapter = startSync({ room: 'lobby', appId, signaling: [], persist: false });
    const destroyed = vi.spyOn(adapter, 'destroy');
    expect(localStorage.getItem(getSyncRoomKey(appId))).toBe('lobby');

    // Anyone who knows the room's name sends more than a room holds, none of it a record.
    Y.applyUpdate(adapter.doc, fromAPeer(MAX_ROOM_DOC_BYTES + 1024 * 1024), 'peer');

    expect(destroyed).toHaveBeenCalledTimes(1);
    // Not the room the app starts in after a reload: its cache would be loaded again.
    expect(localStorage.getItem(getSyncRoomKey(appId))).toBeNull();
    expect(said.mock.calls.some((call) => String(call[0]).includes('was left and its saved copy deleted'))).toBe(true);
    // The room is no longer open: asked for again, it is a new one.
    const again = startSync({ room: 'lobby', appId, signaling: [], persist: false });
    expect(again).not.toBe(adapter);
    stopSync('lobby', appId);
    await Promise.resolve();
  });
});
