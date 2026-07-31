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
  /**
   * What this app IS, as opposed to what it calls itself: a digest of the
   * bundle's bytes. Absent on records written before identity moved off the
   * manifest name; see adoptLegacyRecord below.
   */
  origin?: string;
}

interface SoftNAppDB {
  'softn-apps': {
    key: string;
    value: CachedApp;
    indexes: { 'by-name': string; 'by-origin': string };
  };
}

/**
 * Derive an app's identity from its contents.
 *
 * Identity used to be `manifest.name`, a string the bundle chooses for itself.
 * The cache upserted on it, permission grants hung off the record it found, and
 * the runtime used it to namespace the app's database — so a bundle that called
 * itself "Notes" was handed the real Notes' stored data, inherited whatever the
 * user had already granted it, and replaced its cached copy. None of that
 * required a flaw to exploit; it was the intended path, taken by an impostor.
 *
 * A digest cannot be claimed, only earned by being the bytes.
 */
export async function computeAppOrigin(bundleData: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    // Copy into a plain ArrayBuffer: a Uint8Array view over a larger buffer
    // would otherwise hash the whole buffer rather than the bundle.
    const bytes = new Uint8Array(bundleData);
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  }
  // crypto.subtle needs a secure context. Without one this keeps apps isolated
  // from each other, which is the point, but it is NOT collision-resistant —
  // someone able to choose bundle bytes could aim at another app's namespace.
  // Serve the runtime over HTTPS or localhost and this branch never runs.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bundleData.length; i++) {
    h1 = Math.imul(h1 ^ bundleData[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 + bundleData[i], 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

// ── Database ─────────────────────────────────────────────────────────

const DB_NAME = 'softn-web';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<SoftNAppDB>> | null = null;
let dbUnavailable = false;

function getDB(): Promise<IDBPDatabase<SoftNAppDB>> {
  if (dbUnavailable) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }
  if (!dbPromise) {
    dbPromise = openDB<SoftNAppDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const store = db.createObjectStore('softn-apps', { keyPath: 'id' });
          store.createIndex('by-name', 'name');
        }
        if (oldVersion < 2) {
          // Records written before this version have no origin. They are not
          // back-filled here — hashing every cached bundle inside an upgrade
          // transaction would block startup — but lazily, the first time each
          // app is opened again. See adoptLegacyRecord.
          tx.objectStore('softn-apps').createIndex('by-origin', 'origin');
        }
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

/**
 * Move an app's stored data from the old name-based namespace to its origin.
 *
 * XDB keys are `xdb:<appId>:<collection>`, and appId used to be the manifest
 * name. Without this, everything a user had saved in an app would be orphaned
 * the moment identity stopped being that name — their notes would still be on
 * disk, under a prefix nothing reads any more.
 */
function migrateAppStorage(fromAppId: string, toAppId: string): number {
  if (fromAppId === toAppId) return 0;
  let moved = 0;
  try {
    const from = `xdb:${fromAppId}:`;
    const to = `xdb:${toAppId}:`;
    // Snapshot the keys first: writing to localStorage while iterating its
    // indices is how you skip half of them.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(from)) keys.push(key);
    }
    for (const key of keys) {
      const value = localStorage.getItem(key);
      if (value === null) continue;
      const target = to + key.slice(from.length);
      // Never clobber data already under the new identity.
      if (localStorage.getItem(target) === null) localStorage.setItem(target, value);
      localStorage.removeItem(key);
      moved += 1;
    }
  } catch {
    // Storage unavailable or full; the app still opens, just without its history.
  }
  return moved;
}

/**
 * Claim a pre-identity record for this bundle, once.
 *
 * A record with this name and no origin was cached before identity moved off
 * the manifest name. The user installed it themselves, so the first bundle to
 * turn up under that name afterwards is overwhelmingly theirs — this is
 * trust-on-first-use, and it is the only point at which a name still confers
 * anything. Every bundle after it gets its own record.
 */
async function adoptLegacyRecord(
  db: IDBPDatabase<SoftNAppDB>,
  name: string,
  origin: string,
): Promise<CachedApp | null> {
  const sameName = await db.getAllFromIndex('softn-apps', 'by-name', name);
  const legacy = sameName.find((app) => !app.origin);
  if (!legacy) return null;
  const moved = migrateAppStorage(name, origin);
  console.info(
    `[SoftN Web] "${name}" adopted its content identity${moved ? `, moving ${moved} stored keys` : ''}.`,
  );
  return { ...legacy, origin };
}

/** Cache a new app, or update the one with these exact contents. */
export async function cacheApp(
  bundleData: Uint8Array,
  manifest: { name: string; version: string; description?: string },
  icon?: string
): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    const origin = await computeAppOrigin(bundleData);

    // Same bytes as something already cached: the same app, opened again.
    // Matching on origin rather than name is the whole fix — an impostor no
    // longer lands on the record, the grants or the data of the app it names.
    const existing =
      (await db.getFromIndex('softn-apps', 'by-origin', origin)) ??
      (await adoptLegacyRecord(db, manifest.name, origin));

    if (existing) {
      const updated: CachedApp = {
        ...existing,
        origin,
        version: manifest.version,
        description: manifest.description,
        bundleData,
        lastOpened: Date.now(),
        icon: icon ?? existing.icon,
      };
      await db.put('softn-apps', updated);
      return updated;
    }

    // A different bundle that happens to share a name is a different app, and is
    // stored as one. Both appear in the launcher; neither can reach the other's
    // data or its granted permissions.
    const app: CachedApp = {
      id: crypto.randomUUID(),
      origin,
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

/**
 * Find a cached app by what it is rather than what it is called.
 *
 * This is the lookup that anything security-relevant must use — a permission
 * grant belongs to the bundle the user approved, not to every bundle that
 * later adopts its name.
 */
export async function getCachedAppByOrigin(origin: string): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    return (await db.getFromIndex('softn-apps', 'by-origin', origin)) ?? null;
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
