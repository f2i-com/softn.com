/**
 * IndexedDB App Cache — stores .softn bundles for offline/instant reload.
 * Uses the `idb` library for type-safe IndexedDB access.
 */

import { openDB, type IDBPDatabase, type IDBPObjectStore } from 'idb';

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
  /**
   * The app's slug in the site's directory, when it was opened from there.
   * Opening it again from Home then still knows its page, its bundle URL and
   * its server storage.
   */
  directorySlug?: string;
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
/** Set once an open has failed in a way that no retry can mend. */
let dbPermanentlyUnavailable: Error | null = null;
/** After a transient failure, no new open is attempted before this time. */
let dbRetryAfter = 0;

/** How long a transient open failure keeps the cache off before it is tried again. */
const DB_RETRY_BACKOFF_MS = 5_000;

/**
 * Whether an open failure is worth retrying.
 *
 * One failed open used to switch the cache off for the rest of the session:
 * every later call rejected without asking the browser again. That is the
 * right answer for a browser that refuses storage outright — a sandboxed
 * frame, a policy, no IndexedDB at all — and the wrong one for everything
 * else. Firefox reports a private window as a transient failure; a version
 * upgrade blocked by another tab clears when that tab goes; a quota error
 * clears when space does. A Home that showed no apps until reload, after a
 * hiccup that had already passed, was the visible result.
 */
export function classifyIndexedDBFailure(err: unknown): 'permanent' | 'transient' {
  if (typeof indexedDB === 'undefined') return 'permanent';
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  switch (name) {
    case 'SecurityError':
    case 'InvalidStateError':
    case 'NotSupportedError':
      return 'permanent';
    default:
      return 'transient';
  }
}

/**
 * Forget an earlier failure so the next call opens the database again — for a
 * "Try again" the user presses, and for tests. Not called on a timer: the
 * transient case retries by itself once its backoff has passed.
 */
export function resetAppCacheAvailability(): void {
  dbPermanentlyUnavailable = null;
  dbRetryAfter = 0;
  dbPromise = null;
}

function getDB(): Promise<IDBPDatabase<SoftNAppDB>> {
  if (dbPermanentlyUnavailable) {
    return Promise.reject(dbPermanentlyUnavailable);
  }
  if (!dbPromise) {
    if (Date.now() < dbRetryAfter) {
      return Promise.reject(new Error('IndexedDB is not available right now; retrying shortly'));
    }
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
      blocked(currentVersion, blockedVersion) {
        // Another tab still holds an older schema open. The open completes
        // when that tab closes its connection — see `blocking` below, which is
        // the other side of the same handshake.
        console.warn(
          `[SoftN Web] IndexedDB upgrade to v${blockedVersion} is waiting on a tab still using v${currentVersion}`
        );
      },
      blocking(_currentVersion, _blockedVersion, event) {
        // A newer build in another tab wants to upgrade. Holding the
        // connection open would block it forever; closing lets it through,
        // and the next call here reopens at whatever version it left.
        (event.target as IDBDatabase | null)?.close();
        dbPromise = null;
      },
      terminated() {
        // The browser closed the connection underneath us (storage cleared,
        // a crash in the storage process). Reopen on the next call.
        dbPromise = null;
      },
    }).catch((err) => {
      dbPromise = null;
      if (classifyIndexedDBFailure(err) === 'permanent') {
        console.warn('[SoftN Web] IndexedDB unavailable, caching disabled:', err);
        dbPermanentlyUnavailable = err instanceof Error ? err : new Error(String(err));
      } else {
        console.warn(
          `[SoftN Web] IndexedDB open failed; retrying in ${DB_RETRY_BACKOFF_MS / 1000}s:`,
          err
        );
        dbRetryAfter = Date.now() + DB_RETRY_BACKOFF_MS;
      }
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

/** One app, and every build of it the browser is still holding. */
export interface AppVersions {
  name: string;
  /** Most recently opened first; the one the launcher shows. */
  current: CachedApp;
  /** Every build, newest opened first. Length 1 is the ordinary case. */
  versions: CachedApp[];
}

/**
 * Group the cache into one entry per app.
 *
 * Identity is a digest of the bundle, which is what stops a bundle calling
 * itself Notes from reaching the real Notes' data. The cost is that rebuilding
 * an app produces a genuinely different app, so the launcher filled up with
 * cards that all had the same name — every build of a demo sitting beside every
 * other. Both facts are worth keeping: the isolation, and one card per app. So
 * grouping is a presentation decision made here, and says nothing about what any
 * of these builds may read.
 */
export function groupByApp(apps: CachedApp[]): AppVersions[] {
  const groups = new Map<string, CachedApp[]>();
  for (const app of apps) {
    const list = groups.get(app.name);
    if (list) list.push(app);
    else groups.set(app.name, [app]);
  }
  return [...groups.entries()]
    .map(([name, versions]) => {
      const ordered = [...versions].sort((a, b) => b.lastOpened - a.lastOpened);
      return { name, current: ordered[0], versions: ordered };
    })
    .sort((a, b) => b.current.lastOpened - a.current.lastOpened);
}

/**
 * Copy one build's stored data onto another.
 *
 * This is the "bring my data with me" half of an update. Nothing can prove two
 * bundles share an author, so the runtime will not do this by itself — but the
 * person who chose to install the update can say so, and this is what carries
 * their records across. It copies rather than moves, so the older build still
 * has its own data to go back to if the update turns out to be wrong.
 */
export function copyAppData(fromOrigin: string, toOrigin: string): number {
  if (!fromOrigin || !toOrigin || fromOrigin === toOrigin) return 0;
  let copied = 0;
  try {
    const from = `xdb:${fromOrigin}:`;
    const to = `xdb:${toOrigin}:`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(from)) keys.push(key);
    }
    for (const key of keys) {
      const value = localStorage.getItem(key);
      if (value === null) continue;
      localStorage.setItem(to + key.slice(from.length), value);
      copied += 1;
    }
  } catch {
    // Storage unavailable or full — the update still opens, without the data.
  }
  return copied;
}

/** Whether a build has any stored records of its own, i.e. whether it has been used. */
export function hasStoredData(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const prefix = `xdb:${origin}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) return true;
    }
  } catch {
    return false;
  }
  return false;
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
  store: IDBPObjectStore<SoftNAppDB, ['softn-apps'], 'softn-apps', 'readwrite'>,
  name: string,
  origin: string,
): Promise<CachedApp | null> {
  const sameName = await store.index('by-name').getAll(name);
  const legacy = sameName.find((app) => !app.origin);
  if (!legacy) return null;
  const moved = migrateAppStorage(name, origin);
  console.info(
    `[SoftN Web] "${name}" adopted its content identity${moved ? `, moving ${moved} stored keys` : ''}.`,
  );
  // Everything on the legacy record was keyed by a name the bundle chose for
  // itself, so its consent record cannot be carried over: the spread would hand
  // whatever now claims that name the capabilities the user approved for the
  // old one. Data and icon move, approval does not — the app asks again.
  const { grantedPermissions: _dropped, permissionsPromptedAt: _alsoDropped, ...carried } = legacy;
  return { ...carried, origin };
}

/** Cache a new app, or update the one with these exact contents. */
export async function cacheApp(
  bundleData: Uint8Array,
  manifest: { name: string; version: string; description?: string },
  icon?: string,
  directorySlug?: string
): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    const origin = await computeAppOrigin(bundleData);

    // Read and write in one transaction. Split across two, this raced
    // recordPermissionGrant: opening the same app in a second tab read the
    // record before the grant landed, then wrote its stale spread back over
    // it — and the user's Allow was gone, with the bar up again next launch.
    // recordPermissionGrant was made atomic; this is its other half.
    const tx = db.transaction('softn-apps', 'readwrite');
    const store = tx.objectStore('softn-apps');

    // Same bytes as something already cached: the same app, opened again.
    // Matching on origin rather than name is the whole fix — an impostor no
    // longer lands on the record, the grants or the data of the app it names.
    const existing =
      (await store.index('by-origin').get(origin)) ??
      (await adoptLegacyRecord(store, manifest.name, origin));

    if (existing) {
      const updated: CachedApp = {
        ...existing,
        origin,
        version: manifest.version,
        description: manifest.description,
        bundleData,
        lastOpened: Date.now(),
        icon: icon ?? existing.icon,
        directorySlug: directorySlug ?? existing.directorySlug,
      };
      await store.put(updated);
      await tx.done;
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
      directorySlug,
    };
    await store.add(app);
    await tx.done;
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
/**
 * Delete everything one build of an app has stored.
 *
 * Removing a cached app used to drop the record and leave its records behind:
 * keys under an origin nothing referenced any more, which no screen could show
 * and no action could clear. Every removal leaked, and versions accumulating
 * made it worse. Removing a build now removes what it saved.
 */
export function removeAppData(origin: string | undefined): number {
  if (!origin) return 0;
  let removed = 0;
  try {
    const prefix = `xdb:${origin}:`;
    // Collect first: deleting while walking the index skips entries.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      localStorage.removeItem(key);
      removed += 1;
    }
  } catch {
    // Storage unavailable; the cache record still goes.
  }
  return removed;
}

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

/**
 * Record that the user granted these capabilities to the bundle with this origin.
 *
 * Keyed by origin and read-modify-written inside one transaction. Both matter
 * now that consent arrives from a bar the user may click minutes after the app
 * loaded: an `id` captured at load time can point at a record `cacheApp` has
 * since replaced, and a get/put pair in two transactions loses the grant to any
 * `cacheApp` for the same origin that interleaves — silently, so the user is
 * asked again next session having already agreed.
 *
 * Writes nothing if no record exists: the user removed the app from Home while
 * its tab was open, and resurrecting it would undo that. The running instance
 * keeps its grant in memory either way.
 */
export async function recordPermissionGrant(origin: string, perms: Record<string, boolean>): Promise<boolean> {
  try {
    const db = await getDB();
    const tx = db.transaction('softn-apps', 'readwrite');
    const store = tx.objectStore('softn-apps');
    const app = await store.index('by-origin').get(origin);
    if (app) {
      app.grantedPermissions = perms;
      // A grant was recorded. Never "a prompt was shown" — nothing about
      // displaying the consent bar is written down, so dismissing it leaves no
      // trace that could later be mistaken for an answer.
      app.permissionsPromptedAt = Date.now();
      await store.put(app);
    }
    await tx.done;
    return Boolean(app);
  } catch {
    console.warn('[SoftN Web] Failed to record permission grant for origin:', origin);
    return false;
  }
}
