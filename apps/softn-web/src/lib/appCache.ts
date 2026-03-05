/**
 * IndexedDB App Cache — stores .softn bundles for offline/instant reload.
 * Uses the `idb` library for type-safe IndexedDB access.
 */

import { openDB, type IDBPDatabase } from 'idb';

// ── Types ────────────────────────────────────────────────────────────

export interface CachedApp {
  id: string;
  name: string;
  version: string;
  description?: string;
  bundleData: Uint8Array;
  cachedAt: number;
  lastOpened: number;
  icon?: string; // Data URL
  grantedPermissions?: Record<string, boolean>;
  permissionsPromptedAt?: number;
}

interface SoftNAppDB {
  'softn-apps': {
    key: string;
    value: CachedApp;
    indexes: { 'by-name': string };
  };
}

// ── Database ─────────────────────────────────────────────────────────

const DB_NAME = 'softn-web';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<SoftNAppDB>> | null = null;
let dbUnavailable = false;

function getDB(): Promise<IDBPDatabase<SoftNAppDB>> {
  if (dbUnavailable) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }
  if (!dbPromise) {
    dbPromise = openDB<SoftNAppDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('softn-apps', { keyPath: 'id' });
        store.createIndex('by-name', 'name');
      },
    }).catch((err) => {
      console.warn('[SoftN Web] IndexedDB unavailable, caching disabled:', err);
      dbUnavailable = true;
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

// ── Public API ───────────────────────────────────────────────────────

/** Get all cached apps, sorted by lastOpened (most recent first) */
export async function getCachedApps(): Promise<CachedApp[]> {
  try {
    const db = await getDB();
    const apps = await db.getAll('softn-apps');
    return apps.sort((a, b) => b.lastOpened - a.lastOpened);
  } catch {
    return [];
  }
}

/** Cache a new app (or update existing by name) */
export async function cacheApp(
  bundleData: Uint8Array,
  manifest: { name: string; version: string; description?: string },
  icon?: string
): Promise<CachedApp | null> {
  try {
    const db = await getDB();

    // Check for existing app with same name — update it instead of duplicating
    const existing = await db.getFromIndex('softn-apps', 'by-name', manifest.name);
    if (existing) {
      const updated: CachedApp = {
        ...existing,
        version: manifest.version,
        description: manifest.description,
        bundleData,
        lastOpened: Date.now(),
        icon: icon ?? existing.icon,
      };
      await db.put('softn-apps', updated);
      return updated;
    }

    const app: CachedApp = {
      id: crypto.randomUUID(),
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      bundleData,
      cachedAt: Date.now(),
      lastOpened: Date.now(),
      icon,
    };
    await db.add('softn-apps', app);
    return app;
  } catch {
    console.warn('[SoftN Web] Failed to cache app:', manifest.name);
    return null;
  }
}

/** Get a single cached app by ID */
export async function getCachedApp(id: string): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    return (await db.get('softn-apps', id)) ?? null;
  } catch {
    return null;
  }
}

/** Remove a cached app */
export async function removeCachedApp(id: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete('softn-apps', id);
  } catch {
    console.warn('[SoftN Web] Failed to remove cached app:', id);
  }
}

/** Get a cached app by name (uses the by-name index) */
export async function getCachedAppByName(name: string): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    return (await db.getFromIndex('softn-apps', 'by-name', name)) ?? null;
  } catch {
    return null;
  }
}

/** Update the lastOpened timestamp */
export async function updateLastOpened(id: string): Promise<void> {
  try {
    const db = await getDB();
    const app = await db.get('softn-apps', id);
    if (app) {
      app.lastOpened = Date.now();
      await db.put('softn-apps', app);
    }
  } catch {
    // Non-critical, ignore
  }
}

/** Update granted permissions for a cached app */
export async function updateGrantedPermissions(appId: string, perms: Record<string, boolean>): Promise<void> {
  try {
    const db = await getDB();
    const app = await db.get('softn-apps', appId);
    if (app) {
      app.grantedPermissions = perms;
      app.permissionsPromptedAt = Date.now();
      await db.put('softn-apps', app);
    }
  } catch {
    console.warn('[SoftN Web] Failed to update granted permissions for app:', appId);
  }
}
