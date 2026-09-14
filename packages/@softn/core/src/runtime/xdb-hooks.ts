/**
 * React hooks over XDB: a collection or a record that re-renders on change,
 * and the live storage status. Each resolves its store the same way — the
 * caller's, else the app's from the scope context, else the shared default.
 */

import { useState, useEffect, useCallback, useMemo, useContext } from 'react';
import type { XDBRecord, UseCollectionResult } from '../types';
import { AppScopeContext } from './app-scope-context';
import { getXDB } from './xdb-registry';
import type { XDBService } from './xdb-service';
import type { XDBStorageStatus } from './xdb-types';

/**
 * Live storage status of an XDB instance (audit SN-02): lets an app say
 * "memory only", "damaged collection" or "not loaded" instead of "saved".
 */
export function useXDBStorageStatus(xdb?: XDBService): XDBStorageStatus {
  const scoped = useContext(AppScopeContext)?.xdb;
  const service = xdb ?? scoped ?? getXDB();
  const [status, setStatus] = useState<XDBStorageStatus>(() => service.getStorageStatus());
  useEffect(() => {
    setStatus(service.getStorageStatus());
    return service.subscribeStorage(setStatus);
  }, [service]);
  return status;
}

/**
 * Hook options for useCollection
 */
export interface UseCollectionOptions {
  /** Custom XDB instance to use */
  xdb?: XDBService;
  /** Query filter */
  filter?: Record<string, unknown>;
  /** Sort order */
  sort?: { field: string; order: 'asc' | 'desc' };
  /** Limit results */
  limit?: number;
  /** Skip initial fetch */
  skip?: boolean;
}

/**
 * React hook for accessing an XDB collection with automatic reactivity
 */
export function useCollection(
  collectionName: string,
  options: UseCollectionOptions = {}
): UseCollectionResult {
  // The store of the app this component is rendered in, when a renderer
  // published one; nothing else knows which app a component several levels
  // below the renderer belongs to. Read unconditionally — hook order — and
  // consulted only when the caller named no store, since an explicit option
  // is the caller saying it knows better than the tree it sits in. Below no
  // provider this is the shared default, as before.
  const scoped = useContext(AppScopeContext)?.xdb;
  const xdb = options.xdb ?? scoped ?? getXDB();

  const [records, setRecords] = useState<XDBRecord[]>([]);
  const [loading, setLoading] = useState(!options.skip);
  const [error, setError] = useState<Error | null>(null);

  // Query options
  const queryOptions = useMemo(
    () => ({
      filter: options.filter,
      sort: options.sort,
      limit: options.limit,
    }),
    [options.filter, options.sort, options.limit]
  );

  // Fetch records
  const fetchRecords = useCallback(() => {
    try {
      const data = xdb.query(collectionName, queryOptions);
      setRecords(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [xdb, collectionName, queryOptions]);

  const hasFiltersOrSort = !!(
    queryOptions.filter ||
    queryOptions.sort ||
    queryOptions.limit !== undefined
  );

  // Initial fetch and subscription
  useEffect(() => {
    if (!options.skip) {
      fetchRecords();
    }

    // Subscribe to changes — patch state incrementally when possible,
    // fall back to full re-fetch only when filters/sorts need reapplying
    const unsubscribe = xdb.subscribe(collectionName, (event) => {
      if (event.type === 'refresh' || event.type === 'sync') {
        // Full re-fetch for bulk events
        fetchRecords();
      } else if (hasFiltersOrSort) {
        // Must re-fetch to reapply filters/sort/limit
        fetchRecords();
      } else if (event.type === 'create' && event.record) {
        // Append new record directly
        setRecords((prev) => [...prev, event.record!]);
      } else if (event.type === 'update' && event.record) {
        // Patch updated record in place
        setRecords((prev) => prev.map((r) => r.id === event.record!.id ? event.record! : r));
      } else if (event.type === 'delete' && event.record) {
        // Remove deleted record
        setRecords((prev) => prev.filter((r) => r.id !== event.record!.id));
      } else {
        fetchRecords();
      }
    });

    return unsubscribe;
  }, [xdb, collectionName, options.skip, fetchRecords, hasFiltersOrSort]);

  // Refresh function
  const refresh = useCallback(() => {
    setLoading(true);
    fetchRecords();
  }, [fetchRecords]);

  // Create function
  const create = useCallback(
    async (data: Record<string, unknown>): Promise<XDBRecord> => {
      try {
        const record = xdb.isP2PAvailable()
          ? await xdb.createAsync(collectionName, data)
          : xdb.create(collectionName, data);
        return record;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [xdb, collectionName]
  );

  // Update function
  const update = useCallback(
    async (id: string, data: Record<string, unknown>): Promise<XDBRecord> => {
      try {
        if (xdb.isP2PAvailable()) {
          const record = await xdb.updateAsync(id, data);
          if (!record) {
            throw new Error(`Record ${id} not found in collection ${collectionName}`);
          }
          return record;
        }

        const record = xdb.updateInCollection(collectionName, id, data);
        if (!record) {
          throw new Error(`Record ${id} not found in collection ${collectionName}`);
        }
        return record;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [xdb, collectionName]
  );

  // Remove function
  const remove = useCallback(
    async (id: string): Promise<void> => {
      try {
        if (xdb.isP2PAvailable()) {
          const success = await xdb.deleteAsync(id);
          if (!success) {
            throw new Error(`Record ${id} not found in collection ${collectionName}`);
          }
          return;
        }

        const success = xdb.deleteFromCollection(collectionName, id);
        if (!success) {
          throw new Error(`Record ${id} not found in collection ${collectionName}`);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [xdb, collectionName]
  );

  return {
    records,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
  };
}

/**
 * Hook to get a single record by ID
 */
export function useRecord(
  collectionName: string,
  recordId: string | null,
  options: { xdb?: XDBService } = {}
): { record: XDBRecord | null; loading: boolean; error: Error | null; refresh: () => void } {
  // Same resolution as useCollection: the caller's store, else the app's
  // from context, else the shared default.
  const scoped = useContext(AppScopeContext)?.xdb;
  const xdb = options.xdb ?? scoped ?? getXDB();

  const [record, setRecord] = useState<XDBRecord | null>(null);
  const [loading, setLoading] = useState(!!recordId);
  const [error, setError] = useState<Error | null>(null);

  const fetchRecord = useCallback(() => {
    if (!recordId) {
      setRecord(null);
      setError(null);
      setLoading(false);
      return;
    }

    try {
      const data = xdb.get(collectionName, recordId);
      setRecord(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [xdb, collectionName, recordId]);

  useEffect(() => {
    fetchRecord();

    if (!recordId) return;

    // Subscribe to changes
    const unsubscribe = xdb.subscribe(collectionName, (event) => {
      if (event.type === 'refresh' || event.type === 'sync' || event.record?.id === recordId) {
        fetchRecord();
      }
    });

    return unsubscribe;
  }, [xdb, collectionName, recordId, fetchRecord]);

  return {
    record,
    loading,
    error,
    refresh: fetchRecord,
  };
}

// ============================================================================
// Utility Functions
