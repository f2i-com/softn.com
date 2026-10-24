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
  privateRoomWireName,
  sharedRoomFlagKey,
  unmarkRoomShared,
} from '../src/runtime/sync-room-security';
import { bindSyncOptions } from '../src/runtime/host-bound-sync-options';
import { getSyncRoomKey } from '../src/runtime/xdb-sync-key';
import { createDBNamespace, type PermissionConfig } from '../src/runtime/script-runtime';
import { createXDBHelpers } from '../src/loader/xdb-bindings';
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

describe('the collections a room carries', () => {
  const declaring = (roomCollections: unknown): PermissionConfig =>
    ({ permissions: { sync: { enabled: true, roomCollections } } }) as PermissionConfig;

  it('are the declaration\'s when the script names none, as a .logic app\'s start always is', () => {
    expect(decide('lobby', undefined, { permissionConfig: declaring(['scores']) }).opts.collections).toEqual(['scores']);
  });

  it('are every collection with neither a declaration nor an option', () => {
    expect('collections' in decide('lobby').opts).toBe(false);
  });

  it('may be narrowed by the script, and never widened past the declaration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { opts } = decide('lobby', { collections: ['scores', 'secrets'] }, { permissionConfig: declaring(['scores', 'players']) });
      expect(opts.collections).toEqual(['scores']);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/does not carry secrets/);
    } finally {
      warn.mockRestore();
    }
  });

  it('are the script\'s own without a declaration, and kept for a start that names none', () => {
    expect(decide('lobby', { collections: ['scores'] }).opts.collections).toEqual(['scores']);
    expect(localStorage.getItem('xdb-sync-collections:app-under-test:lobby')).toBe('["scores"]');
    // After a reload, or the host's resume of the saved room.
    expect(decide('lobby').opts.collections).toEqual(['scores']);
    // Another room is not limited by it.
    expect('collections' in decide('elsewhere').opts).toBe(false);
  });

  it('that are no list of names go on as they are, for the room to be refused, and are not kept', () => {
    for (const bad of [['_prefs'], 'scores', [''], ['a:b']]) {
      localStorage.clear();
      expect(decide('lobby', { collections: bad }).opts.collections).toEqual(bad);
      expect(localStorage.length).toBe(0);
      expect(decide('lobby', undefined, { permissionConfig: declaring(bad) }).opts.collections).toEqual(bad);
    }
  });

  it('are forgotten with the room when it is stopped', async () => {
    const namespace = createDBNamespace(() => granted, APP, 'host-key');
    namespace.startSync('lobby', { collections: ['scores'] });
    await flush();
    namespace.stopSync('lobby');
    await flush();
    namespace.startSync('lobby');
    await flush();
    expect(started[0].collections).toEqual(['scores']);
    expect('collections' in started[1]).toBe(false);
  });
});

describe('a private room with no key', () => {
  // SoftN's own hosts give no per-user key, so this is every private room.
  const keyless = () => createDBNamespace(() => granted, APP);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 400));

  it('is joined under a name derived from its own, and encrypted with its own', async () => {
    keyless().startSync('family-notes-7f3k');
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const opts = started[0];
    expect(opts.wireRoom).toMatch(/^[0-9a-f]{64}$/);
    expect(String(opts.wireRoom)).not.toContain('family');
    expect(opts.password).toBe('family-notes-7f3k');
    // The app, and its offline cache, still know the room by its name.
    expect(opts.room).toBe('family-notes-7f3k');
    expect(opts.roomScope).toBe(APP);
  });

  it('derives it with PBKDF2-SHA-256 over the name, salted with the scope: one name for one room of one app', async () => {
    // The derivation is what peers meet by; a change to it is a migration.
    const { pbkdf2Sync } = await import('node:crypto');
    const expected = pbkdf2Sync('lobby', 'softn-room-v2:com.example.a', 100_000, 32, 'sha256').toString('hex');
    expect(await privateRoomWireName('com.example.a', 'lobby')).toBe(expected);
    expect(await privateRoomWireName('com.example.b', 'lobby')).not.toBe(expected);
    expect(await privateRoomWireName('com.example.a', 'lobby2')).not.toBe(expected);
  });

  // One start at a time: vitest hands a dynamic import of the mocked sync
  // module the real one when another is in flight (so do the tests above).
  it('is the only room given one: a shared room, and one with a key, are as they were', async () => {
    keyless().startSync('open', { sharedRoom: true });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    createDBNamespace(() => granted, APP, 'host-key').startSync('hosted');
    await vi.waitFor(() => expect(started).toHaveLength(2));
    keyless().startSync('own', { password: 'the script’s own' });
    await vi.waitFor(() => expect(started).toHaveLength(3));
    for (const opts of started) expect(opts.wireRoom).toBeUndefined();
    expect(started.find((o) => o.room === 'open')?.password).toBe('softn-shared:open');
    expect(started.find((o) => o.room === 'own')?.password).toBe('the script’s own');
  });

  it('cannot be named on the wire by the script', async () => {
    keyless().startSync('lobby', { sharedRoom: true, wireRoom: 'com.other.app/lobby' });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0].wireRoom).toBeUndefined();
  });

  /**
   * Hold every secret being worked out until `release()`. How long PBKDF2
   * takes is the machine's: on a quick one it was done within the tick the
   * tests below waited, before the stop they make while it is under way.
   */
  function holdSecrets(): { release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const real = globalThis.crypto.subtle;
    vi.stubGlobal('crypto', {
      subtle: {
        importKey: real.importKey.bind(real),
        deriveBits: async (...args: Parameters<SubtleCrypto['deriveBits']>) => {
          await held;
          return real.deriveBits(...args);
        },
      },
    });
    return { release };
  }

  it('is not opened when it is stopped while its secret is worked out', async () => {
    const secrets = holdSecrets();
    try {
      const ns = keyless();
      ns.startSync('lobby');
      ns.stopSync('lobby');
      await flush();
      ns.startSync('other');
      await flush();
      // Every room of the app, while the secret of `other` is still being worked out.
      ns.stopSync();
      secrets.release();
      await settled();
      expect(started).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // xdb-sync's stopSync reads a room that is no name as every room; the
  // controls read '' and null as a room of that name, and a start of
  // `lobby` still working out its name opened after the stop.
  it('is not opened when every room is stopped by an empty name', async () => {
    const secrets = holdSecrets();
    try {
      const ns = keyless();
      ns.startSync('lobby');
      await flush();
      ns.stopSync('');
      ns.startSync('other');
      await flush();
      (ns.stopSync as (room?: unknown) => void)(null);
      secrets.release();
      await settled();
      expect(started).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is opened when it is started again after a stop', async () => {
    const ns = keyless();
    ns.startSync('lobby');
    ns.stopSync('lobby');
    await flush();
    ns.startSync('lobby');
    await settled();
    expect(started.map((o) => o.room)).toEqual(['lobby']);
  });

  it('is joined under its name, unencrypted, where the page has no Web Crypto, and the console says so', async () => {
    vi.stubGlobal('crypto', {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      keyless().startSync('lobby');
      await vi.waitFor(() => expect(started).toHaveLength(1));
      expect(started[0].wireRoom).toBeUndefined();
      expect(started[0].password).toBeUndefined();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/not a secure context/);
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
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
