/**
 * A page's records: the hook that reads its `<data>` block's collections from
 * XDB and keeps them current, the `db` helpers its handlers are given, and
 * SoftNWithXDB, which renders a page with both.
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { SoftNRenderer, useSoftN, useStructurallyStableValue, type SoftNRendererProps } from './SoftNRenderer';
import type { PermissionConfig } from '../runtime/script-runtime';
import { createSyncControls, type SyncControls } from '../runtime/db-sync-controls';
import { describeHostAllowlist } from '../runtime/egress-policy';
import { getXDB } from '../runtime/xdb';
import { readSavedSyncRoom } from '../runtime/xdb-sync-key';
import type { SoftNDocument } from '../parser/ast';
import { debug } from '../runtime/debug';

/**
 * Hook to handle data blocks and subscribe to XDB collections
 *
 * This processes the <data> block from a SoftN document and sets up
 * subscriptions to the specified collections.
 *
 * Supports filter, sort, and limit options:
 * <collection name="tasks" as="tasks" filter={{ completed: false }} sort="createdAt:desc" limit={10} />
 */
export function useDataBlock(
  document: SoftNDocument | null,
  appId?: string
): {
  data: Record<string, import('../types').XDBRecord[]>;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  xdb: ReturnType<typeof getXDB>;
} {
  const xdb = getXDB(appId);
  const [collections, setCollections] = useState<Record<string, import('../types').XDBRecord[]>>(
    {}
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDataSignatureRef = useRef('');
  const readGenerationRef = useRef(0);

  // Extract collection declarations from document
  const collectionDefs = useMemo(() => {
    if (!document?.data?.collections) return [];
    return document.data.collections.map((c) => ({
      name: c.name,
      as: c.as,
      filter: c.filter,
      sort: c.sort,
      limit: c.limit,
    }));
  }, [document]);

  // Each XDB/document pairing gets an identity that never repeats, even if a
  // caller switches A -> B -> A. Async refreshes capture this token and may
  // only publish while it is still the committed source. A layout effect makes
  // the hand-off atomic with the commit, before stale records can be painted.
  const dataSourceToken = useMemo(() => ({ xdb, collectionDefs }), [xdb, collectionDefs]);
  const activeDataSourceTokenRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    activeDataSourceTokenRef.current = dataSourceToken;
    lastDataSignatureRef.current = '';
    setCollections({});
    setError(null);

    return () => {
      if (activeDataSourceTokenRef.current === dataSourceToken) {
        activeDataSourceTokenRef.current = null;
      }
    };
  }, [dataSourceToken]);

  // Build a signature to detect actual data changes (avoids unnecessary re-renders)
  const buildDataSignature = useCallback(
    (data: Record<string, import('../types').XDBRecord[]>): string => {
      const keys = Object.keys(data).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const records = data[key] || [];
        // Every record contributes. Sampling only the first and last meant an
        // edit to any record between them produced an identical signature, so
        // the collection was judged unchanged and nothing re-rendered — editing
        // an item in the middle of a list did nothing on screen.
        //
        // Folded into a rolling hash (FNV-1a) rather than concatenated, so the
        // signature stays short for a large collection.
        let hash = 0x811c9dc5;
        for (const record of records) {
          const field = `${record.id}\u0000${record.updated_at || ''}\u0001`;
          for (let i = 0; i < field.length; i++) {
            hash ^= field.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
          }
        }
        parts.push(`${key}:${records.length}:${(hash >>> 0).toString(36)}`);
      }
      return parts.join('|');
    },
    []
  );

  /**
   * Fetch all collections synchronously (browser) or async (Tauri P2P).
   * Returns the data or null if nothing changed.
   * This is a plain function — NOT wrapped in useCallback — to avoid
   * stale closure issues with React.StrictMode double-invocation.
   */
  const doFetch = useCallback(
    async (
      defs: typeof collectionDefs
    ): Promise<Record<string, import('../types').XDBRecord[]> | null> => {
      if (defs.length === 0) return null;

      const data: Record<string, import('../types').XDBRecord[]> = {};
      const isP2P = xdb.isP2PAvailable();

      for (const def of defs) {
        // Build query options
        const queryOptions: { filter?: Record<string, unknown> } = {};

        // Evaluate filter expression if present
        if (def.filter) {
          if (def.filter.type === 'ObjectExpression') {
            const filterObj: Record<string, unknown> = {};
            for (const prop of (def.filter as import('../parser/ast').ObjectExpression)
              .properties) {
              // A filter is literal fields only; `...other` has nothing to read here.
              if (prop.type === 'SpreadElement') continue;
              if (prop.value.type === 'Literal') {
                filterObj[prop.key] = (
                  prop.value as import('../parser/ast').LiteralExpression
                ).value;
              } else if (prop.value.type === 'Identifier') {
                filterObj[prop.key] = (
                  prop.value as import('../parser/ast').IdentifierExpression
                ).name;
              }
            }
            queryOptions.filter = filterObj;
          }
        }

        // Fetch records
        let records: import('../types').XDBRecord[];
        if (isP2P) {
          records = queryOptions.filter
            ? await xdb.queryAsync(def.name, queryOptions)
            : await xdb.getAllAsync(def.name);
        } else {
          records = queryOptions.filter ? xdb.query(def.name, queryOptions) : xdb.getAll(def.name);
        }

        // Apply sorting if specified
        if (def.sort && Array.isArray(records)) {
          const [field, order] = def.sort.split(':');
          const sortOrder = order === 'desc' ? -1 : 1;
          records = [...records].sort((a, b) => {
            const aVal = a.data[field] ?? a[field as keyof typeof a];
            const bVal = b.data[field] ?? b[field as keyof typeof b];
            if (aVal < bVal) return -1 * sortOrder;
            if (aVal > bVal) return 1 * sortOrder;
            return 0;
          });
        }

        // Apply limit if specified
        if (def.limit && Array.isArray(records)) {
          records = records.slice(0, def.limit);
        }

        data[def.as] = records;
      }

      return data;
    },
    [xdb]
  );

  // Initial, manual and subscription reads share one ordering boundary. Source
  // identity alone cannot stop a slow earlier read of the SAME collection from
  // replacing a newer result (or restoring an obsolete error/loading state).
  const readCollections = useCallback((defs: typeof collectionDefs, initial = false) => {
    const sourceToken = dataSourceToken;
    if (activeDataSourceTokenRef.current !== sourceToken || defs.length === 0) return;
    const generation = ++readGenerationRef.current;
    const isCurrentRead = () =>
      activeDataSourceTokenRef.current === sourceToken &&
      readGenerationRef.current === generation;
    if (initial) setLoading(true);
    doFetch(defs)
      .then((data) => {
        if (!isCurrentRead() || !data) return;
        const signature = buildDataSignature(data);
        if (signature !== lastDataSignatureRef.current) {
          lastDataSignatureRef.current = signature;
          setCollections(data);
        }
        // Recovery is meaningful even when the records themselves did not change.
        setError(null);
      })
      .catch((err) => {
        if (!isCurrentRead()) return;
        console.error('[useDataBlock] Error fetching collections:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (isCurrentRead()) setLoading(false);
      });
  }, [doFetch, buildDataSignature, dataSourceToken]);

  // Public refresh uses the latest definitions without changing identity on
  // ordinary renders. The reader still verifies its committed source token.
  const collectionDefsRef = useRef(collectionDefs);
  collectionDefsRef.current = collectionDefs;
  const refresh = useCallback(() => {
    readCollections(collectionDefsRef.current);
  }, [readCollections]);

  // Initial fetch + subscribe to changes.
  // Runs when collectionDefs or xdb changes.
  useEffect(() => {
    let cancelled = false;
    const sourceToken = dataSourceToken;
    const isCurrentSource = () => !cancelled && activeDataSourceTokenRef.current === sourceToken;

    if (collectionDefs.length > 0) {
      readCollections(collectionDefs, true);
    } else {
      setLoading(false);
    }

    // Subscribe to changes in all collections (debounced refresh)
    const unsubscribes: (() => void)[] = [];
    for (const def of collectionDefs) {
      const unsubscribe = xdb.subscribe(def.name, () => {
        if (!isCurrentSource()) return;
        // Debounce high-frequency event bursts from sync
        if (refreshTimerRef.current) {
          clearTimeout(refreshTimerRef.current);
        }
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          if (isCurrentSource()) {
            readCollections(collectionDefs);
          }
        }, 120);
      });
      unsubscribes.push(unsubscribe);
    }

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [xdb, collectionDefs, readCollections, dataSourceToken]);

  return {
    data: collections,
    loading,
    error,
    refresh,
    xdb,
  };
}

/** The sync controls in the `(...args) => unknown` shape every helper here has. */
function wrapSyncControls(controls: SyncControls): Record<string, (...args: unknown[]) => unknown> {
  return {
    startSync: (...args: unknown[]) => controls.startSync(args[0] as string, args[1] as Record<string, unknown> | undefined),
    stopSync: (...args: unknown[]) => controls.stopSync(args[0] as string | undefined),
    getSyncStatus: (...args: unknown[]) => controls.getSyncStatus(args[0] as string | undefined),
    getSavedSyncRoom: () => controls.getSavedSyncRoom(),
  };
}

/**
 * XDB helper functions to expose in the render context
 * These are synchronous wrappers that work with the XDB service
 * All functions are typed to match the SoftN function signature for compatibility
 */
export function createXDBHelpers(
  xdb: ReturnType<typeof getXDB>,
  syncEncryptionKeyHex?: string,
  appId?: string,
  /**
   * The bundle's permission.json. Omitting it denies sync, which is deliberate:
   * a caller that has not said the app may replicate its database to peers has
   * not established that the user agreed to it.
   */
  permissionConfig?: PermissionConfig
): Record<string, (...args: unknown[]) => unknown> {
  return {
    /**
     * Create a new record in a collection
     */
    create: (...args: unknown[]) => {
      const collection = args[0] as string;
      const data = args[1] as Record<string, unknown>;
      return xdb.create(collection, data);
    },

    /**
     * Update an existing record
     */
    update: (...args: unknown[]) => {
      const id = args[0] as string;
      const data = args[1] as Record<string, unknown>;
      return xdb.update(id, data);
    },

    /**
     * Delete a record (soft delete)
     */
    delete: (...args: unknown[]) => {
      const id = args[0] as string;
      return xdb.delete(id);
    },

    /**
     * Get all records from a collection
     */
    getAll: (...args: unknown[]) => {
      const collection = args[0] as string;
      return xdb.getAll(collection);
    },

    /**
     * Query records with optional filter
     */
    query: (...args: unknown[]) => {
      const collection = args[0] as string;
      const filter = args[1] as Record<string, unknown> | undefined;
      return xdb.query(collection, filter ? { filter } : undefined);
    },

    /**
     * Get a single record by ID
     */
    get: (...args: unknown[]) => {
      const collection = args[0] as string;
      const id = args[1] as string;
      return xdb.get(collection, id);
    },

    /**
     * Get the count of records in a collection
     */
    count: (...args: unknown[]) => {
      const collection = args[0] as string;
      return xdb.count(collection);
    },

    /**
     * Clear all records from a collection
     */
    clear: (...args: unknown[]) => {
      const collection = args[0] as string;
      xdb.clear(collection);
    },

    /**
     * Trigger a sync (placeholder for future P2P sync)
     */
    sync: () => {
      return xdb.sync();
    },

    // The sync methods are one implementation shared with the script runtime's
    // db namespace (db-sync-controls.ts): same gate, same host-bound options,
    // same signalling rules, same wire scope and key. `sync` is gated here
    // rather than through checkPermission because these helpers are reached
    // from the renderer, not the host-call path; the callers here can catch,
    // so a refusal throws, and it speaks to the user who has not pressed Allow
    // rather than telling them to edit a file inside the bundle.
    ...wrapSyncControls(
      createSyncControls({
        appId,
        getPermissionConfig: () => permissionConfig ?? null,
        syncEncryptionKeyHex,
        refuse: (reason) => {
          if (reason === 'pending') {
            throw new Error(
              'Sync not permitted yet: this app has asked to use your other devices and you ' +
                'have not allowed it. Choose Allow in the permission bar at the top of the app.'
            );
          }
          throw new Error(
            'Sync not permitted: declare { "permissions": { "sync": { "enabled": true } } } ' +
              "in the bundle's permission.json so the user can approve it."
          );
        },
      })
    ),

    getDbPath: () => {
      return xdb.getDbPath();
    },
  };
}

/**
 * Enhanced SoftN Renderer with built-in XDB support
 *
 * This component extends SoftNRenderer by automatically processing
 * <data> blocks and making collection data available in the render context.
 */
export interface SoftNWithXDBProps extends SoftNRendererProps {
  /**
   * Callback when XDB data changes
   */
  onDataChange?: (data: Record<string, import('../types').XDBRecord[]>) => void;

  /**
   * Server sync URL (e.g. "ws://localhost:3000/sync").
   * When provided, connects to a softn-server instance for real-time data sync.
   */
  serverUrl?: string;

  /**
   * Auth token for server sync.
   */
  serverToken?: string;

  /**
   * Collections to sync with the server.
   */
  serverCollections?: string[];

  /**
   * Hex-encoded encryption key for P2P XDB sync.
   * When set, all sync signaling is encrypted with this key.
   */
  syncEncryptionKeyHex?: string;
}

export function SoftNWithXDB({
  source,
  onDataChange,
  serverUrl,
  serverToken,
  serverCollections,
  syncEncryptionKeyHex,
  ...props
}: SoftNWithXDBProps): React.ReactElement | null {
  const stablePermissionConfig = useStructurallyStableValue(props.permissionConfig);
  const stableServerCollections = useStructurallyStableValue(serverCollections);
  const consentPending = stablePermissionConfig?.consentPending === true;

  // Parse the document to get data block
  const { document } = useSoftN(source);

  // Set up XDB data subscriptions based on data block (per-app isolation)
  const { data: xdbData, xdb } = useDataBlock(document, props.appId);

  // Create XDB helpers for the functions prop
  const xdbHelpers = useMemo(
    () => createXDBHelpers(xdb, syncEncryptionKeyHex, props.appId, stablePermissionConfig),
    [xdb, syncEncryptionKeyHex, props.appId, stablePermissionConfig]
  );

  // Log per-app database path on mount
  useEffect(() => {
    xdb.getDbPath().then((path) => {
      if (path) {
        debug(`[XDB] App "${xdb.getAppId() || '_default'}" database: ${path}`);
      }
    });
  }, [xdb]);

  // Server sync: connect to softn-server when serverUrl is provided
  useEffect(() => {
    if (!serverUrl) return;
    // `manifest.config.server.url` is a host the bundle chose, and connecting
    // to it replicates the app's collections to it. No entry in permission.json
    // describes that, so it never appears in the consent bar's list and
    // withholding the capabilities cannot touch it — the socket opened while
    // the bar still said nothing had been granted. Held on consent state
    // directly. The flag is a dependency, so the grant re-runs this effect and
    // the socket opens then, with no reload.
    if (consentPending) return;
    // And held to a declaration. The socket replicates the app's database to
    // the server and through it to other devices, which is what
    // permission.json's `sync` declares and the consent bar names, and a
    // bundle that declared nothing, or shipped no permission.json, opened it
    // with no one asked. The same rule as peer sync (db-sync-controls.ts).
    if (stablePermissionConfig?.permissions?.sync?.enabled !== true) {
      console.warn(
        '[SoftN] Server sync not started: this app names a sync server (config.server.url in manifest.json) ' +
          'and its permission.json does not declare sync. Add { "permissions": { "sync": { "enabled": true } } } ' +
          'so the person can see it and allow it.'
      );
      return;
    }
    // The bundle chose this host. If it also scoped itself to a host list, the
    // same list `softn.net.fetch` is held to applies here: a manifest must not
    // be a way past permission.json.
    const destination = describeHostAllowlist(serverUrl, stablePermissionConfig?.permissions?.net);
    if (!destination.allowed) {
      console.error(`[SoftN] Server sync refused: ${destination.reason}`);
      return;
    }
    let sync: import('../runtime/xdb-server-sync').XDBServerSync | null = null;
    let stale = false;
    import('../runtime/xdb-server-sync')
      .then(({ XDBServerSync }) => {
        // Guard against StrictMode double-mount: the async import may resolve
        // after the first mount's cleanup has already run.
        if (stale) return;
        sync = new XDBServerSync(xdb, {
          wsUrl: serverUrl,
          appVersion: '1.0.0',
          token: serverToken,
          collections: stableServerCollections,
        });
        // Listeners first.
        //
        // `connect()` can fail synchronously — a non-localhost `ws://` URL is
        // rejected outright, with no reconnect — and it reports that by calling
        // the error listeners immediately. Registering afterwards meant the
        // message was delivered to an empty array: no console output, no UI
        // state, no retry. The app looked completely normal and simply never
        // synced.
        sync.on('error', (err: unknown) => {
          console.warn('[SoftN] Server sync error:', err);
        });
        sync.connect();
      })
      .catch((err: unknown) => {
        // The module failed to load (a stale deployment's chunk, a network
        // drop) or the client refused its options. Either way the app runs
        // unsynced, and the one line that says so is this one: it used to be
        // swallowed, and the app looked normal and never synced.
        console.warn('[SoftN] Server sync could not start:', err);
      });
    return () => {
      stale = true;
      sync?.disconnect();
    };
  }, [xdb, serverUrl, serverToken, stableServerCollections, consentPending, stablePermissionConfig]);

  // Auto-resume sync from localStorage on mount
  const syncResumedAppRef = useRef<string | null>(null);

  // No room is closed here at mount. One used to be: the app's saved room,
  // left open by a previous mount, since nothing closed an app's rooms when
  // it closed. They close with it now (sync-activity.ts), so a room open at
  // mount is another view's of this app, in use; and asking meant fetching
  // the sync chunk (195 KB, yjs with it) on every open of an app that had
  // ever synced.

  // Auto-resume sync only when explicitly opted in (resumeSavedSyncRoom === true).
  useEffect(() => {
    if (!props.resumeSavedSyncRoom) {
      // Toggling the option back on should make a fresh resume attempt.
      syncResumedAppRef.current = null;
      return;
    }
    const appKey = props.appId ?? '_default';
    if (syncResumedAppRef.current === appKey) return;
    syncResumedAppRef.current = appKey;
    try {
      const savedRoom = readSavedSyncRoom(props.appId);
      // Whether the saved room is a shared one (a host set it up on the app's
      // behalf, or the app started it shared) is the sync controls' decision,
      // made from the same flags for every path — see sync-room-security.ts.
      // A shared room must not take the per-user key, or different users
      // would join different signalling rooms and never discover each other.
      if (savedRoom) xdbHelpers.startSync(savedRoom);
    } catch {
      // localStorage may be unavailable in restricted contexts
    }
  }, [xdbHelpers, props.appId, props.resumeSavedSyncRoom]);

  // Notify parent of data changes
  useEffect(() => {
    onDataChange?.(xdbData);
  }, [xdbData, onDataChange]);

  // Subscribe to server-synced collections so that when XDBServerSync delivers
  // data (via upsertFromServer), we detect it and force initialData to change,
  // which triggers _onDataChange() in SoftNRenderer for script-managed state.
  const [serverSyncVersion, setServerSyncVersion] = useState(0);
  useEffect(() => {
    if (!stableServerCollections || stableServerCollections.length === 0) return;
    const unsubscribes: (() => void)[] = [];
    for (const collection of stableServerCollections) {
      const unsub = xdb.subscribe(collection, () => {
        setServerSyncVersion((v) => v + 1);
      });
      unsubscribes.push(unsub);
    }
    return () => unsubscribes.forEach((fn) => fn());
  }, [xdb, stableServerCollections]);

  // Merge XDB data with initial data
  // serverSyncVersion forces a new reference when server sync data arrives,
  // even if useDataBlock has no <collection> declarations to track.
  const mergedData = useMemo(
    () => ({
      ...props.initialData,
      ...xdbData,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.initialData, xdbData, serverSyncVersion]
  );

  // Merge XDB functions with provided functions
  // XDB operations are exposed as individual functions with xdb_ prefix
  const mergedFunctions = useMemo(
    () => ({
      xdb_create: xdbHelpers.create,
      xdb_update: xdbHelpers.update,
      xdb_delete: xdbHelpers.delete,
      xdb_getAll: xdbHelpers.getAll,
      xdb_query: xdbHelpers.query,
      xdb_get: xdbHelpers.get,
      xdb_count: xdbHelpers.count,
      xdb_clear: xdbHelpers.clear,
      xdb_sync: xdbHelpers.sync,
      xdb_startSync: xdbHelpers.startSync,
      xdb_stopSync: xdbHelpers.stopSync,
      xdb_getSyncStatus: xdbHelpers.getSyncStatus,
      xdb_getSavedSyncRoom: xdbHelpers.getSavedSyncRoom,
      xdb_getDbPath: xdbHelpers.getDbPath,
      ...props.functions,
    }),
    [xdbHelpers, props.functions]
  );

  return (
    <SoftNRenderer
      {...props}
      source={source}
      initialData={mergedData}
      functions={mergedFunctions}
      // The instance the data block subscribed to, so the forms below write
      // where the markup reads.
      xdb={xdb}
    />
  );
}
