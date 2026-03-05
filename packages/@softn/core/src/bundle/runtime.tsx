/**
 * SoftN Bundle Runtime
 *
 * Loads and executes .softn bundles, handling imports between files,
 * asset loading, and XDB data initialization.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { SoftNBundle, BundleFile } from './types';
import { readBundle, readBundleFromFile, readBundleFromUrl } from './bundle';
import { parse } from '../parser';
import { renderDocument } from '../renderer';
import { getDefaultRegistry } from '../renderer/registry';
import { getXDB } from '../runtime/xdb';
import { builtinHelpers } from '../runtime/helpers';
import type { SoftNRenderContext, SoftNDocument } from '../types';

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
  initializeXDB: () => void;
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
    const dataUrl = `data:${mimeType};base64,${btoa(content as string)}`;
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
    // Full execution would require the FormLogic runtime
    logicCache.set(normalizedPath, exports);
    return exports;
  }

  /**
   * Initialize XDB with bundled data
   */
  function initializeXDB(): void {
    const xdb = getXDB();

    for (const [, data] of bundle.xdbData) {
      // Create records from bundled data
      for (const record of data.records) {
        // Check if record already exists
        const existing = xdb.get(data.collection, record.id);
        if (!existing) {
          // Create record with bundled data
          xdb.create(data.collection, record.data);
        }
      }
    }
  }

  /**
   * Render the main entry point
   */
  function render(contextOverrides: Partial<SoftNRenderContext> = {}): React.ReactNode {
    const mainPath = bundle.manifest.main;
    const doc = parseUI(mainPath);
    if (typeof window !== 'undefined') {
      (window as typeof window & { __softnAsset?: (path: string) => string }).__softnAsset = (
        path: string
      ) => getAssetUrl(path);
    }
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

  // State management
  const [componentState, setComponentState] = useState<Record<string, unknown>>(initialState);

  const setState = useCallback((path: string, value: unknown) => {
    setComponentState((prev) => {
      const parts = path.split('.');
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
          bundle = await readBundleFromUrl(url);
        } else if (filePath) {
          bundle = await readBundleFromFile(filePath);
        } else {
          throw new Error('No bundle source provided');
        }

        const rt = createBundleRuntime(bundle);

        // Initialize XDB with bundled data
        rt.initializeXDB();

        setRuntime(rt);
        onLoad?.(rt);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    }

    loadBundle();

    // Dispose previous runtime on re-load or unmount
    return () => {
      if (runtime) {
        runtime.dispose();
      }
    };
  }, [data, url, filePath, preloadedBundle, onLoad]);

  // Build render context
  const context = useMemo<SoftNRenderContext>(
    () => {
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
    },
    [componentState, setState, props, runtime]
  );

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
  const ext = path.split('.').pop()?.toLowerCase() || '';

  const mimeTypes: Record<string, string> = {
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    ico: 'image/x-icon',
    bmp: 'image/bmp',

    // Fonts
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',

    // Text
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    txt: 'text/plain',

    // Media
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    webm: 'video/webm',

    // Documents
    pdf: 'application/pdf',
  };

  return mimeTypes[ext] || 'application/octet-stream';
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

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      let bundle: SoftNBundle;

      if (source.data) {
        bundle = await readBundle(source.data);
      } else if (source.url) {
        bundle = await readBundleFromUrl(source.url);
      } else if (source.filePath) {
        bundle = await readBundleFromFile(source.filePath);
      } else {
        throw new Error('No bundle source provided');
      }

      const rt = createBundleRuntime(bundle);
      rt.initializeXDB();
      setRuntime(rt);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [source.data, source.url, source.filePath]);

  useEffect(() => {
    load();
  }, [load]);

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
