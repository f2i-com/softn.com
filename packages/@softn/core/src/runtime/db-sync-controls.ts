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
import { applyRoomSecurity, forgetRoomCollections, privateRoomSecret, unmarkRoomShared } from './sync-room-security';
import { readSavedSyncRoom } from './xdb-sync-key';
import { appClosings } from './sync-activity';
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

/**
 * Starts on their way, so that a stop wins over a start made before it. A
 * start waits for the sync module and, for a private room, for its secret
 * (PBKDF2, some tens of milliseconds); a `stopSync` in that time ran first,
 * found no room to close, and the start then opened it. Counted per app and
 * room, and per app for a `stopSync()` of every room, across every surface
 * (the namespace and the renderer's helpers are separate objects).
 */
const roomStarts = new Map<string, number>();
const appStops = new Map<string, number>();

interface StartTicket {
  key: string;
  app: string;
  start: number;
  stops: number;
}

function startTicket(appId: string | undefined, room: string): StartTicket {
  const key = JSON.stringify([appId ?? null, room]);
  const start = (roomStarts.get(key) ?? 0) + 1;
  roomStarts.set(key, start);
  const app = appId ?? '';
  return { key, app, start, stops: appStops.get(app) ?? 0 };
}

function startStillWanted(ticket: StartTicket): boolean {
  return roomStarts.get(ticket.key) === ticket.start && (appStops.get(ticket.app) ?? 0) === ticket.stops;
}

function cancelStarts(appId: string | undefined, room?: string): void {
  if (room === undefined) {
    const app = appId ?? '';
    appStops.set(app, (appStops.get(app) ?? 0) + 1);
    return;
  }
  const key = JSON.stringify([appId ?? null, room]);
  roomStarts.set(key, (roomStarts.get(key) ?? 0) + 1);
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
      if (permissionConfig?.permissions?.sync?.enabled !== true) {
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
      const shared = applyRoomSecurity(syncOpts, { room, appId, permissionConfig, syncEncryptionKeyHex });
      const closings = appClosings(appId);
      const ticket = startTicket(appId, room);
      Promise.all([import('./xdb-sync'), privateRoomSecret(syncOpts, shared)])
        .then(([mod]) => {
          syncModuleCache = mod;
          // The app closed while the module loaded: nothing would close the room.
          if (appClosings(appId) !== closings) return;
          // Stopped, or started again, while the module loaded or the room's
          // secret was worked out: the stop came first, and must hold.
          if (!startStillWanted(ticket)) return;
          mod.startSync(syncOpts as unknown as import('./xdb-sync').XDBSyncOptions);
        })
        .catch((err) => {
          console.error('[XDB Sync] Failed to start sync:', err);
        });
    },

    stopSync: (given) => {
      // No room named is every room, as xdb-sync's stopSync reads it: `''`
      // or `null` (a template's `xdb_stopSync('')`, the worker's bridge)
      // stopped every room there, and here cancelled a start, and forgot the
      // marks, of a room of that name, so a private start still working out
      // its name opened after the stop.
      const room = typeof given === 'string' && given !== '' ? given : undefined;
      cancelStarts(appId, room);
      // A stopped room may be reopened private, or carrying other collections:
      // the shared mark and the list go with it.
      unmarkRoomShared(appId, room);
      forgetRoomCollections(appId, room);
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
