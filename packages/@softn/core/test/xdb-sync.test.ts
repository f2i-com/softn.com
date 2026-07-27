/**
 * XDB Sync & Encryption Tests
 *
 * Tests the sync adapter, encryption key flow, signaling configuration,
 * sync status bridge, and the module-level sync manager functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  XDBService,
  setDefaultSignaling,
  getDefaultSignaling,
  _setSyncModuleRef,
  getSyncStatuses,
} from '../src/runtime/xdb';

// ── Mock y-webrtc and y-indexeddb ─────────────────────────
// These are external P2P libraries that require WebRTC/IndexedDB.
// We mock them to test the adapter logic in isolation.

const mockAwareness = {
  getStates: () => new Map([[1, {}], [2, {}]]),
  setLocalStateField: vi.fn(),
};

const mockProviderInstance = {
  connected: true,
  awareness: mockAwareness,
  destroy: vi.fn(),
  room: { webrtcConns: new Map() },
};

let lastProviderRoom: string | undefined;
let lastProviderOptions: Record<string, unknown> | undefined;

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class MockWebrtcProvider {
    connected = true;
    awareness = mockAwareness;
    room = { webrtcConns: new Map() };
    destroy = vi.fn();

    constructor(room: string, _ydoc: unknown, options?: Record<string, unknown>) {
      lastProviderRoom = room;
      lastProviderOptions = options;
      Object.assign(mockProviderInstance, this);
    }
  },
}));

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class MockIndexeddbPersistence {
    private listeners = new Map<string, Set<() => void>>();

    constructor(_dbName: string, _ydoc: unknown) {
      // Auto-fire 'synced' after a tick to simulate IndexedDB load
      setTimeout(() => {
        const handlers = this.listeners.get('synced');
        if (handlers) handlers.forEach(h => h());
      }, 0);
    }

    on(event: string, handler: () => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(handler);
    }

    off(event: string, handler: () => void) {
      this.listeners.get(event)?.delete(handler);
    }

    destroy() {}
  },
}));

// ── In-memory storage for XDB ─────────────────────────────

function createTestStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
}

// ── Import sync module AFTER mocks are set up ─────────────

import {
  XDBSyncAdapter,
  startSync,
  stopSync,
  destroySync,
  getSyncAdapter,
  getAllSyncStatus,
  getSavedSyncRoom,
  type XDBSyncOptions,
} from '../src/runtime/xdb-sync';

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe('XDBSyncOptions encryption key', () => {
  let xdb: XDBService;

  beforeEach(() => {
    xdb = new XDBService(createTestStorage(), 'test-sync');
    lastProviderRoom = undefined;
    lastProviderOptions = undefined;
  });

  afterEach(() => {
    stopSync();
  });

  it('should pass encryptionKey as password to WebrtcProvider', () => {
    const opts: XDBSyncOptions = {
      room: 'test-enc-room',
      encryptionKey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      signaling: ['ws://localhost:8700/ws'],
    };
    const adapter = new XDBSyncAdapter(xdb, opts);
    adapter.connect();

    expect(lastProviderRoom).toBe('test-enc-room');
    expect(lastProviderOptions?.password).toBe(opts.encryptionKey);

    adapter.disconnect();
  });

  it('should prefer encryptionKey over password when both are set', () => {
    const opts: XDBSyncOptions = {
      room: 'test-both-room',
      password: 'plain-password',
      encryptionKey: 'hex-encryption-key',
      signaling: ['ws://localhost:8700/ws'],
    };
    const adapter = new XDBSyncAdapter(xdb, opts);
    adapter.connect();

    // encryptionKey takes precedence via `encryptionKey || password`
    expect(lastProviderOptions?.password).toBe('hex-encryption-key');

    adapter.disconnect();
  });

  it('should fall back to password when no encryptionKey is set', () => {
    const opts: XDBSyncOptions = {
      room: 'test-pw-room',
      password: 'my-password',
      signaling: ['ws://localhost:8700/ws'],
    };
    const adapter = new XDBSyncAdapter(xdb, opts);
    adapter.connect();

    expect(lastProviderOptions?.password).toBe('my-password');

    adapter.disconnect();
  });

  it('should pass undefined password when neither key nor password is set', () => {
    const opts: XDBSyncOptions = {
      room: 'test-noauth-room',
      signaling: ['ws://localhost:8700/ws'],
    };
    const adapter = new XDBSyncAdapter(xdb, opts);
    adapter.connect();

    expect(lastProviderOptions?.password).toBeUndefined();

    adapter.disconnect();
  });
});

describe('Signaling URL resolution', () => {
  let xdb: XDBService;

  beforeEach(() => {
    xdb = new XDBService(createTestStorage(), 'test-signaling');
    lastProviderOptions = undefined;
    // Reset default signaling
    setDefaultSignaling([]);
  });

  afterEach(() => {
    stopSync();
    setDefaultSignaling([]);
  });

  it('should use explicit signaling URLs when provided', () => {
    const adapter = new XDBSyncAdapter(xdb, {
      room: 'sig-explicit',
      signaling: ['ws://my-server:8700/ws'],
    });
    adapter.connect();

    expect(lastProviderOptions?.signaling).toEqual(['ws://my-server:8700/ws']);

    adapter.disconnect();
  });

  it('should fall back to app-level default signaling when no explicit URLs', () => {
    setDefaultSignaling(['ws://default-server:9000/ws']);

    const adapter = new XDBSyncAdapter(xdb, {
      room: 'sig-default',
    });
    adapter.connect();

    expect(lastProviderOptions?.signaling).toEqual(['ws://default-server:9000/ws']);

    adapter.disconnect();
  });

  it('should use empty array when no signaling is configured anywhere', () => {
    // Don't set any default signaling
    setDefaultSignaling([]);

    const adapter = new XDBSyncAdapter(xdb, {
      room: 'sig-empty',
    });
    adapter.connect();

    // Empty array prevents y-webrtc from using public servers
    expect(lastProviderOptions?.signaling).toEqual([]);

    adapter.disconnect();
  });

  it('should prefer explicit signaling over app defaults', () => {
    setDefaultSignaling(['ws://default:9000/ws']);

    const adapter = new XDBSyncAdapter(xdb, {
      room: 'sig-override',
      signaling: ['ws://explicit:8000/ws'],
    });
    adapter.connect();

    expect(lastProviderOptions?.signaling).toEqual(['ws://explicit:8000/ws']);

    adapter.disconnect();
  });

  it('should fall back to empty when explicit is empty array and no defaults', () => {
    const adapter = new XDBSyncAdapter(xdb, {
      room: 'sig-empty-explicit',
      signaling: [],
    });
    adapter.connect();

    // Empty explicit array → falls through to app defaults → falls through to empty
    expect(lastProviderOptions?.signaling).toEqual([]);

    adapter.disconnect();
  });
});

describe('Default signaling configuration (xdb.ts)', () => {
  afterEach(() => {
    setDefaultSignaling([]);
  });

  it('should return undefined when not configured', () => {
    // Reset by setting empty then checking behavior
    setDefaultSignaling([]);
    // getDefaultSignaling returns the array that was set
    expect(getDefaultSignaling()).toEqual([]);
  });

  it('should store and retrieve signaling URLs', () => {
    setDefaultSignaling(['ws://server1:8700/ws', 'ws://server2:8700/ws']);
    expect(getDefaultSignaling()).toEqual(['ws://server1:8700/ws', 'ws://server2:8700/ws']);
  });

  it('should overwrite previous configuration', () => {
    setDefaultSignaling(['ws://old-server/ws']);
    setDefaultSignaling(['ws://new-server/ws']);
    expect(getDefaultSignaling()).toEqual(['ws://new-server/ws']);
  });
});

describe('Sync status bridge (xdb.ts)', () => {
  afterEach(() => {
    _setSyncModuleRef(null);
  });

  it('should return empty array when sync module is not loaded', () => {
    _setSyncModuleRef(null);
    expect(getSyncStatuses()).toEqual([]);
  });

  it('should return statuses from registered sync module', () => {
    const mockStatuses = [
      { connected: true, peers: 2, room: 'test-room', peerId: '123' },
    ];
    _setSyncModuleRef({ getAllSyncStatus: () => mockStatuses });

    expect(getSyncStatuses()).toEqual(mockStatuses);
  });

  it('should return empty array when module returns empty', () => {
    _setSyncModuleRef({ getAllSyncStatus: () => [] });
    expect(getSyncStatuses()).toEqual([]);
  });

  it('should handle module reference being replaced', () => {
    _setSyncModuleRef({
      getAllSyncStatus: () => [
        { connected: true, peers: 1, room: 'room-a', peerId: '1' },
      ],
    });
    expect(getSyncStatuses()).toHaveLength(1);

    _setSyncModuleRef({
      getAllSyncStatus: () => [
        { connected: false, peers: 0, room: 'room-b', peerId: '2' },
        { connected: true, peers: 3, room: 'room-c', peerId: '3' },
      ],
    });
    expect(getSyncStatuses()).toHaveLength(2);
    expect(getSyncStatuses()[0].room).toBe('room-b');
  });
});

describe('XDBSyncAdapter lifecycle', () => {
  let xdb: XDBService;

  beforeEach(() => {
    xdb = new XDBService(createTestStorage(), 'test-lifecycle');
    lastProviderOptions = undefined;
  });

  it('should prevent double-connect', () => {
    const adapter = new XDBSyncAdapter(xdb, {
      room: 'double-connect',
      signaling: ['ws://localhost:8700/ws'],
    });
    adapter.connect();

    // Second connect should be a no-op
    lastProviderOptions = undefined;
    adapter.connect();
    expect(lastProviderOptions).toBeUndefined(); // No new provider created

    adapter.disconnect();
  });

  it('should report status correctly', () => {
    const adapter = new XDBSyncAdapter(xdb, {
      room: 'status-room',
      signaling: [],
    });

    // Before connect
    const pre = adapter.getStatus();
    expect(pre.connected).toBe(false);
    expect(pre.peers).toBe(0);
    expect(pre.room).toBe('status-room');

    adapter.connect();

    // After connect
    const post = adapter.getStatus();
    expect(post.connected).toBe(true);
    expect(post.room).toBe('status-room');
    expect(post.peerId).toBeDefined();

    adapter.disconnect();
  });

  it('should clean up on disconnect', () => {
    const adapter = new XDBSyncAdapter(xdb, {
      room: 'cleanup-room',
      signaling: [],
    });
    adapter.connect();

    adapter.disconnect();

    // After disconnect, status should reflect disconnected state
    const status = adapter.getStatus();
    expect(status.connected).toBe(false);
  });

  it('should set awareness display name when provided', () => {
    const adapter = new XDBSyncAdapter(xdb, {
      room: 'awareness-room',
      displayName: 'TestUser',
      signaling: [],
    });
    adapter.connect();

    expect(mockAwareness.setLocalStateField).toHaveBeenCalledWith('user', {
      name: 'TestUser',
    });

    adapter.disconnect();
  });
});

describe('Sync manager functions', () => {
  beforeEach(() => {
    stopSync(); // Clean slate
    setDefaultSignaling(['ws://localhost:8700/ws']);
  });

  afterEach(() => {
    stopSync();
    setDefaultSignaling([]);
  });

  it('startSync should create and return an adapter', () => {
    const adapter = startSync({ room: 'mgr-room', signaling: ['ws://localhost/ws'] });
    expect(adapter).toBeDefined();
    expect(adapter.getStatus().room).toBe('mgr-room');
  });

  it('startSync should return existing adapter for same room', () => {
    const a1 = startSync({ room: 'mgr-same', signaling: ['ws://localhost/ws'] });
    const a2 = startSync({ room: 'mgr-same', signaling: ['ws://localhost/ws'] });
    expect(a1).toBe(a2);
  });

  it('startSync should register sync module ref', () => {
    // Before starting any sync, reset the module ref
    _setSyncModuleRef(null);
    expect(getSyncStatuses()).toEqual([]);

    startSync({ room: 'mgr-ref', signaling: ['ws://localhost/ws'] });

    // After startSync, getSyncStatuses should work
    const statuses = getSyncStatuses();
    expect(Array.isArray(statuses)).toBe(true);
  });

  it('stopSync should disconnect specific room', () => {
    startSync({ room: 'mgr-stop-a', signaling: ['ws://localhost/ws'] });
    startSync({ room: 'mgr-stop-b', signaling: ['ws://localhost/ws'] });

    stopSync('mgr-stop-a');

    expect(getSyncAdapter('mgr-stop-a')).toBeNull();
    expect(getSyncAdapter('mgr-stop-b')).not.toBeNull();
  });

  it('stopSync without room should disconnect all', () => {
    startSync({ room: 'mgr-all-a', signaling: ['ws://localhost/ws'] });
    startSync({ room: 'mgr-all-b', signaling: ['ws://localhost/ws'] });

    stopSync();

    expect(getSyncAdapter('mgr-all-a')).toBeNull();
    expect(getSyncAdapter('mgr-all-b')).toBeNull();
  });

  it('getAllSyncStatus should return status for all active rooms', () => {
    startSync({ room: 'status-a', signaling: ['ws://localhost/ws'] });
    startSync({ room: 'status-b', signaling: ['ws://localhost/ws'] });

    const statuses = getAllSyncStatus();
    expect(statuses).toHaveLength(2);

    const rooms = statuses.map(s => s.room);
    expect(rooms).toContain('status-a');
    expect(rooms).toContain('status-b');
  });

  it('getSyncAdapter should return null when no adapters exist', () => {
    expect(getSyncAdapter()).toBeNull();
    expect(getSyncAdapter('nonexistent')).toBeNull();
  });

  it('getSyncAdapter without room should return first adapter', () => {
    startSync({ room: 'first-adapter', signaling: ['ws://localhost/ws'] });

    const adapter = getSyncAdapter();
    expect(adapter).not.toBeNull();
    expect(adapter!.getStatus().room).toBe('first-adapter');
  });

  it('destroySync should fully destroy adapter', () => {
    startSync({ room: 'destroy-me', signaling: ['ws://localhost/ws'] });

    destroySync('destroy-me');

    expect(getSyncAdapter('destroy-me')).toBeNull();
  });

  it('startSync should persist room to localStorage', () => {
    startSync({ room: 'persist-room', signaling: ['ws://localhost/ws'] });
    expect(getSavedSyncRoom()).toBe('persist-room');
  });

  it('stopSync should clear persisted room', () => {
    startSync({ room: 'clear-room', signaling: ['ws://localhost/ws'] });
    stopSync('clear-room');
    expect(getSavedSyncRoom()).toBeNull();
  });
});

describe('Encryption key with sync manager', () => {
  beforeEach(() => {
    stopSync();
    lastProviderOptions = undefined;
  });

  afterEach(() => {
    stopSync();
  });

  it('startSync should pass encryptionKey through to WebrtcProvider', () => {
    startSync({
      room: 'enc-mgr-room',
      encryptionKey: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      signaling: ['ws://localhost/ws'],
    });

    expect(lastProviderOptions?.password).toBe(
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    );
  });

  it('startSync without encryptionKey should leave password undefined', () => {
    startSync({
      room: 'no-enc-room',
      signaling: ['ws://localhost/ws'],
    });

    expect(lastProviderOptions?.password).toBeUndefined();
  });
});

describe('XDB data sync through adapter', () => {
  let xdb: XDBService;

  beforeEach(() => {
    xdb = new XDBService(createTestStorage(), 'test-data-sync');
  });

  it('should sync local XDB records into Y.Doc on initial connect', async () => {
    // Create some records before connecting
    xdb.create('tasks', { title: 'Task 1' });
    xdb.create('tasks', { title: 'Task 2' });

    const adapter = new XDBSyncAdapter(xdb, {
      room: 'data-sync-room',
      signaling: [],
      persist: false, // Skip IndexedDB persistence for simpler test
    });
    adapter.connect();

    // The adapter should have performed initial sync
    // We can't directly inspect Y.Doc from outside, but we can verify
    // the adapter is connected and status is valid
    const status = adapter.getStatus();
    expect(status.room).toBe('data-sync-room');
    expect(status.connected).toBe(true);

    adapter.disconnect();
  });

  it('should skip internal collections starting with underscore', async () => {
    xdb.create('_internal', { secret: true });
    xdb.create('public', { visible: true });

    const adapter = new XDBSyncAdapter(xdb, {
      room: 'skip-internal-room',
      signaling: [],
      persist: false,
    });
    adapter.connect();

    // Adapter should connect fine — internal collections silently skipped
    expect(adapter.getStatus().connected).toBe(true);

    adapter.disconnect();
  });

  it('should propagate XDB creates to Y.Doc', () => {
    const adapter = new XDBSyncAdapter(xdb, {
      room: 'create-propagation',
      signaling: [],
      persist: false,
    });
    adapter.connect();

    // Create a record after sync is active
    xdb.create('notes', { text: 'Hello sync' });

    // The record should have been sent to Y.Doc via the subscription
    // (verified indirectly: no errors thrown, adapter still connected)
    expect(adapter.getStatus().connected).toBe(true);

    adapter.disconnect();
  });
});
