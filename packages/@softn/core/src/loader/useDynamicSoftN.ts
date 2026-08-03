/**
 * useDynamicSoftN - React hook for dynamically loading .softn files
 *
 * This hook loads .softn files from disk at runtime and watches for changes,
 * enabling hot reload without rebuilding the app.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { parse } from '../parser';
import type { SoftNDocument } from '../parser/ast';

interface TauriInvoke {
  (cmd: 'read_softn_file', args: { path: string }): Promise<string>;
  (cmd: 'watch_softn_files', args: { dir: string }): Promise<void>;
  (cmd: 'stop_watching'): Promise<void>;
}

interface TauriEvent<T> {
  payload: T;
}

interface FileChangePayload {
  path: string;
  kind: 'create' | 'modify' | 'remove';
}

// Check if we're running in Tauri - cached result
let _isTauriCached: boolean | null = null;
function isTauri(): boolean {
  if (_isTauriCached === null) {
    _isTauriCached = typeof window !== 'undefined' && '__TAURI__' in window;
  }
  return _isTauriCached;
}

// Get Tauri invoke function
function getTauriInvoke(): TauriInvoke | null {
  if (!isTauri()) return null;
  // @ts-expect-error - Tauri globals
  return window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
}

// Get Tauri event listener
function getTauriListen():
  | ((event: string, handler: (e: TauriEvent<FileChangePayload>) => void) => Promise<() => void>)
  | null {
  if (!isTauri()) return null;
  // @ts-expect-error - Tauri globals
  return window.__TAURI__?.event?.listen;
}

export interface UseDynamicSoftNOptions {
  /** Path to the .softn file */
  filePath: string;
  /** Enable file watching for hot reload */
  watch?: boolean;
  /** Debounce time in ms for file change events (default: 100) */
  debounceMs?: number;
  /** Callback when file changes */
  onChange?: (document: SoftNDocument) => void;
  /** Callback on error */
  onError?: (error: Error) => void;
  /** Callback when loading starts */
  onLoadStart?: () => void;
}

export interface UseDynamicSoftNResult {
  /** The parsed SoftN document */
  document: SoftNDocument | null;
  /** The raw source code */
  source: string | null;
  /** Loading state */
  loading: boolean;
  /** Error state */
  error: Error | null;
  /** Manually reload the file */
  reload: () => Promise<void>;
  /** Whether we're running in Tauri */
  isTauriApp: boolean;
  /** Number of times the file has been reloaded */
  reloadCount: number;
  /** Last reload timestamp */
  lastReload: number | null;
}

/**
 * Hook to dynamically load and watch .softn files at runtime
 */
export function useDynamicSoftN(options: UseDynamicSoftNOptions): UseDynamicSoftNResult {
  const { filePath, watch = true, debounceMs = 100, onChange, onError, onLoadStart } = options;

  const [document, setDocument] = useState<SoftNDocument | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [lastReload, setLastReload] = useState<number | null>(null);

  // Use refs for callbacks to avoid recreating loadFile
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const onLoadStartRef = useRef(onLoadStart);
  const mountedRef = useRef(true);
  const currentFilePathRef = useRef(filePath);
  const requestGenerationRef = useRef(0);
  const initiallyLoadedPathRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update during render, before effects run. If an old read resolves in the
  // gap between rendering a new path and starting its effect, the path check
  // below already knows that result is stale.
  currentFilePathRef.current = filePath;

  // Update refs when callbacks change
  useEffect(() => {
    onChangeRef.current = onChange;
    onErrorRef.current = onError;
    onLoadStartRef.current = onLoadStart;
  }, [onChange, onError, onLoadStart]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isTauriApp = isTauri();

  // Load the file - stable callback that doesn't depend on onChange/onError
  const loadFile = useCallback(async () => {
    const requestPath = filePath;
    const generation = ++requestGenerationRef.current;
    const isCurrentRequest = () =>
      mountedRef.current &&
      requestGenerationRef.current === generation &&
      currentFilePathRef.current === requestPath;

    const invoke = getTauriInvoke();
    if (!invoke) {
      if (isCurrentRequest()) {
        setError(new Error('Not running in Tauri environment'));
        setLoading(false);
      }
      return;
    }

    try {
      if (isCurrentRequest()) {
        setLoading(true);
        setError(null);
        onLoadStartRef.current?.();
      }

      const content = await invoke('read_softn_file', { path: requestPath });

      if (!isCurrentRequest()) return;

      setSource(content);

      const doc = parse(content);
      setDocument(doc);
      setReloadCount((c) => c + 1);
      setLastReload(Date.now());
      onChangeRef.current?.(doc);
    } catch (err) {
      if (!isCurrentRequest()) return;
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      onErrorRef.current?.(error);
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
      }
    }
  }, [filePath]); // Only depends on filePath

  // Debounced load for file watch events
  const debouncedLoad = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    debounceTimerRef.current = setTimeout(() => {
      loadFile();
      debounceTimerRef.current = null;
    }, debounceMs);
  }, [loadFile, debounceMs]);

  // Initial load and file watching setup
  useEffect(() => {
    if (!isTauriApp) {
      setLoading(false);
      return;
    }

    // StrictMode may run this effect twice for the same path, but a genuinely
    // new path must be read. A single boolean permanently suppressed every
    // load after the first file, leaving the hook's document/source stale.
    if (initiallyLoadedPathRef.current !== filePath) {
      initiallyLoadedPathRef.current = filePath;
      void loadFile();
    }

    if (!watch) return;

    const listen = getTauriListen();
    const invoke = getTauriInvoke();
    if (!listen || !invoke) return;

    // Tauri reports normalized paths even when the caller uses a Windows path.
    // Normalize before deriving the directory as well as before comparisons;
    // otherwise `C:\project\main.ui` incorrectly watches `.`.
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const lastSlash = normalizedFilePath.lastIndexOf('/');
    const dir =
      lastSlash < 0 ? '.' : lastSlash === 0 ? '/' : normalizedFilePath.substring(0, lastSlash);

    // Skip watching if the path looks invalid (contains ..)
    if (dir.includes('..')) {
      console.warn('[SoftN] Skipping file watching - path contains "..":', dir);
      return;
    }

    // Start watching - silently handle errors since bundled source works as fallback
    invoke('watch_softn_files', { dir }).catch((err) => {
      console.warn('[SoftN] File watching not available:', err);
    });

    let disposed = false;
    let effectUnlisten: (() => void) | null = null;

    // Listen for file changes. Registration is asynchronous, so both the
    // callback and the eventual unlisten handle belong to this effect run.
    void listen('softn-file-change', (event) => {
      // A callback retained by a late/stale registration must not start the old
      // path's load: doing so increments the shared request generation and can
      // invalidate the current path's in-flight read before it finishes.
      if (disposed || currentFilePathRef.current !== filePath) return;

      const { path, kind } = event.payload;
      // Normalize paths for comparison
      const normalizedPath = path.replace(/\\/g, '/');

      if (normalizedPath === normalizedFilePath || normalizedPath.endsWith(normalizedFilePath)) {
        if (kind === 'modify' || kind === 'create') {
          console.log(`[SoftN] File changed: ${path}`);
          debouncedLoad();
        }
      }
    })
      .then((unlisten) => {
        if (disposed) {
          // Cleanup already ran while registration was pending. Release the
          // newly-created listener immediately instead of leaking it.
          unlisten();
          return;
        }
        effectUnlisten = unlisten;
      })
      .catch((err) => {
        if (!disposed) {
          console.warn('[SoftN] File change listener not available:', err);
        }
      });

    return () => {
      disposed = true;
      effectUnlisten?.();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      invoke('stop_watching').catch(console.error);
    };
  }, [filePath, watch, isTauriApp, debouncedLoad, loadFile]);

  return {
    document,
    source,
    loading,
    error,
    reload: loadFile,
    isTauriApp,
    reloadCount,
    lastReload,
  };
}

/**
 * Hook to list all .softn files in a directory
 */
export function useSoftNFiles(directory: string): {
  files: string[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) {
      if (mountedRef.current) {
        setError(new Error('Not running in Tauri environment'));
        setLoading(false);
      }
      return;
    }

    try {
      if (mountedRef.current) {
        setLoading(true);
        setError(null);
      }
      const result = await invoke('read_softn_file', { path: directory });
      if (mountedRef.current) {
        setFiles(Array.isArray(result) ? result : []);
      }
    } catch (err) {
      if (mountedRef.current) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [directory]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { files, loading, error, refresh };
}
