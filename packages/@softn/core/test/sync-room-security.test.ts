/**
 * One rule for a sync room's key, applied by every path that starts one.
 *
 * The script runtime's `db.startSync` used to remember a per-app flag that
 * made every later room shared once any room had been; the renderer's
 * helpers never read it for an explicit call. Two peers of one app could be
 * in one room with different keys. The rule now lives in
 * sync-room-security.ts and both surfaces reach it through
 * db-sync-controls.ts; this file pins the rule and the parity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const started: Array<Record<string, unknown>> = [];
const stopped: Array<[string | undefined, string | undefined]> = [];

vi.mock('../src/runtime/xdb-sync', () => ({
  startSync: (opts: Record<string, unknown>) => {
    started.push({ ...opts });
  },
  stopSync: (room?: string, appId?: string) => {
    stopped.push([room, appId]);
  },
  getSyncAdapter: () => null,
}));

import {
  applyRoomSecurity,
  isRoomMarkedShared,
  legacySharedFlagKey,
  markRoomShared,
  sharedRoomFlagKey,
  unmarkRoomShared,
} from '../src/runtime/sync-room-security';
import { bindSyncOptions } from '../src/runtime/host-bound-sync-options';
import { getSyncRoomKey } from '../src/runtime/xdb-sync-key';
import { createDBNamespace, type PermissionConfig } from '../src/runtime/script-runtime';
import { createXDBHelpers } from '../src/loader/SoftNRenderer';
import { getXDB } from '../src/runtime/xdb';

const APP = 'app-under-test';
const granted: PermissionConfig = { permissions: { sync: { enabled: true } } };

function decide(room: string, options?: Record<string, unknown>, extra: { appId?: string; permissionConfig?: PermissionConfig; key?: string } = {}) {
  const appId = 'appId' in extra ? extra.appId : APP;
  const opts = bindSyncOptions(room, options, appId);
  const shared = applyRoomSecurity(opts, { room, appId, permissionConfig: extra.permissionConfig ?? granted, syncEncryptionKeyHex: extra.key });
  return { shared, opts };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  started.length = 0;
  stopped.length = 0;
});

afterEach(() => {
  localStorage.clear();
});

describe('the exact keys', () => {
  // These strings are on disk in users' browsers; a rename is a migration.
  it('are the ones older builds wrote and the per-room one beside them', () => {
    expect(legacySharedFlagKey('a')).toBe('xdb-sync-shared:a');
    expect(sharedRoomFlagKey('a', 'lobby')).toBe('xdb-sync-shared:a:lobby');
    expect(getSyncRoomKey('a')).toBe('xdb-sync-active-room:a');
  });
});

describe('applyRoomSecurity', () => {
  it('opens a room private with the host key when the caller asks nothing', () => {
    const { shared, opts } = decide('lobby', undefined, { key: 'aa11' });
    expect(shared).toBe(false);
    expect(opts.encryptionKey).toBe('aa11');
    expect(opts.password).toBeUndefined();
    expect(isRoomMarkedShared(APP, 'lobby')).toBe(false);
  });

  it('keeps a key the caller named over the host key', () => {
    const { opts } = decide('lobby', { encryptionKey: 'caller' }, { key: 'host' });
    expect(opts.encryptionKey).toBe('caller');
  });

  it('opens a shared room on the room-derived password, without any per-user key', () => {
    for (const request of [{ sharedRoom: true }, { noEncrypt: true }]) {
      localStorage.clear();
      const { shared, opts } = decide('lobby', request, { key: 'host' });
      expect(shared).toBe(true);
      expect(opts.password).toBe('softn-shared:lobby');
      expect(opts.encryptionKey).toBeUndefined();
      // The requests are consumed, never forwarded to the wire layer.
      expect('sharedRoom' in opts).toBe(false);
      expect('noEncrypt' in opts).toBe(false);
      expect(localStorage.getItem('xdb-sync-shared:app-under-test:lobby')).toBe('true');
    }
  });

  it('keeps a room shared when it is started again without options, after a reload', () => {
    decide('lobby', { sharedRoom: true });
    const again = decide('lobby', undefined, { key: 'host' });
    expect(again.shared).toBe(true);
    expect(again.opts.password).toBe('softn-shared:lobby');
    expect(again.opts.encryptionKey).toBeUndefined();
  });

  it('does not let one shared room make a later, different room shared', () => {
    // The sticky per-app flag did exactly this: a private room downgraded to
    // a guessable key because some other room had once been shared.
    decide('lobby', { sharedRoom: true });
    const other = decide('private-notes', undefined, { key: 'host' });
    expect(other.shared).toBe(false);
    expect(other.opts.encryptionKey).toBe('host');
    expect(other.opts.password).toBeUndefined();
  });

  it('honours the legacy per-app flag for the saved room only', () => {
    localStorage.setItem('xdb-sync-shared:app-under-test', 'true');
    localStorage.setItem('xdb-sync-active-room:app-under-test', 'lobby');
    expect(decide('lobby', undefined, { key: 'host' }).opts.password).toBe('softn-shared:lobby');
    const other = decide('elsewhere', undefined, { key: 'host' });
    expect(other.shared).toBe(false);
    expect(other.opts.encryptionKey).toBe('host');
    // The legacy flag is the host's; it is read, never rewritten.
    expect(localStorage.getItem('xdb-sync-shared:app-under-test')).toBe('true');
  });

  it('scopes the wire room by the declared app id, else the host id', () => {
    expect(decide('lobby', undefined, { permissionConfig: { app: { id: 'com.example.app' }, permissions: { sync: { enabled: true } } } }).opts.roomScope).toBe('com.example.app');
    expect(decide('lobby').opts.roomScope).toBe(APP);
    expect(decide('lobby', undefined, { appId: undefined }).opts.roomScope).toBeUndefined();
  });

  it('marks nothing without an app identity', () => {
    const { shared } = decide('lobby', { sharedRoom: true }, { appId: undefined });
    expect(shared).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(isRoomMarkedShared(undefined, 'lobby')).toBe(false);
  });
});

describe('forgetting a shared room', () => {
  it('forgets one room, and leaves the others and the legacy flag alone', () => {
    markRoomShared(APP, 'a');
    markRoomShared(APP, 'b');
    localStorage.setItem('xdb-sync-shared:app-under-test', 'true');
    unmarkRoomShared(APP, 'a');
    expect(isRoomMarkedShared(APP, 'a')).toBe(false);
    expect(isRoomMarkedShared(APP, 'b')).toBe(true);
    expect(localStorage.getItem('xdb-sync-shared:app-under-test')).toBe('true');
  });

  it('forgets every room of the app when none is named, and no other app\'s', () => {
    markRoomShared(APP, 'a');
    markRoomShared(APP, 'b');
    markRoomShared('other-app', 'a');
    unmarkRoomShared(APP);
    expect(isRoomMarkedShared(APP, 'a')).toBe(false);
    expect(isRoomMarkedShared(APP, 'b')).toBe(false);
    expect(isRoomMarkedShared('other-app', 'a')).toBe(true);
  });
});

/**
 * The two surfaces a bundle can reach sync through must hand the wire layer
 * the same options for the same call: they are one implementation now, but a
 * copy is one refactor away.
 */
describe('the db namespace and the renderer helpers agree', () => {
  const namespace = () => createDBNamespace(() => granted, APP, 'host-key');
  const helpers = () => createXDBHelpers(getXDB(APP), 'host-key', APP, granted);

  it('on a private room', async () => {
    namespace().startSync('lobby', { displayName: 'a' });
    await flush();
    helpers().startSync('lobby', { displayName: 'a' });
    await flush();
    expect(started).toHaveLength(2);
    expect(started[1]).toEqual(started[0]);
    expect(started[0]).toMatchObject({ room: 'lobby', appId: APP, roomScope: APP, encryptionKey: 'host-key', displayName: 'a' });
  });

  it('on a shared room, and on its restart without options', async () => {
    namespace().startSync('lobby', { sharedRoom: true });
    await flush();
    helpers().startSync('lobby');
    await flush();
    expect(started).toHaveLength(2);
    expect(started[1]).toEqual(started[0]);
    expect(started[0]).toMatchObject({ room: 'lobby', password: 'softn-shared:lobby' });
    expect(started[0].encryptionKey).toBeUndefined();
  });

  it('and both forget the shared mark when the room is stopped', async () => {
    namespace().startSync('lobby', { sharedRoom: true });
    await flush();
    namespace().stopSync('lobby');
    await flush();
    expect(stopped).toEqual([['lobby', APP]]);
    expect(isRoomMarkedShared(APP, 'lobby')).toBe(false);

    helpers().startSync('lobby', { sharedRoom: true });
    await flush();
    expect(isRoomMarkedShared(APP, 'lobby')).toBe(true);
    helpers().stopSync('lobby');
    await flush();
    expect(isRoomMarkedShared(APP, 'lobby')).toBe(false);
    // Restarted without options, the room is private again.
    helpers().startSync('lobby');
    await flush();
    expect(started[started.length - 1].password).toBeUndefined();
    expect(started[started.length - 1].encryptionKey).toBe('host-key');
  });

  it('refuse in their own voice, and neither starts anything', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      createDBNamespace(() => null, APP).startSync('lobby');
      expect(String(errors.mock.calls[0]?.[0])).toMatch(/not permitted/i);
      expect(() => createXDBHelpers(getXDB(APP), undefined, APP, undefined).startSync('lobby')).toThrow(/not permitted/i);
      await flush();
      expect(started).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
