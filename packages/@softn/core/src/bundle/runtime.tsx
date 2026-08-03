/**
 * SoftN Bundle Runtime
 *
 * Loads and executes .softn bundles, handling imports between files,
 * asset loading, and XDB data initialization.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { SoftNBundle, BundleFile } from './types';
import { readBundle, readBundleFromFile, readBundleFromUrl, seedXDBBundleData } from './bundle';
import { parse } from '../parser';
import { renderDocument } from '../renderer';
import { getDefaultRegistry } from '../renderer/registry';
import { getXDB } from '../runtime/xdb';
import { builtinHelpers } from '../runtime/helpers';
import type { SoftNRenderContext, SoftNDocument } from '../types';
import { parseStatePath } from '../runtime/state-path';
import { classifyAsset } from './asset-classification';

// ============================================================================
// Bundle Runtime
// ============================================================================

/**
 * Runtime context for a loaded bundle
 */
export interface BundleRuntime {
  /** The loaded bundle */
  bundle: SoftNBundle;
  /** Get a file's content */
  getFile: (path: string) => BundleFile | undefined;
  /** Get an asset URL */
  getAssetUrl: (path: string) => string;
  /** Resolve an import path */
  resolveImport: (from: string, importPath: string) => string;
  /** Parse a .ui file */
  parseUI: (path: string) => SoftNDocument;
  /** Execute a .logic file and get exports */
  executeLogic: (path: string) => LogicExports;
  /** Initialize XDB with bundled data */
  initializeXDB: (signal?: AbortSignal) => Promise<void>;
  /** Render the main entry point */
  render: (context?: Partial<SoftNRenderContext>) => React.ReactNode;
  /** Dispose of all resources (blob URLs, caches) */
  dispose: () => void;
}

/**
 * Exports from a .logic file
 */
export interface LogicExports {
  state: Record<string, unknown>;
  functions: Record<string, (...args: unknown[]) => unknown>;
  computed: Record<string, () => unknown>;
}

type WindowAssetResolver = (path: string) => string;
type SoftNAssetWindow = typeof window & { __softnAsset?: WindowAssetResolver };
const activeWindowAssetResolvers: WindowAssetResolver[] = [];
let previousWindowAssetResolver: WindowAssetResolver | undefined;

function registerWindowAssetResolver(resolver: WindowAssetResolver): void {
  if (typeof window === 'undefined') return;
  const hostWindow = window as SoftNAssetWindow;
  const existingIndex = activeWindowAssetResolvers.indexOf(resolver);
  if (existingIndex !== -1) activeWindowAssetResolvers.splice(existingIndex, 1);
  if (activeWindowAssetResolvers.length === 0) {
    previousWindowAssetResolver = hostWindow.__softnAsset;
  }
  activeWindowAssetResolvers.push(resolver);
  hostWindow.__softnAsset = resolver;
}

function unregisterWindowAssetResolver(resolver: WindowAssetResolver): void {
  if (typeof window === 'undefined') return;
  const hostWindow = window as SoftNAssetWindow;
  const index = activeWindowAssetResolvers.indexOf(resolver);
  if (index === -1) return;
  const wasCurrent = hostWindow.__softnAsset === resolver;
  activeWindowAssetResolvers.splice(index, 1);
  if (wasCurrent) {
    const next = activeWindowAssetResolvers.at(-1);
    if (next) hostWindow.__softnAsset = next;
    else if (previousWindowAssetResolver) hostWindow.__softnAsset = previousWindowAssetResolver;
    else delete hostWindow.__softnAsset;
  }
  if (activeWindowAssetResolvers.length === 0) previousWindowAssetResolver = undefined;
}

/**
 * Create a runtime from a loaded bundle
 */
export function createBundleRuntime(bundle: SoftNBundle): BundleRuntime {
  // Cache for parsed documents
  const documentCache = new Map<string, SoftNDocument>();
  // Cache for executed logic
  const logicCache = new Map<string, LogicExports>();
  // Object URLs for assets
  const assetUrls = new Map<string, string>();
  const windowAssetResolver: WindowAssetResolver = (path) => getAssetUrl(path);

  /**
   * Get a file from the bundle
   */
  function getFile(path: string): BundleFile | undefined {
    // Normalize path
    const normalizedPath = normalizePath(path);
    return bundle.files.get(normalizedPath);
  }

  /**
   * Get an asset URL (creates object URL for binary assets)
   */
  function getAssetUrl(path: string): string {
    const normalizedPath = normalizePath(path);

    // Check cache
    if (assetUrls.has(normalizedPath)) {
      return assetUrls.get(normalizedPath)!;
    }

    const file = bundle.files.get(normalizedPath);
    if (!file) {
      console.warn(`Asset not found: ${path}`);
      return '';
    }

    // Create object URL for binary data
    const content = file.content;
    if (content instanceof Uint8Array) {
      const mimeType = getMimeType(normalizedPath);
      // Create a new ArrayBuffer copy to ensure type compatibility
      const buffer = new ArrayBuffer(content.byteLength);
      new Uint8Array(buffer).set(content);
      const blob = new Blob([buffer], { type: mimeType });
      const url = URL.createObjectURL(blob);
      assetUrls.set(normalizedPath, url);
      return url;
    }

    // For text content, create a data URL
    const mimeType = getMimeType(normalizedPath);
    let base64: string;
    try {
      base64 = btoa(content as string);
    } catch {
      // btoa fails on non-Latin1 chars; encode via TextEncoder + Uint8Array
      const bytes = new TextEncoder().encode(content as string);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      base64 = btoa(binary);
    }
    const dataUrl = `data:${mimeType};base64,${base64}`;
    assetUrls.set(normalizedPath, dataUrl);
    return dataUrl;
  }

  /**
   * Resolve an import path relative to the importing file
   */
  function resolveImport(from: string, importPath: string): string {
    // Handle absolute paths
    if (importPath.startsWith('/')) {
      return importPath.slice(1);
    }

    // Handle relative paths
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      const fromDir = from.includes('/') ? from.substring(0, from.lastIndexOf('/')) : '';
      const parts = [...fromDir.split('/').filter(Boolean), ...importPath.split('/')];
      const resolved: string[] = [];

      for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') {
          resolved.pop();
        } else {
          resolved.push(part);
        }
      }

      return resolved.join('/');
    }

    // Handle named imports from manifest
    if (bundle.manifest.imports?.[importPath]) {
      return bundle.manifest.imports[importPath];
    }

    // Return as-is (external import)
    return importPath;
  }

  /**
   * Parse a .ui file into a SoftN document
   */
  function parseUI(path: string): SoftNDocument {
    const normalizedPath = normalizePath(path);

    // Check cache
    if (documentCache.has(normalizedPath)) {
      return documentCache.get(normalizedPath)!;
    }

    const file = bundle.files.get(normalizedPath);
    if (!file) {
      throw new Error(`UI file not found: ${path}`);
    }

    const content = file.content as string;

    // Parse the UI file - it's essentially a SoftN document without the outer tags
    // We need to wrap it in a document structure
    let source = content;

    // If it's a pure .ui file (not a full .softn), wrap it
    if (!content.includes('<logic>') && !content.includes('<script>')) {
      // Check for associated .logic file
      const logicPath = normalizedPath.replace('.ui', '.logic');
      const logicFile = bundle.files.get(logicPath);

      if (logicFile) {
        source = `<logic>\n${logicFile.content}\n</logic>\n${content}`;
      }
    }

    const doc = parse(source);
    documentCache.set(normalizedPath, doc);
    return doc;
  }

  /**
   * Execute a .logic file and return its exports
   */
  function executeLogic(path: string): LogicExports {
    const normalizedPath = normalizePath(path);

    // Check cache
    if (logicCache.has(normalizedPath)) {
      return logicCache.get(normalizedPath)!;
    }

    const file = bundle.files.get(normalizedPath);
    if (!file) {
      throw new Error(`Logic file not found: ${path}`);
    }

    const logicInfo = bundle.logicFiles.get(normalizedPath);

    // Create exports object
    const exports: LogicExports = {
      state: logicInfo?.exports.state || {},
      functions: {},
      computed: {},
    };

    // For now, we return the parsed state
    // Full execution would require the script runtime
    logicCache.set(normalizedPath, exports);
    return exports;
  }

  /**
   * Initialize XDB with bundled data
   */
  async function initializeXDB(signal?: AbortSignal): Promise<void> {
    const xdb = getXDB();
    // Desktop XDB hydrates from SQLite asynchronously. Seeding before it is
    // ready can mistake a persisted tombstone for a missing row and upsert the
    // bundled live copy over it.
    await xdb.isReady;
    if (signal?.aborted) return;

    for (const [, data] of bundle.xdbData) {
      if (signal?.aborted) return;
      seedXDBBundleData(xdb, data);
    }
  }

  /**
   * Render the main entry point
   */
  function render(contextOverrides: Partial<SoftNRenderContext> = {}): React.ReactNode {
    const mainPath = bundle.manifest.main;
    const doc = parseUI(mainPath);
    registerWindowAssetResolver(windowAssetResolver);
    const runtimeHelpers = {
      ...(builtinHelpers as Record<string, (...args: unknown[]) => unknown>),
      asset: (path: unknown) => getAssetUrl(String(path || '')),
    };

    // Build context
    const context: SoftNRenderContext = {
      state: {},
      setState: () => {},
      data: {},
      props: {},
      computed: {},
      functions: runtimeHelpers,
      asyncFunctions: runtimeHelpers,
      ...contextOverrides,
    };
    if (contextOverrides.functions) {
      context.functions = { ...runtimeHelpers, ...contextOverrides.functions };
    }
    if (contextOverrides.asyncFunctions) {
      context.asyncFunctions = { ...runtimeHelpers, ...contextOverrides.asyncFunctions };
    }

    // Render
    return renderDocument(doc, context, getDefaultRegistry());
  }

  /**
   * Dispose of all resources: revoke blob URLs, clear caches
   */
  function dispose(): void {
    unregisterWindowAssetResolver(windowAssetResolver);
    for (const [, url] of assetUrls) {
      // Only revoke blob: URLs (not data: URLs)
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    }
    assetUrls.clear();
    documentCache.clear();
    logicCache.clear();
  }

  return {
    bundle,
    getFile,
    getAssetUrl,
    resolveImport,
    parseUI,
    executeLogic,
    initializeXDB,
    render,
    dispose,
  };
}

// ============================================================================
// React Component for Bundle Rendering
// ============================================================================

export interface SoftNBundleRendererProps {
  /** Bundle data as Uint8Array */
  data?: Uint8Array;
  /** URL to load bundle from */
  url?: string;
  /** File path to load bundle from (Tauri/Node) */
  filePath?: string;
  /** Pre-loaded bundle */
  bundle?: SoftNBundle;
  /** Props to pass to the app */
  props?: Record<string, unknown>;
  /** Initial state */
  initialState?: Record<string, unknown>;
  /** Loading component */
  loading?: React.ReactNode;
  /** Error component */
  error?: (error: Error) => React.ReactNode;
  /** Callback when bundle loads */
  onLoad?: (runtime: BundleRuntime) => void;
}

/**
 * React component that loads and renders a .softn bundle
 */
export function SoftNBundleRenderer({
  data,
  url,
  filePath,
  bundle: preloadedBundle,
  props = {},
  initialState = {},
  loading: loadingComponent,
  error: errorComponent,
  onLoad,
}: SoftNBundleRendererProps): React.ReactElement | null {
  const [runtime, setRuntime] = useState<BundleRuntime | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // A caller may provide an inline callback. Keep the latest callback without
  // making its identity a bundle source dependency (which would reload and
  // reinitialize the bundle on every parent render).
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  // State management
  const [componentState, setComponentState] = useState<Record<string, unknown>>(initialState);

  const setState = useCallback((path: string, value: unknown) => {
    setComponentState((prev) => {
      const parts = parseStatePath(path);
      const newState = { ...prev };
      let current: Record<string, unknown> = newState;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!(part in current) || typeof current[part] !== 'object') {
          current[part] = {};
        }
        current[part] = { ...(current[part] as Record<string, unknown>) };
        current = current[part] as Record<string, unknown>;
      }

      current[parts[parts.length - 1]] = value;
      return newState;
    });
  }, []);

  // Load bundle
  useEffect(() => {
    let disposed = false;
    let loadedRuntime: BundleRuntime | null = null;
    const abortController = new AbortController();

    async function loadBundle() {
      try {
        setIsLoading(true);
        setError(null);

        let bundle: SoftNBundle;

        if (preloadedBundle) {
          bundle = preloadedBundle;
        } else if (data) {
          bundle = await readBundle(data);
        } else if (url) {
          bundle = await readBundleFromUrl(url, { signal: abortController.signal });
        } else if (filePath) {
          bundle = await readBundleFromFile(filePath);
        } else {
          throw new Error('No bundle source provided');
        }

        const rt = createBundleRuntime(bundle);

        // The source may have changed (or the component may have unmounted)
        // while the bundle was being read. Never publish an orphaned runtime;
        // dispose it before it can initialize bundled data in the wrong app.
        if (disposed) {
          rt.dispose();
          return;
        }

        loadedRuntime = rt;
        // Initialize XDB with bundled data only after this load has won.
        await rt.initializeXDB(abortController.signal);
        if (disposed || abortController.signal.aborted) {
          rt.dispose();
          loadedRuntime = null;
          return;
        }
        setRuntime(rt);
        onLoadRef.current?.(rt);
      } catch (err) {
        loadedRuntime?.dispose();
        loadedRuntime = null;
        if (!disposed) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!disposed) {
          setIsLoading(false);
        }
      }
    }

    void loadBundle();

    // The runtime is local to this effect run. Reading it from React state here
    // captured the value from before the async load (normally null), so unmount
    // never disposed the runtime that the effect eventually created.
    return () => {
      disposed = true;
      abortController.abort();
      loadedRuntime?.dispose();
    };
  }, [data, url, filePath, preloadedBundle]);

  // Build render context
  const context = useMemo<SoftNRenderContext>(() => {
    const runtimeHelpers = {
      ...(builtinHelpers as Record<string, (...args: unknown[]) => unknown>),
      asset: (path: unknown) => (runtime ? runtime.getAssetUrl(String(path || '')) : ''),
    };
    return {
      state: componentState,
      setState,
      data: {},
      props,
      computed: {},
      functions: runtimeHelpers,
      asyncFunctions: runtimeHelpers,
    };
  }, [componentState, setState, props, runtime]);

  // Loading state
  if (isLoading) {
    return loadingComponent ? (
      <>{loadingComponent}</>
    ) : (
      <div style={{ padding: '1rem', textAlign: 'center' }}>Loading bundle...</div>
    );
  }

  // Error state
  if (error) {
    return errorComponent ? (
      <>{errorComponent(error)}</>
    ) : (
      <div style={{ padding: '1rem', color: 'red' }}>
        <h3>Bundle Error</h3>
        <pre>{error.message}</pre>
      </div>
    );
  }

  // Render
  if (runtime) {
    try {
      return <>{runtime.render(context)}</>;
    } catch (err) {
      const renderError = err instanceof Error ? err : new Error(String(err));
      return errorComponent ? (
        <>{errorComponent(renderError)}</>
      ) : (
        <div style={{ padding: '1rem', color: 'red' }}>
          <h3>Render Error</h3>
          <pre>{renderError.message}</pre>
        </div>
      );
    }
  }

  return null;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Normalize a file path
 */
function normalizePath(path: string): string {
  // Remove leading slash
  if (path.startsWith('/')) {
    path = path.slice(1);
  }
  // Normalize separators
  path = path.replace(/\\/g, '/');
  // Remove duplicate slashes
  path = path.replace(/\/+/g, '/');
  return path;
}

/**
 * Get MIME type from file extension
 */
function getMimeType(path: string): string {
  // The map that lived here was one of four private copies, and the only one
  // with no model formats at all. The shared registry answers for every
  // reader; unknown extensions come back as application/octet-stream.
  return classifyAsset(path).mime;
}

// ============================================================================
// Hook for using bundles
// ============================================================================

/**
 * React hook for loading and using a .softn bundle
 */
export function useSoftNBundle(source: { data?: Uint8Array; url?: string; filePath?: string }): {
  runtime: BundleRuntime | null;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
} {
  const [runtime, setRuntime] = useState<BundleRuntime | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      setLoading(true);
      setError(null);
      // A new source supersedes the previous runtime immediately. Keeping it
      // here after an empty or failed source load exposed a disposed/stale app
      // alongside the new error to hook consumers.
      setRuntime(null);

      let bundle: SoftNBundle;

      if (source.data) {
        bundle = await readBundle(source.data);
      } else if (source.url) {
        bundle = await readBundleFromUrl(source.url, { signal: abortController.signal });
      } else if (source.filePath) {
        bundle = await readBundleFromFile(source.filePath);
      } else {
        throw new Error('No bundle source provided');
      }

      const rt = createBundleRuntime(bundle);

      // A newer source or reload won while this request was awaiting I/O.
      // Dispose the orphan before it can initialize bundled XDB data or replace
      // the winner.
      if (requestId !== requestIdRef.current) {
        rt.dispose();
        return;
      }
      try {
        await rt.initializeXDB(abortController.signal);
      } catch (error) {
        rt.dispose();
        throw error;
      }
      if (requestId !== requestIdRef.current || abortController.signal.aborted) {
        rt.dispose();
        return;
      }
      setRuntime(rt);
    } catch (err) {
      if (requestId === requestIdRef.current && !abortController.signal.aborted) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        if (abortRef.current === abortController) abortRef.current = null;
        setLoading(false);
      }
    }
  }, [source.data, source.url, source.filePath]);

  const cancelPendingLoad = useCallback(() => {
    requestIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    void load();
    return cancelPendingLoad;
  }, [load, cancelPendingLoad]);

  // Separate cleanup effect that tracks `runtime` — avoids stale closure
  // where the cleanup closes over the initial null state.
  useEffect(() => {
    return () => {
      if (runtime) {
        runtime.dispose();
      }
    };
  }, [runtime]);

  return {
    runtime,
    loading,
    error,
    reload: load,
  };
}
