/**
 * The four sync methods of the `db` namespace — `startSync`, `stopSync`,
 * `getSyncStatus`, `getSavedSyncRoom` — built once, for every surface that
 * offers them.
 *
 * The script runtime's `createDBNamespace` and the renderer's
 * `createXDBHelpers` each carried their own copy of these, and the copies
 * drifted: one remembered a sticky shared-room flag the other never read
 * (see sync-room-security.ts). They differ in one thing only, which the
 * caller supplies — what happens when the bundle may not sync: the namespace
 * logs and returns (a `.logic` script cannot catch a host refusal), the
 * renderer helper throws (its callers can). Everything else — the permission
 * gate, the host-bound options, the signalling-server egress rules, the wire
 * scope, the key — is one path.
 *
 * The sync module is loaded lazily and cached here, so `getSyncStatus` works
 * whichever surface started the room.
 */

import { bindSyncOptions } from './host-bound-sync-options';
import { filterSignalingUrls } from './egress-policy';
import { applyRoomSecurity, unmarkRoomShared } from './sync-room-security';
import { readSavedSyncRoom } from './xdb-sync-key';
import type { PermissionConfig } from './script-runtime';

type SyncModule = typeof import('./xdb-sync');

let syncModuleCache: SyncModule | null = null;

/** The loaded sync module, once any surface has started a room; null before. */
export function getSyncModuleCache(): SyncModule | null {
  return syncModuleCache;
}

export function setSyncModuleCache(mod: SyncModule): void {
  syncModuleCache = mod;
}

export interface SyncStatusShape {
  connected: boolean;
  peers: number;
  room: string;
  peerId: string;
}

const IDLE_STATUS: SyncStatusShape = { connected: false, peers: 0, room: '', peerId: '' };

export interface SyncControls {
  startSync: (room: string, options?: Record<string, unknown>) => void;
  stopSync: (room?: string) => void;
  getSyncStatus: (room?: string) => SyncStatusShape;
  getSavedSyncRoom: () => string | null;
}

export interface SyncControlsOptions {
  /** The host's identity for the app. */
  appId?: string;
  /** Read at call time: consent can arrive after the namespace was built. */
  getPermissionConfig: () => PermissionConfig | null | undefined;
  /** The host's per-user key for private rooms, when this surface offers one. */
  syncEncryptionKeyHex?: string;
  /**
   * Called instead of starting when the bundle may not sync: `pending` while
   * the user has not answered the consent bar, `denied` when permission.json
   * does not ask for sync (or the bundle ships none). Log or throw; the
   * refusal texts stay each surface's own.
   */
  refuse: (reason: 'pending' | 'denied') => void;
}

export function createSyncControls(options: SyncControlsOptions): SyncControls {
  const { appId, getPermissionConfig, syncEncryptionKeyHex, refuse } = options;
  return {
    startSync: (room, requested) => {
      const permissionConfig = getPermissionConfig();
      // `permissionConfig?.permissions && !…sync?.enabled` short-circuited to
      // false when the config was absent, so the one path that starts WebRTC
      // replication of the whole database opened itself for exactly the
      // bundles the rest of the model trusts least. An absent config is a
      // refusal, as checkPermission('sync') has always answered.
      if (!permissionConfig?.permissions?.sync?.enabled) {
        refuse(permissionConfig?.consentPending ? 'pending' : 'denied');
        return;
      }
      // The host's identity and the room the script named go on last: options
      // may request behaviour, never say which app they are.
      const syncOpts = bindSyncOptions(room, requested, appId);
      // A signalling server the script chose is a host it reaches: the same
      // `net` rules as a fetch. Refused ones fall back to the host's defaults.
      if (syncOpts.signaling !== undefined) {
        const { allowed, refused } = filterSignalingUrls(syncOpts.signaling, permissionConfig);
        for (const { url, reason } of refused) console.error(`[XDB Sync] Signalling server refused: ${url} — ${reason}`);
        if (allowed.length > 0) syncOpts.signaling = allowed;
        else delete syncOpts.signaling;
      }
      applyRoomSecurity(syncOpts, { room, appId, permissionConfig, syncEncryptionKeyHex });
      import('./xdb-sync')
        .then((mod) => {
          syncModuleCache = mod;
          mod.startSync(syncOpts as unknown as import('./xdb-sync').XDBSyncOptions);
        })
        .catch((err) => {
          console.error('[XDB Sync] Failed to start sync:', err);
        });
    },

    stopSync: (room) => {
      // A stopped room may be reopened private: the shared mark goes with it.
      unmarkRoomShared(appId, room);
      import('./xdb-sync')
        .then(({ stopSync }) => {
          stopSync(room, appId);
        })
        .catch((err) => {
          console.error('[XDB Sync] Failed to stop sync:', err);
        });
    },

    getSyncStatus: (room) => {
      if (!syncModuleCache) return { ...IDLE_STATUS };
      // This app's adapter, not whichever app happens to be in that room.
      const adapter = syncModuleCache.getSyncAdapter(room, appId);
      return adapter ? adapter.getStatus() : { ...IDLE_STATUS };
    },

    getSavedSyncRoom: () => readSavedSyncRoom(appId),
  };
}
