/**
 * The cached apps themselves: listing and grouping them, caching an opened
 * bundle (adopting an older record of it on the way), lookups by id, name
 * and origin, and the writes that land on a record later: last opened,
 * offline state, a grant. Re-exported by ./appCache.
 */

import { randomUUID } from '@softn/bundle-format/crypto';
import { getDB, type CachedApp, type OfflineState } from './appCacheDb';
import { computeAppOrigin, isSecureAppOrigin } from './appCacheIdentity';
import { applyAdoption, findLegacyAdoption, findLegacyUpgrade, findShortOriginAdoption, type Adoption } from './appCacheAdoption';

// ── Records ──────────────────────────────────────────────────────────

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

/** Cache a new app, or update the one with these exact contents. */
export async function cacheApp(
  bundleData: Uint8Array,
  manifest: { name: string; version: string; description?: string },
  icon?: string,
  directorySlug?: string,
  requestedCapabilities?: string[]
): Promise<CachedApp | null> {
  // The manifest is the bundle's, read as it came: a description written as
  // `{ "en": "…" }` was stored as that and blanked Home when it was drawn.
  const description = typeof manifest.description === 'string' ? manifest.description : undefined;
  try {
    const db = await getDB();
    const origin = await computeAppOrigin(bundleData);

    // Everything that hashes happens here, before the transaction: an
    // IndexedDB transaction commits as soon as nothing is pending on it, so
    // an `await` on crypto inside one would leave the later `put` with a
    // transaction that had already closed. Each candidate is re-read and
    // checked inside the transaction before it is acted on.
    let adoption: Adoption | null = null;
    let legacyUpgrade: (Adoption & { toOrigin: string }) | null = null;
    const already = await db.getFromIndex('softn-apps', 'by-origin', origin);
    if (!already) {
      adoption = (await findShortOriginAdoption(db, origin)) ?? (await findLegacyAdoption(db, manifest.name, origin));
      if (!adoption) legacyUpgrade = await findLegacyUpgrade(db, manifest.name);
    }

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
    let existing = await store.index('by-origin').get(origin);
    if (!existing && adoption) existing = (await applyAdoption(store, adoption, origin)) ?? undefined;

    if (existing) {
      const updated: CachedApp = {
        ...existing,
        origin,
        version: manifest.version,
        description,
        bundleData,
        lastOpened: Date.now(),
        icon: icon ?? existing.icon,
        directorySlug: directorySlug ?? existing.directorySlug,
        requestedCapabilities: requestedCapabilities ?? existing.requestedCapabilities,
      };
      await store.put(updated);
      await tx.done;
      return updated;
    }

    // A legacy record shares this name but not these bytes. It keeps its
    // data and gets an identity of its own; this bundle is cached beside it.
    if (legacyUpgrade) {
      const upgraded = await applyAdoption(store, legacyUpgrade, legacyUpgrade.toOrigin);
      if (upgraded) await store.put(upgraded);
    }

    // A different bundle that happens to share a name is a different app, and is
    // stored as one. Both appear in the launcher; neither can reach the other's
    // data or its granted permissions.
    const app: CachedApp = {
      id: randomUUID(),
      origin,
      name: manifest.name,
      version: manifest.version,
      description,
      bundleData,
      cachedAt: Date.now(),
      lastOpened: Date.now(),
      icon,
      directorySlug,
      requestedCapabilities,
    };
    await store.add(app);
    await tx.done;
    return app;
  } catch (err) {
    console.warn('[SoftN Web] Failed to cache app:', manifest.name, err);
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

export async function removeCachedApp(id: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete('softn-apps', id);
  } catch {
    console.warn('[SoftN Web] Failed to remove cached app:', id);
  }
}

/**
 * A cached app by name: the most recently opened of any that share it.
 *
 * For the one place a name is all there is — the address bar, offline, with
 * `/app/<name>` and no directory to ask. Never for anything that decides what
 * an app may read; that is getCachedAppByOrigin.
 */
export async function getCachedAppByName(name: string): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    const matches = await db.getAllFromIndex('softn-apps', 'by-name', name);
    if (matches.length === 0) return null;
    return matches.sort((a, b) => b.lastOpened - a.lastOpened)[0];
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
 * Record what an offline install established for one record.
 *
 * Read-modify-written inside one transaction, for the same reason as
 * recordPermissionGrant below: an install finishes seconds after the open
 * that started it, and cacheApp or a grant may have rewritten the record in
 * between — a get/put pair in two transactions would write the older copy
 * back over theirs. Writes nothing if the record is gone (the app was removed
 * from Home while it was installing), and never throws: the install's
 * outcome is shown from memory either way.
 */
export async function setOfflineState(id: string, state: OfflineState): Promise<boolean> {
  try {
    const db = await getDB();
    const tx = db.transaction('softn-apps', 'readwrite');
    const store = tx.objectStore('softn-apps');
    const app = await store.get(id);
    if (app) {
      app.offline = state;
      await store.put(app);
    }
    await tx.done;
    return Boolean(app);
  } catch {
    console.warn('[SoftN Web] Failed to record offline state for app:', id);
    return false;
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
 *
 * Writes nothing for an identity computed without a cryptographic hash (an
 * insecure context). A grant is durable trust in exactly these bytes, and an
 * identity that other bytes could be made to share cannot carry it; the bar
 * asks again next session, which is the honest outcome.
 */
export async function recordPermissionGrant(origin: string, perms: Record<string, boolean>): Promise<boolean> {
  if (!isSecureAppOrigin(origin)) {
    console.warn('[SoftN Web] Not remembering a grant for an app identified without a secure context; it will be asked again next time.');
    return false;
  }
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
