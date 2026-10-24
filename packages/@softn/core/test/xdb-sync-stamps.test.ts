/**
 * An edit made here wins over the copy it edits, wherever that copy is kept.
 *
 * The newer stamp wins where records meet, and a room has no clock of
 * authority: a record may arrive stamped up to a day ahead of this clock.
 * Edits followed a stamp only an hour ahead, and only the copy this device
 * held; a script's write (a refresh) then kept the room's newer copy over
 * the edit, on the device that made it. And a peer's stamp with an offset
 * sorted, as text, up to two days above every other.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('y-webrtc', () => ({ WebrtcProvider: class {} }));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {} }));

import { XDBService, editStamp } from '../src/runtime/xdb';
import { XDBSyncAdapter } from '../src/runtime/xdb-sync';

const HOUR = 60 * 60 * 1000;
const T = Date.parse('2026-10-25T12:00:00.000Z');

function storage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
}

/** Two peers in one room, until `leave()`: then each keeps what it has. */
function room(xa: XDBService, xb: XDBService) {
  const a = new XDBSyncAdapter(xa, { room: 'r', signaling: [], persist: false });
  const b = new XDBSyncAdapter(xb, { room: 'r', signaling: [], persist: false });
  let together = true;
  a.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (together && origin !== 'peer') Y.applyUpdate(b.doc, u, 'peer');
  });
  b.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (together && origin !== 'peer') Y.applyUpdate(a.doc, u, 'peer');
  });
  a.attachLocal();
  b.attachLocal();
  return { a, b, leave: () => { together = false; } };
}

const text = (x: XDBService, id: string) => (x.get('notes', id)?.data as { text?: string } | undefined)?.text;
const roomText = (adapter: XDBSyncAdapter, id: string) => (adapter.doc.getMap('notes').get(id) as { data: { text?: string } } | undefined)?.data.text;

/** A write of a script's, as every VM call makes it: announced as a refresh. */
function inScript(x: XDBService, write: () => void): void {
  x.suppressNotifications();
  try {
    write();
  } finally {
    x.resumeNotifications();
  }
}

function quietly<T>(run: () => T): T {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return run();
  } finally {
    warn.mockRestore();
  }
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('an edit made in a script call', () => {
  it('keeps over a record its author stamped two hours ahead, here and in the room', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const xa = new XDBService(storage(), 'stamp-a', undefined, { backend: 'storage' });
    const xb = new XDBService(storage(), 'stamp-b', undefined, { backend: 'storage' });
    const { b, leave } = room(xa, xb);
    // A's clock runs two hours fast.
    vi.setSystemTime(T + 2 * HOUR);
    const note = xa.create('notes', { text: 'A' });
    leave();
    vi.setSystemTime(T);
    inScript(xb, () => xb.update(note.id, { text: 'B' }));
    expect(text(xb, note.id)).toBe('B');
    expect(roomText(b, note.id)).toBe('B');
  });

  it('goes to the room when this device holds an older copy than the room does', () =>
    quietly(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T);
      const xa = new XDBService(storage(), 'xdb:a', 'a', { backend: 'storage' });
      // B under the browser's budget: it cannot keep A's larger edit.
      const xb = new XDBService(undefined, 'xdb:b', 'b', { backend: 'storage' });
      const { b, leave } = room(xa, xb);
      const note = xa.create('notes', { text: 'small' });
      for (let i = 0; i < 30; i++) xa.create('notes', { n: i, body: 'x'.repeat(100_000) });
      // A's clock is half an hour fast when it makes the edit B cannot keep.
      vi.setSystemTime(T + 30 * 60 * 1000);
      xa.update(note.id, { text: 'grown', body: 'y'.repeat(100_000) });
      expect(text(xb, note.id)).toBe('small');
      leave();
      vi.setSystemTime(T + 60 * 1000);
      inScript(xb, () => xb.update(note.id, { text: 'B edit' }));
      expect(text(xb, note.id)).toBe('B edit');
      expect(roomText(b, note.id)).toBe('B edit');
    }));

  it('still leaves the room the newer copy of a record this device holds older and has not edited', () =>
    quietly(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T);
      const xa = new XDBService(storage(), 'xdb:a', 'a', { backend: 'storage' });
      const xb = new XDBService(undefined, 'xdb:b', 'b', { backend: 'storage' });
      const { b, leave } = room(xa, xb);
      const note = xa.create('notes', { text: 'small' });
      for (let i = 0; i < 30; i++) xa.create('notes', { n: i, body: 'x'.repeat(100_000) });
      vi.setSystemTime(T + 30 * 60 * 1000);
      xa.update(note.id, { text: 'grown', body: 'y'.repeat(100_000) });
      leave();
      vi.setSystemTime(T + 60 * 1000);
      inScript(xb, () => xb.create('notes', { mine: true }));
      expect(roomText(b, note.id)).toBe('grown');
    }));
});

describe("a peer's stamp with an offset", () => {
  it('orders as the time it is, and is kept as XDB writes its own', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    const xa = new XDBService(storage(), 'offset-a', undefined, { backend: 'storage' });
    const xb = new XDBService(storage(), 'offset-b', undefined, { backend: 'storage' });
    const { a, b, leave } = room(xa, xb);
    // Now, written with an offset of nearly a day: as text, a day ahead of every `Z` stamp.
    const offset = '2026-10-26T11:59:00.000+23:59';
    expect(Date.parse(offset)).toBe(T);
    a.doc.getMap('notes').set('n1', { id: 'n1', collection: 'notes', data: { text: 'pinned' }, created_at: offset, updated_at: offset, deleted: false });
    expect(xb.get('notes', 'n1')?.updated_at).toBe('2026-10-25T12:00:00.000Z');
    leave();
    vi.setSystemTime(T + HOUR);
    inScript(xb, () => xb.update('n1', { text: 'B, an hour later' }));
    expect(text(xb, 'n1')).toBe('B, an hour later');
    expect(roomText(b, 'n1')).toBe('B, an hour later');
  });

  it('is followed by an edit as the time it is', () => {
    const offset = '2026-10-25T12:30:00.000+00:30';
    const now = Date.parse('2026-10-25T11:45:00.000Z');
    expect(Date.parse(editStamp(offset, now))).toBeGreaterThan(Date.parse(offset));
  });
});
