/**
 * IndexedDB App Cache — stores .softn bundles for offline/instant reload.
 * Uses the `idb` library for type-safe IndexedDB access.
 *
 * Everything the runtime and its tests use of the cache is imported from
 * here; the parts live beside it:
 *
 * - appCacheDb: the record kept for each cached build, and the one
 *   IndexedDB connection every read and write shares.
 * - appCacheIdentity: an app's content identity (the digest its records and
 *   grants belong to) and the id of the shell build that is running.
 * - appCacheStorage: an app's stored data in localStorage, counted, copied,
 *   moved and removed as one unit per build.
 * - appCacheSnapshot: that data as a file, exported and imported whole or
 *   not at all.
 * - appCacheAdoption: records cached under an earlier identity scheme.
 * - appCacheRecords: the cached apps: listing, caching, lookups, and the
 *   writes that land on a record later.
 */

export type { CachedApp, OfflineState } from './appCacheDb';
export { classifyIndexedDBFailure, resetAppCacheAvailability } from './appCacheDb';

export {
  abbreviateOrigin,
  buildIdFromEntry,
  computeAppOrigin,
  currentBuildId,
  isOfflineReady,
  isSecureAppOrigin,
} from './appCacheIdentity';

export type { AppDataStore, DataTransferResult } from './appCacheStorage';
export { appDataStores, copyAppData, hasStoredData, removeAppData, transferStorageKeys } from './appCacheStorage';

export type { AppDataSnapshot, SnapshotRead } from './appCacheSnapshot';
export {
  exportAppData,
  importAppData,
  readAppDataSnapshot,
  recoverInterruptedImports,
  replaceStorageKeys,
  snapshotEntryCount,
} from './appCacheSnapshot';

export type { AppVersions } from './appCacheRecords';
export {
  cacheApp,
  getCachedApp,
  getCachedAppByName,
  getCachedAppByOrigin,
  getCachedApps,
  groupByApp,
  recordPermissionGrant,
  removeCachedApp,
  setOfflineState,
  updateLastOpened,
} from './appCacheRecords';
