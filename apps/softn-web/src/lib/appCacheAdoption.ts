/**
 * Records cached under an earlier identity scheme (a manifest name, a
 * sixteen-character digest) and how a bundle claims or upgrades one. Used by
 * cacheApp in ./appCacheRecords.
 */

import type { IDBPDatabase, IDBPObjectStore } from 'idb';
import { carryAppSync, debug } from '@softn/core';
import type { CachedApp, SoftNAppDB } from './appCacheDb';
import { SHORT_ORIGIN_LENGTH, computeAppOrigin, isSecureAppOrigin } from './appCacheIdentity';
import { migrateAppStorage } from './appCacheStorage';

// ── Adoption of older records ────────────────────────────────────────

export type AppStore = IDBPObjectStore<SoftNAppDB, ['softn-apps'], 'softn-apps', 'readwrite'>;

/**
 * What the pre-transaction look-around found: a record written under an
 * earlier identity scheme that these bytes may claim. Hashing is
 * asynchronous, and an IndexedDB transaction commits the moment nothing is
 * pending on it, so every digest is computed before the transaction opens
 * and the record is read again inside it before anything is written.
 */
export interface Adoption {
  /** The record as it was when found; re-read and compared before use. */
  record: CachedApp;
  /** The identity its stored data lives under today. */
  fromAppId: string;
  /** Carry the consent record across? Only where the bytes are provably the same. */
  carryGrants: boolean;
  why: string;
}

function sameRecord(a: CachedApp, b: CachedApp | undefined): boolean {
  return Boolean(b) && a.id === b!.id && a.origin === b!.origin && a.cachedAt === b!.cachedAt && a.bundleData.byteLength === b!.bundleData.byteLength;
}

/**
 * A record from before identity existed, which these exact bytes may claim.
 *
 * A record with this name and no origin was cached before identity moved off
 * the manifest name. The user installed it themselves, so a bundle turning up
 * under that name afterwards is probably theirs — but "probably" was doing
 * too much work: adoption used to go to the first bundle to arrive with the
 * name, whatever its bytes, and it took the old record's stored data with it.
 * A name is not authority. Now the cached bytes are hashed and only the same
 * bytes adopt the record; different bytes are a different app, cached beside
 * it, and the legacy record is upgraded to its own digest identity so the
 * launcher can offer its data through the explicit "bring my data forward"
 * flow, where the person who installed both can say they are related.
 */
export async function findLegacyAdoption(db: IDBPDatabase<SoftNAppDB>, name: string, origin: string): Promise<Adoption | null> {
  const sameName = await db.getAllFromIndex('softn-apps', 'by-name', name);
  const legacy = sameName.find((app) => !app.origin);
  if (!legacy) return null;
  const legacyOrigin = await computeAppOrigin(legacy.bundleData);
  if (legacyOrigin === origin) {
    return { record: legacy, fromAppId: name, carryGrants: false, why: 'adopted its content identity' };
  }
  return null;
}

/**
 * Give a name-keyed legacy record an identity of its own, without adopting it.
 *
 * Called when a different bundle has arrived under the legacy record's name:
 * the record cannot stay name-keyed, because the next bundle with that name
 * would try to adopt it too, and it cannot be handed to this bundle. Its data
 * moves from the name namespace to its own digest's, so it is reachable by
 * the launcher's version chips and its data-transfer flow. Grants are dropped
 * as they always were on adoption: they were keyed by a name.
 */
export async function findLegacyUpgrade(db: IDBPDatabase<SoftNAppDB>, name: string): Promise<(Adoption & { toOrigin: string }) | null> {
  const sameName = await db.getAllFromIndex('softn-apps', 'by-name', name);
  const legacy = sameName.find((app) => !app.origin);
  if (!legacy) return null;
  const legacyOrigin = await computeAppOrigin(legacy.bundleData);
  return { record: legacy, fromAppId: name, carryGrants: false, why: 'was given its own identity', toOrigin: legacyOrigin };
}

/**
 * A record keyed by the sixteen-character digest earlier versions kept.
 *
 * The full digest of these bytes starts with that prefix, and the record's
 * own bytes hash to the full digest too, so this is the same app under a
 * shorter name for itself. Its data and its grants come across: the user
 * approved these bytes, and these are the bytes.
 */
export async function findShortOriginAdoption(db: IDBPDatabase<SoftNAppDB>, origin: string): Promise<Adoption | null> {
  if (!isSecureAppOrigin(origin) || origin.length <= SHORT_ORIGIN_LENGTH) return null;
  const short = origin.slice(0, SHORT_ORIGIN_LENGTH);
  const candidate = await db.getFromIndex('softn-apps', 'by-origin', short);
  if (!candidate) return null;
  const full = await computeAppOrigin(candidate.bundleData);
  if (full !== origin) return null;
  return { record: candidate, fromAppId: short, carryGrants: true, why: 'kept under its full digest' };
}

/**
 * Apply an adoption inside the write transaction: re-read the record, make
 * sure it is the one that was examined, move its data, and return the record
 * to write under the new identity. Returns null if the record changed in the
 * meantime or its data could not be moved, in which case the caller treats
 * the bundle as new and the old record is left exactly as it was.
 */
export async function applyAdoption(store: AppStore, adoption: Adoption, origin: string): Promise<CachedApp | null> {
  const current = await store.get(adoption.record.id);
  if (!sameRecord(adoption.record, current)) return null;
  const moved = migrateAppStorage(adoption.fromAppId, origin);
  if (!moved.ok) {
    console.warn(`[SoftN Web] "${current!.name}" keeps its earlier identity: ${moved.error}`);
    return null;
  }
  // Its sync rooms' keys go with its records: left under the old identity,
  // the app no longer went back to its room. The keys move before this
  // returns; the old identity's room caches are deleted after, unawaited,
  // as nothing may hold this write transaction open. From a manifest's name
  // they are copied and nothing is deleted: sync's keys are found by what
  // they begin with, and a name may begin another app's (`Notes` and
  // `Notes:Pro`, whose rooms' keys and caches the move took). A short digest
  // (the one adoption that carries grants) begins no other identity.
  void carryAppSync(adoption.fromAppId, origin, { move: adoption.carryGrants });
  debug(
    `[SoftN Web] "${current!.name}" ${adoption.why}${moved.copied ? `, moving ${moved.copied} stored keys` : ''}.`
  );
  if (adoption.carryGrants) return { ...current!, origin };
  // Everything on a name-keyed record was keyed by a name the bundle chose
  // for itself, so its consent record cannot be carried over: the spread
  // would hand whatever now claims that name the capabilities the user
  // approved for the old one. Data and icon move, approval does not — the
  // app asks again.
  const { grantedPermissions: _dropped, permissionsPromptedAt: _alsoDropped, ...carried } = current!;
  return { ...carried, origin };
}
