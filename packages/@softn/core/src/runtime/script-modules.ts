/**
 * The modules a script is given beside its own code: `db` and the XDB module
 * over the app's records, a stand-in XDB for tests and previews, navigation
 * and the console. The script runtime (script-runtime.ts) hands them in, and
 * re-exports them.
 */

import type { XDBRecord } from '../types';
import type { ConsoleModule, NavModule, PermissionConfig, XDBModule } from './script-runtime';
import { createSyncControls } from './db-sync-controls';
import { debug } from './debug';

/**
 * Create an XDB module that uses the real XDB service with localStorage persistence
 * This replaces the old mock implementation with actual persistence.
 */
export function createPersistentXDBModule(appId?: string): XDBModule {
  // Import dynamically to avoid circular dependency
  // The XDB service is created lazily when needed
  let xdbService: import('./xdb').XDBService | null = null;

  const getXDB = async () => {
    if (!xdbService) {
      const { getXDB: getXDBInstance } = await import('./xdb');
      xdbService = getXDBInstance(appId);
    }
    return xdbService;
  };

  return {
    create: async (collection: string, data: Record<string, unknown>) => {
      const xdb = await getXDB();
      return xdb.isP2PAvailable()
        ? xdb.createAsync(collection, data)
        : xdb.create(collection, data);
    },

    update: async (id: string, data: Record<string, unknown>) => {
      const xdb = await getXDB();
      const record = xdb.isP2PAvailable() ? await xdb.updateAsync(id, data) : xdb.update(id, data);
      if (!record) {
        throw new Error(`Record not found: ${id}`);
      }
      return record;
    },

    delete: async (id: string) => {
      const xdb = await getXDB();
      if (xdb.isP2PAvailable()) {
        await xdb.deleteAsync(id);
      } else {
        xdb.delete(id);
      }
    },

    query: async (collection: string, filter?: Record<string, unknown>) => {
      const xdb = await getXDB();
      if (xdb.isP2PAvailable()) {
        return xdb.queryAsync(collection, filter ? { filter } : undefined);
      }
      return xdb.query(collection, filter ? { filter } : undefined);
    },

    get: async (collection: string, id: string) => {
      const xdb = await getXDB();
      if (xdb.isP2PAvailable()) {
        return xdb.getAsync(collection, id);
      }
      return xdb.get(collection, id);
    },

    sync: async () => {
      const xdb = await getXDB();
      return xdb.sync();
    },
  };
}

/**
 * DB namespace interface for direct use in <logic> blocks
 * Provides a clean, synchronous API for database operations
 */
export interface DBNamespace {
  query: (collection: string, filter?: Record<string, unknown>) => XDBRecord[];
  create: (collection: string, data: Record<string, unknown>) => XDBRecord;
  update: (id: string, data: Record<string, unknown>) => XDBRecord;
  delete: (id: string) => void;
  hardDelete: (collection: string, id: string) => void;
  get: (collection: string, id: string) => XDBRecord | null;
  /**
   * Prune a collection to keep at most `maxRecords` records.
   * Removes oldest records first (by created_at). Returns number of records removed.
   */
  prune: (collection: string, maxRecords: number) => number;
  /** Remove all records from a collection */
  clearCollection: (collection: string) => void;
  startSync: (room: string, options?: Record<string, unknown>) => void;
  stopSync: (room?: string) => void;
  getSyncStatus: (room?: string) => {
    connected: boolean;
    peers: number;
    room: string;
    peerId: string;
  };
  getSavedSyncRoom: () => string | null;
  /** Wait for the XDB service to finish initializing */
  ready: () => Promise<void>;
}

/**
 * Create a synchronous db namespace for use in <logic> blocks
 * This uses the XDB service synchronously for immediate data access
 */
export function createDBNamespace(
  getPermissionConfig?: () => PermissionConfig | null,
  appId?: string,
  syncEncryptionKeyHex?: string
): DBNamespace {
  // Import XDB directly - this module uses a singleton pattern
  // We use a wrapper that will lazily initialize
  let xdbService: import('./xdb').XDBService | null = null;
  let xdbPromise: Promise<import('./xdb').XDBService> | null = null;

  // Start loading XDB immediately but don't block
  const initXDB = async () => {
    if (!xdbPromise) {
      xdbPromise = import('./xdb').then((m) => {
        xdbService = m.getXDB(appId);
        return xdbService;
      });
    }
    return xdbPromise;
  };

  const getXDBSync = (): import('./xdb').XDBService => {
    if (!xdbService) {
      // If not yet loaded, trigger load and throw a meaningful error
      // In practice, by the time user actions happen, XDB should be loaded
      initXDB();
      throw new Error('XDB is still initializing. This should not happen in normal use.');
    }
    return xdbService;
  };

  return {
    query: (collection: string, filter?: Record<string, unknown>) => {
      const xdb = getXDBSync();
      return xdb.query(collection, filter ? { filter } : undefined);
    },

    create: (collection: string, data: Record<string, unknown>) => {
      const xdb = getXDBSync();
      return xdb.create(collection, data);
    },

    update: (id: string, data: Record<string, unknown>) => {
      const xdb = getXDBSync();
      const record = xdb.update(id, data);
      if (!record) {
        throw new Error(`Record not found: ${id}`);
      }
      return record;
    },

    delete: (id: string) => {
      const xdb = getXDBSync();
      xdb.delete(id);
    },

    hardDelete: (collection: string, id: string) => {
      const xdb = getXDBSync();
      xdb.hardDelete(collection, id);
    },

    get: (collection: string, id: string) => {
      const xdb = getXDBSync();
      return xdb.get(collection, id);
    },

    // The sync methods are one implementation shared with the renderer's xdb
    // helpers (db-sync-controls.ts): same gate, same host-bound options, same
    // signalling rules, same wire scope and key. A script cannot catch a host
    // refusal, so this surface logs it and returns.
    ...createSyncControls({
      appId,
      getPermissionConfig: () => getPermissionConfig?.() ?? null,
      syncEncryptionKeyHex,
      refuse: (reason) => {
        console.error(
          reason === 'pending'
            ? '[XDB Sync] Sync not allowed yet. Choose Allow in the permission bar to grant it.'
            : '[XDB Sync] Sync not permitted. Add sync.enabled to permission.json'
        );
      },
    }),

    prune: (collection: string, maxRecords: number) => {
      const xdb = getXDBSync();
      const records = xdb.query(collection);
      if (records.length <= maxRecords) return 0;
      // Sort by created_at ascending (oldest first)
      const sorted = [...records].sort((a, b) =>
        (a.created_at || '').localeCompare(b.created_at || '')
      );
      const toRemove = sorted.slice(0, records.length - maxRecords);
      // In one write: one hardDelete each rewrote the whole collection, so
      // pruning grew with the square of its size.
      return xdb.hardDeleteMany(collection, toRemove.map((rec) => rec.id));
    },

    clearCollection: (collection: string) => {
      const xdb = getXDBSync();
      xdb.hardDeleteMany(collection, xdb.query(collection).map((rec) => rec.id));
    },

    ready: () => initXDB().then(() => {}),
  };
}

/**
 * Create a mock XDB module (for testing without persistence)
 * @deprecated Use createPersistentXDBModule() instead for real applications
 */
export function createMockXDBModule(): XDBModule {
  // For backwards compatibility, use the in-memory mock
  const collections = new Map<string, XDBRecord[]>();

  return {
    create: async (collection: string, data: Record<string, unknown>) => {
      const record: XDBRecord = {
        id:
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        collection,
        data,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted: false,
      };

      if (!collections.has(collection)) {
        collections.set(collection, []);
      }
      collections.get(collection)!.push(record);

      return record;
    },

    update: async (id: string, data: Record<string, unknown>) => {
      for (const records of collections.values()) {
        const record = records.find((r) => r.id === id);
        if (record) {
          record.data = { ...record.data, ...data };
          record.updated_at = new Date().toISOString();
          return record;
        }
      }
      throw new Error(`Record not found: ${id}`);
    },

    delete: async (id: string) => {
      for (const records of collections.values()) {
        const record = records.find((r) => r.id === id);
        if (record) {
          record.deleted = true;
          record.updated_at = new Date().toISOString();
          return;
        }
      }
    },

    query: async (collection: string, filter?: Record<string, unknown>) => {
      const records = collections.get(collection) || [];
      return records.filter((r) => {
        if (r.deleted) return false;
        if (!filter) return true;

        for (const [key, value] of Object.entries(filter)) {
          if (r.data[key] !== value) return false;
        }
        return true;
      });
    },

    get: async (collection: string, id: string) => {
      const records = collections.get(collection) || [];
      return records.find((r) => r.id === id && !r.deleted) || null;
    },

    sync: async () => {
      debug('Mock XDB sync (no-op)');
    },
  };
}

/**
 * Create a mock nav module
 */
export function createMockNavModule(onNavigate?: (page: string) => void): NavModule {
  return {
    goto: (page: string) => {
      debug('[SoftN Nav] goto:', page);
      onNavigate?.(page);
    },
    back: () => {
      debug('[SoftN Nav] back');
      if (typeof window !== 'undefined') {
        window.history.back();
      }
    },
    params: {},
  };
}

/**
 * Create a console module that forwards to the browser console
 */
export function createConsoleModule(): ConsoleModule {
  return {
    // eslint-disable-next-line no-console -- this is the console an app's scripts call: their log belongs in the console
    log: (...args: unknown[]) => console.log('[SoftN]', ...args),
    error: (...args: unknown[]) => console.error('[SoftN]', ...args),
    warn: (...args: unknown[]) => console.warn('[SoftN]', ...args),
  };
}
