/**
 * SoftN Loader Application
 *
 * A dedicated runtime for opening and rendering .softn application bundles.
 * Double-click any .softn file to open it with this app.
 */

import React, { useState, useEffect } from 'react';
import { registerAllBuiltins, ThemeProvider } from '@softn/components';
import { SoftNWithXDB, getXDB, readBundleEntries, classifyAsset } from '@softn/core';
import { Spinner, Box, Text, Card, Stack, Button } from '@softn/components';

// Compile-time constant from Vite define
declare const __ANDROID__: boolean;

// Register all components with the SoftN engine
registerAllBuiltins();

// Check if running in Tauri
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

// Platform detection
const isMobile = typeof __ANDROID__ !== 'undefined' && __ANDROID__;

/**
 * The loader's chrome, in softn.com's palette.
 *
 * This app used to wear stone-and-blue — a warm near-black under a bright blue
 * gradient logo — which belonged to nothing else in the project. What the user
 * sees before a bundle opens is the whole product's first impression on the
 * desktop, so it uses the same ground, the same two accents and the same faces
 * as the landing page: coral marks the language, mint marks the machine.
 *
 * These are the loader's own chrome only. Once a bundle is open the app inside
 * it paints itself, and nothing here reaches into it.
 */
const LOADER = {
  bg: '#101317',
  panel: '#161a20',
  inset: '#1d222a',
  border: '#262c36',
  text: '#f2f0ec',
  muted: '#8b94a2',
  dim: '#838c9a',
  coral: '#ff8a4c',
  coralGlow: 'rgba(255,138,76,0.16)',
  mint: '#35e0c0',
  // Lifted off the card rather than cut into it — the same value Studio's Mark
  // uses. A tile darker than the surface it sits on reads as a hole.
  markTile: '#1d222a',
  display: "'Bricolage Grotesque Variable', 'Bricolage Grotesque', system-ui, sans-serif",
  body: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

// Types for bundle content
interface BundleManifest {
  name: string;
  version: string;
  description?: string;
  main: string;
  icon?: string;
  files: {
    ui?: string[];
    logic?: string[];
    xdb?: string[];
    assets?: string[];
  };
  config?: {
    window?: {
      title?: string;
      width?: number;
      height?: number;
    };
    theme?: {
      primary?: string;
      mode?: 'light' | 'dark' | 'system';
    };
    mobile?: {
      orientation?: 'portrait' | 'landscape' | 'auto';
    };
    server?: {
      url?: string;
      auth_token?: string;
      collections?: string[];
    };
  };
  permissions?: import('@softn/core').AppPermissions;
}

// XDB file format
interface XDBFile {
  collection: string;
  records: Array<{
    id: string;
    collection: string;
    data: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
    created_at?: string;
    updated_at?: string;
    deleted?: boolean;
  }>;
}

// ZIP reading result with text and binary files
interface ZipResult {
  textFiles: Map<string, string>;
  binaryFiles: Map<string, Uint8Array>;
}

// Check if a file should be treated as binary
function isBinaryFile(fileName: string): boolean {
  // The extension list lived here, in softn-web, in core and in the demo
  // build script, and the four disagreed. @softn/core's registry is the only
  // copy now.
  return classifyAsset(fileName).binary;
}


// Read ZIP entries from Uint8Array using fflate
function readZip(data: Uint8Array): ZipResult {
  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  // Validation lives in @softn/core so every reader shares it. This file and
  // softn-web each carried their own copy — identical today, but two copies of
  // a security check are two chances to fix only one — and the builder had
  // none at all.
  for (const [normalizedPath, content] of readBundleEntries(data)) {
    if (isBinaryFile(normalizedPath)) {
      binaryFiles.set(normalizedPath, content);
    } else {
      textFiles.set(normalizedPath, decoder.decode(content));
    }
  }

  return { textFiles, binaryFiles };
}

// Load XDB data from bundle files into XDB (async for Tauri backend support)
async function loadXDBData(
  textFiles: Map<string, string>,
  manifest: BundleManifest,
  appId?: string
): Promise<void> {
  const xdb = getXDB(appId);
  const xdbFiles = manifest.files.xdb || [];

  const normalizeRecord = (
    collection: string,
    record: XDBFile['records'][number]
  ) => {
    const createdAt = record.created_at || record.createdAt || new Date().toISOString();
    const updatedAt = record.updated_at || record.updatedAt || createdAt;
    return {
      id: record.id,
      collection: record.collection || collection,
      data: record.data || {},
      created_at: createdAt,
      updated_at: updatedAt,
      deleted: record.deleted ?? false,
    };
  };

  for (const xdbFileName of xdbFiles) {
    const content = textFiles.get(xdbFileName);
    if (!content) continue;

    try {
      const xdbData: XDBFile = JSON.parse(content);
      const { collection, records } = xdbData;

      // Check if collection already has data (avoid duplicates on reload)
      // Use async method if available (Tauri mode), fall back to sync
      let existing: unknown[];
      if (xdb.isP2PAvailable()) {
        existing = await xdb.getAllAsync(collection);
      } else {
        existing = xdb.query(collection);
      }

      if (existing.length > 0) {
        console.log(
          `[SoftN Loader] Collection ${collection} already has ${existing.length} records, skipping seed`
        );
        continue;
      }

      // Insert each record - preserve IDs/timestamps and use async for Tauri mode
      for (const record of records) {
        const normalized = normalizeRecord(collection, record);
        xdb.writeRecord(collection, normalized);
      }

      console.log(`[SoftN Loader] Loaded ${records.length} records into ${collection}`);
    } catch (err) {
      console.error(`[SoftN Loader] Failed to load XDB file ${xdbFileName}:`, err);
    }
  }
}

// Set window icon from bundle
async function setWindowIconFromBundle(
  binaryFiles: Map<string, Uint8Array>,
  manifest: BundleManifest
): Promise<void> {
  if (!manifest.icon) return;

  const lowerIconPath = manifest.icon.toLowerCase();
  if (!(lowerIconPath.endsWith('.png') || lowerIconPath.endsWith('.ico') || lowerIconPath.endsWith('.jpg') || lowerIconPath.endsWith('.jpeg'))) {
    console.log(`[SoftN Loader] Skipping unsupported icon format: ${manifest.icon}`);
    return;
  }

  const iconData = binaryFiles.get(manifest.icon);
  if (!iconData) {
    console.warn(`[SoftN Loader] Icon file not found in bundle: ${manifest.icon}`);
    return;
  }

  try {
    // @ts-expect-error - Tauri invoke
    await window.__TAURI__?.core?.invoke('set_window_icon', {
      iconData: Array.from(iconData),
    });
    console.log(`[SoftN Loader] Window icon set from: ${manifest.icon}`);
  } catch (err) {
    console.error('[SoftN Loader] Failed to set window icon:', err);
  }
}

function App(): React.ReactElement {
  const [bundlePath, setBundlePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [mainSource, setMainSource] = useState<string>('');
  const [_manifest, setManifest] = useState<BundleManifest | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [importResolver, setImportResolver] = useState<((path: string) => Promise<string | null>) | undefined>();
  const [logicBasePath, setLogicBasePath] = useState<string | undefined>();
  const [preIncludedLogicPaths, setPreIncludedLogicPaths] = useState<string[]>([]);
  const [permissionConfig, setPermissionConfig] = useState<import('@softn/core').PermissionConfig | null>(null);
  const [assetResolver, setAssetResolver] = useState<((path: string) => string | null) | undefined>();

  // Open a file picker to choose a .softn file
  const openFilePicker = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        // On Android, custom extensions may not be filterable, so accept all files
        filters: isMobile ? [] : [{ name: 'SoftN Bundle', extensions: ['softn'] }],
        multiple: false,
      });
      if (selected) {
        setBundlePath(selected as string);
      }
    } catch (err) {
      console.error('Failed to open file picker:', err);
    }
  };

  // Set up Tauri drag-drop listener (desktop only)
  useEffect(() => {
    if (!isTauri || isMobile) return;

    let unlisten: (() => void) | undefined;

    async function setupDragDrop() {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const webview = getCurrentWebview();

        unlisten = await webview.onDragDropEvent(
          (event: { payload: { type: string; paths?: string[] } }) => {
            if (event.payload.type === 'hover') {
              setIsDragOver(true);
            } else if (event.payload.type === 'drop') {
              setIsDragOver(false);
              const paths = event.payload.paths || [];
              const softnFile = paths.find((p: string) => p.endsWith('.softn'));
              if (softnFile) {
                setBundlePath(softnFile);
              } else if (paths.length > 0) {
                setError(new Error('Please drop a .softn file'));
              }
            } else if (event.payload.type === 'cancel') {
              setIsDragOver(false);
            }
          }
        );
      } catch (err) {
        console.error('Failed to set up drag-drop listener:', err);
      }
    }

    setupDragDrop();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Check for opened file on mount
  useEffect(() => {
    let active = true;
    let unlistenFileOpened: (() => void) | null = null;
    let unlistenIntentFile: (() => void) | null = null;

    async function checkForOpenedFile() {
      if (!isTauri) {
        setLoading(false);
        return;
      }

      try {
        // @ts-expect-error - Tauri invoke
        const openedFile = await window.__TAURI__?.core?.invoke('get_opened_file');
        if (!active) return;
        if (openedFile && typeof openedFile === 'string' && openedFile.endsWith('.softn')) {
          setBundlePath(openedFile);
        } else {
          setLoading(false);
        }

        // Listen for file-opened events (desktop: single-instance, CLI)
        // @ts-expect-error - Tauri event
        const unlisten = await window.__TAURI__?.event?.listen(
          'file-opened',
          (event: { payload: { path: string } }) => {
            if (!active) return;
            if (event.payload?.path?.endsWith('.softn')) {
              setBundlePath(event.payload.path);
            }
          }
        );
        if (typeof unlisten === 'function') {
          if (!active) {
            unlisten();
          } else {
            unlistenFileOpened = unlisten;
          }
        }

        // Listen for intent-opened files (Android)
        if (isMobile) {
          // @ts-expect-error - Tauri event
          const unlistenIntent = await window.__TAURI__?.event?.listen(
            'intent-file-opened',
            (event: { payload: { filename: string } }) => {
              if (!active) return;
              const filename = event.payload?.filename;
              if (filename && filename.endsWith('.softn')) {
                // Use special prefix so loadBundle knows to use read_cached_bundle
                setBundlePath(`__intent__:${filename}`);
              }
            }
          );
          if (typeof unlistenIntent === 'function') {
            if (!active) {
              unlistenIntent();
            } else {
              unlistenIntentFile = unlistenIntent;
            }
          }
        }
      } catch (err) {
        if (!active) return;
        console.error('Error checking for opened file:', err);
        setLoading(false);
      }
    }

    checkForOpenedFile();

    return () => {
      active = false;
      if (unlistenFileOpened) unlistenFileOpened();
      if (unlistenIntentFile) unlistenIntentFile();
    };
  }, []);

  // Load bundle when path is set
  useEffect(() => {
    if (!bundlePath) return;

    async function loadBundle() {
      const objectUrls: string[] = [];
      try {
        setLoading(true);
        setError(null);

        let rawData: number[] | Uint8Array;

        if (isMobile && bundlePath!.startsWith('__intent__:')) {
          // Intent-opened file: read from app cache via Rust command
          const filename = bundlePath!.replace('__intent__:', '');
          // @ts-expect-error - Tauri invoke
          rawData = await window.__TAURI__?.core?.invoke('read_cached_bundle', { filename });
        } else if (isMobile && bundlePath!.startsWith('content://')) {
          // Android content URI: read via plugin-fs
          const { readFile } = await import('@tauri-apps/plugin-fs');
          rawData = await readFile(bundlePath!);
        } else {
          // Desktop: read via Rust command
          // @ts-expect-error - Tauri invoke
          rawData = await window.__TAURI__?.core?.invoke('read_softn_bundle', {
            path: bundlePath,
          });
        }

        if (!rawData) {
          throw new Error('Failed to read bundle file');
        }

        const data = new Uint8Array(rawData);
        const { textFiles, binaryFiles } = readZip(data);

        // The bundle's declared capabilities. Without this the runtime runs with
        // no config, which allows most APIs but still refuses plain http:// — so
        // a bundle that legitimately declared net.allow_http for a LAN or
        // localhost server could not reach it, and allowed_hosts went unenforced.
        const permJson = textFiles.get('permission.json');
        if (permJson) {
          try {
            setPermissionConfig(JSON.parse(permJson));
          } catch (e) {
            // Not null: a null config means "no permission.json at all", which
            // the runtime treats as a legacy bundle and allows everything. A
            // file that fails to parse would then grant more than a valid one
            // declaring nothing. An empty config denies every capability.
            console.error('[SoftN Loader] Invalid permission.json — denying all capabilities:', e);
            setPermissionConfig({ permissions: {} });
          }
        } else {
          setPermissionConfig(null);
        }

        const manifestContent = textFiles.get('manifest.json');
        if (!manifestContent) {
          throw new Error('Bundle missing manifest.json');
        }

        const parsedManifest: BundleManifest = JSON.parse(manifestContent);
        setManifest(parsedManifest);

        // Lock screen orientation if configured (mobile only)
        if (isMobile && parsedManifest.config?.mobile?.orientation) {
          const orient = parsedManifest.config.mobile.orientation;
          if (orient !== 'auto') {
            try {
              await (screen.orientation as { lock?: (o: string) => Promise<void> }).lock?.(orient);
            } catch {
              // Orientation lock is unavailable or refused; not worth failing the load.
            }
          }
        }

        // Load XDB data from bundle (await for Tauri backend)
        const appId = parsedManifest.name || 'softn-app';
        await loadXDBData(textFiles, parsedManifest, appId);

        // Set window icon from bundle (desktop only)
        if (!isMobile) {
          await setWindowIconFromBundle(binaryFiles, parsedManifest);
        }

        const mainUI = textFiles.get(parsedManifest.main);
        if (!mainUI) {
          throw new Error(`Main file not found: ${parsedManifest.main}`);
        }

        // Helper to resolve relative paths from a base file path
        const resolvePath = (basePath: string, relativePath: string): string => {
          const baseParts = basePath.split('/');
          baseParts.pop(); // Remove filename to get directory

          const relativeParts = relativePath.split('/');
          for (const part of relativeParts) {
            if (part === '..') {
              baseParts.pop();
            } else if (part !== '.') {
              baseParts.push(part);
            }
          }
          const resolved = baseParts.filter(Boolean).join('/');
          if (resolved.includes('..') || resolved.startsWith('/')) {
            throw new Error(`Unsafe import path: ${relativePath}`);
          }
          return resolved;
        };

        let fullSource = mainUI;
        let logicBasePath: string | undefined;
        // Logic files concatenated below. Reported to the runtime so an `import`
        // naming one of them is skipped rather than inlining the file twice.
        const preIncludedLogic = new Set<string>();

        const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const inlineLogic = (source: string, basePath: string): string => {
          return source.replace(/<logic\s+src=["']([^"']+)["']\s*\/>/g, (match, rel) => {
            const logicPath = resolvePath(basePath, rel);
            console.log('[SoftN Loader] Resolving logic:', rel, '->', logicPath);
            const logicFile = textFiles.get(logicPath);
            if (!logicFile) {
              console.warn('[SoftN Loader] Logic file not found:', logicPath);
              return match;
            }
            logicBasePath = logicPath;

            // Concatenate all manifest-listed .logic files into a single block.
            // Files other than the main entry are prepended so that their class/function
            // definitions are available when the main file's top-level code runs.
            const manifestLogicFiles = parsedManifest.files.logic || [];
            const parts: string[] = [];
            for (const mlPath of manifestLogicFiles) {
              if (mlPath === logicPath) continue; // main entry added last
              const content = textFiles.get(mlPath);
              if (content) {
                console.log('[SoftN Loader] Including manifest logic file:', mlPath);
                parts.push(content);
                preIncludedLogic.add(mlPath);
              }
            }
            parts.push(logicFile); // main entry last

            return `<logic>\n${parts.join('\n')}\n</logic>`;
          });
        };

        const inlineImports = (
          source: string,
          basePath: string,
          stack: Set<string>,
          cache: Map<string, string>
        ): string => {
          let nextSource = inlineLogic(source, basePath);
          const importRegex = /<import\s+(\w+)\s+from=["']([^"']+)["']\s*\/>/g;
          const imports: Array<{ name: string; path: string; content: string }> = [];

          let match;
          while ((match = importRegex.exec(nextSource)) !== null) {
            const componentName = match[1];
            const importPath = match[2];
            const resolvedPath = resolvePath(basePath, importPath);
            console.log('[SoftN Loader] Resolving import:', componentName, '->', resolvedPath);

            const componentContent = textFiles.get(resolvedPath);
            if (componentContent) {
              if (cache.has(resolvedPath)) {
                imports.push({ name: componentName, path: resolvedPath, content: cache.get(resolvedPath)! });
                continue;
              }
              if (stack.has(resolvedPath)) {
                console.warn('[SoftN Loader] Skipping circular import:', resolvedPath);
                continue;
              }
              stack.add(resolvedPath);
              const inlined = inlineImports(componentContent, resolvedPath, stack, cache);
              stack.delete(resolvedPath);
              cache.set(resolvedPath, inlined);
              imports.push({ name: componentName, path: resolvedPath, content: inlined });
            } else {
              console.warn('[SoftN Loader] Imported file not found:', resolvedPath);
            }
          }

          nextSource = nextSource.replace(/<import\s+\w+\s+from=["'][^"']+["']\s*\/>\n?/g, '');

          for (const imp of imports) {
            const templateContent = imp.content
              .replace(/^\/\/[^\n]*\n/gm, '')
              .trim();

            const escapedName = escapeRegex(imp.name);
            const selfClosingRegex = new RegExp(`<${escapedName}\\s*/>`, 'g');
            // Function replacer: a component's markup is content, not a
            // substitution pattern. Passed as a string, `$&` re-inserts the
            // tag it just replaced and `$'` splices in the rest of the
            // document — so a component containing either corrupted the page.
            nextSource = nextSource.replace(selfClosingRegex, () => templateContent);

            const pairedRegex = new RegExp(`<${escapedName}[^>]*>.*?</${escapedName}>`, 'gs');
            nextSource = nextSource.replace(pairedRegex, () => templateContent);
          }

          return nextSource;
        };

        fullSource = inlineImports(
          fullSource,
          parsedManifest.main,
          new Set([parsedManifest.main]),
          new Map()
        );

        console.log('[SoftN Loader] Final source prepared with inlined components');

        // Create import resolver for .logic file imports (looks up in bundle files, fetches URLs)
        // Remote imports are default-deny: only allowed if the bundle explicitly
        // declares network permission AND uses HTTPS (no plaintext HTTP).
        const hasNetworkPermission = !!parsedManifest.permissions?.network;
        const urlCache = new Map<string, string>();
        const MAX_REMOTE_IMPORT_BYTES = 1 * 1024 * 1024; // 1MB
        const REMOTE_IMPORT_TIMEOUT_MS = 10_000;
        const resolver = async (path: string): Promise<string | null> => {
          if (path.startsWith('http://') || path.startsWith('https://')) {
            if (!hasNetworkPermission) {
              console.warn('[SoftN Loader] Remote import blocked (no network permission):', path);
              return null;
            }
            if (path.startsWith('http://')) {
              console.warn('[SoftN Loader] Remote import blocked (HTTPS required):', path);
              return null;
            }
            if (urlCache.has(path)) return urlCache.get(path)!;
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), REMOTE_IMPORT_TIMEOUT_MS);
              const resp = await fetch(path, { signal: controller.signal });
              clearTimeout(timer);
              if (!resp.ok) return null;
              const contentLength = resp.headers.get('content-length');
              if (contentLength && parseInt(contentLength, 10) > MAX_REMOTE_IMPORT_BYTES) {
                console.warn('[SoftN Loader] Remote import too large:', path);
                return null;
              }
              const text = await resp.text();
              if (text.length > MAX_REMOTE_IMPORT_BYTES) {
                console.warn('[SoftN Loader] Remote import too large:', path);
                return null;
              }
              urlCache.set(path, text);
              return text;
            } catch (e) {
              console.warn('[SoftN Loader] Remote import failed:', path, e);
              return null;
            }
          }
          return textFiles.get(path) ?? null;
        };

        const normalizeAssetPath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\/+/, '');
        const assetUrlCache = new Map<string, string>();
        const resolveAsset = (path: string): string | null => {
          if (!path) return null;
          if (path.startsWith('blob:') || path.startsWith('data:') || path.startsWith('http://') || path.startsWith('https://')) {
            return path;
          }
          const normalized = normalizeAssetPath(path);
          if (assetUrlCache.has(normalized)) return assetUrlCache.get(normalized)!;
          const bin = binaryFiles.get(normalized);
          // .gltf and .obj are text formats, so readZip lands them in
          // textFiles; a model is an asset wherever its bytes live.
          const text = bin ? undefined : textFiles.get(normalized);
          if (!bin && text === undefined) return null;
          // The registry answers application/octet-stream for unknown
          // extensions, which is the fallback the map here used.
          const mime = classifyAsset(normalized).mime;
          const blob = bin
            ? new Blob([bin as unknown as BlobPart], { type: mime })
            : new Blob([text as string], { type: mime });
          const url = URL.createObjectURL(blob);
          assetUrlCache.set(normalized, url);
          objectUrls.push(url);
          return url;
        };

        setImportResolver(() => resolver);
        setAssetResolver(() => resolveAsset);
        if (typeof window !== 'undefined') {
          (window as unknown as Record<string, unknown>).__softnAsset = resolveAsset;
        }
        setLogicBasePath(logicBasePath);
        setPreIncludedLogicPaths([...preIncludedLogic]);
        setMainSource(fullSource);
        setLoading(false);

        // Update window title (desktop only)
        if (!isMobile && (parsedManifest.config?.window?.title || parsedManifest.name)) {
          try {
            const windowModule = await import('@tauri-apps/api/window');
            const appWindow = windowModule.getCurrentWindow();
            await appWindow.setTitle(parsedManifest.config?.window?.title || parsedManifest.name);
          } catch {
            // Window API not available
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
        setAssetResolver(undefined);
      }

      // Cleanup URLs if this specific load invocation is replaced/unmounted.
      //
      // Returned after the try/catch rather than out of a `finally`: a `return`
      // there discards whatever the block was doing, including an exception the
      // catch itself raised, so a failure inside the error handler vanished.
      return () => {
        // Unlock orientation when leaving app
        try {
          (screen.orientation as { unlock?: () => void }).unlock?.();
        } catch {
          // Orientation lock is not available everywhere.
        }
        for (const url of objectUrls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Ignore revoke failures.
          }
        }
      };
    }

    const cleanupPromise = loadBundle();
    return () => {
      Promise.resolve(cleanupPromise).then((cleanup) => {
        if (typeof cleanup === 'function') {
          cleanup();
        }
      }).catch(() => {});
    };
  }, [bundlePath]);

  // Show welcome screen when no file is opened
  if (!bundlePath && !loading) {
    return (
      <ThemeProvider followSystem>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100vh',
            width: '100vw',
            // softn.com's ground, not the stone-and-blue this app used to wear.
            background: LOADER.bg,
            fontFamily: LOADER.body,
            padding: '2rem',
            transition: 'background 0.2s ease',
          }}
        >
          <Card
            style={{
              maxWidth: '460px',
              width: '100%',
              padding: '2.75rem 2.5rem',
              background: LOADER.panel,
              // Coral on drag, because a drop target is the language accepting a
              // file, not a status light. Mint is reserved for things running.
              border: isDragOver ? `2px dashed ${LOADER.coral}` : `1px solid ${LOADER.border}`,
              borderRadius: '18px',
              textAlign: 'center',
              boxShadow: isDragOver ? `0 24px 60px ${LOADER.coralGlow}` : '0 20px 48px rgba(0,0,0,0.34)',
              transition: 'border 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease',
              transform: isDragOver ? 'scale(1.015)' : 'scale(1)',
            }}
          >
            <Stack direction="vertical" gap="lg" style={{ alignItems: 'center' }}>
              {/* The SoftN mark, drawn from the same 32-unit grid as the site
                  favicon and the icons: coral brackets because they are the
                  language, a mint dot because it is the thing that runs. */}
              <svg width="72" height="72" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="SoftN">
                <rect width="32" height="32" rx="7" fill={LOADER.markTile} />
                <path d="M9 11.5 5.5 16 9 20.5" fill="none" stroke={LOADER.coral} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M23 11.5 26.5 16 23 20.5" fill="none" stroke={LOADER.coral} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="16" cy="16" r="2.8" fill={LOADER.mint} />
              </svg>
              <Stack direction="vertical" gap="sm" style={{ alignItems: 'center' }}>
                <Text style={{ fontFamily: LOADER.display, fontSize: '2rem', fontWeight: 600, letterSpacing: '-0.03em', color: LOADER.text }}>
                  SoftN
                </Text>
                <Text style={{ fontFamily: LOADER.mono, fontSize: '0.6875rem', letterSpacing: '0.14em', textTransform: 'uppercase', color: LOADER.dim }}>
                  Application Runtime
                </Text>
              </Stack>
              <Text
                style={{
                  color: isDragOver ? LOADER.coral : LOADER.muted,
                  fontSize: '0.9375rem',
                  lineHeight: 1.65,
                  transition: 'color 0.2s ease',
                }}
              >
                {isDragOver
                  ? 'Drop your .softn file here!'
                  : isMobile
                    ? 'Tap the button below to open a .softn file.'
                    : 'Open a .softn file to get started, or drag and drop one onto this window.'}
              </Text>
              {(isTauri || isMobile) && (
                <Button
                  variant="primary"
                  onClick={openFilePicker}
                  style={{
                    marginTop: '0.25rem',
                    padding: '0.75rem 1.75rem',
                    fontSize: '0.9375rem',
                    fontWeight: 600,
                    fontFamily: LOADER.body,
                    // Paper on ink, the same primary the landing page uses: the
                    // one thing to press should not be another shade of the card.
                    background: LOADER.text,
                    color: LOADER.bg,
                    border: 'none',
                    borderRadius: '10px',
                    // Comfortable for a finger on the Android build, where this
                    // button is the only way in.
                    minHeight: 44,
                  }}
                >
                  Open a .softn file
                </Button>
              )}
              <Box
                style={{
                  marginTop: '0.25rem',
                  padding: '0.875rem 1rem',
                  background: LOADER.inset,
                  border: `1px solid ${LOADER.border}`,
                  borderRadius: '10px',
                  width: '100%',
                }}
              >
                <Text style={{ color: LOADER.dim, fontSize: '0.8125rem', lineHeight: 1.55 }}>
                  A <span style={{ fontFamily: LOADER.mono, color: LOADER.coral }}>.softn</span> file is
                  one self-contained app — its interface, its logic and its data in a single bundle.
                </Text>
              </Box>
            </Stack>
          </Card>
        </div>
      </ThemeProvider>
    );
  }

  // Show loading state
  if (loading) {
    return (
      <ThemeProvider followSystem>
        <Box
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100vh',
            width: '100vw',
            flexDirection: 'column',
            gap: '1rem',
            background: '#0c0a09',
          }}
        >
          <Spinner size="lg" />
          <Text color="white">Loading {bundlePath?.split(/[/\\]/).pop() || 'application'}...</Text>
        </Box>
      </ThemeProvider>
    );
  }

  // Show error state
  if (error) {
    return (
      <ThemeProvider followSystem>
        <Box style={{ padding: '2rem', background: '#0c0a09', height: '100vh', width: '100vw' }}>
          <Card
            style={{
              padding: '2rem',
              background: '#1c1917',
              border: '1px solid #ef4444',
              borderRadius: '12px',
            }}
          >
            <Stack direction="vertical" gap="md">
              <Text style={{ color: '#ef4444', fontWeight: 'bold', fontSize: '1.25rem' }}>
                Failed to load application
              </Text>
              <Text style={{ color: '#fafaf9' }}>{error.message}</Text>
              <Text style={{ color: '#78716c', fontSize: '0.875rem' }}>Path: {bundlePath}</Text>
              <Button
                variant="secondary"
                onClick={() => {
                  setBundlePath(null);
                  setError(null);
                }}
                style={{ marginTop: '1rem' }}
              >
                Back to Home
              </Button>
            </Stack>
          </Card>
        </Box>
      </ThemeProvider>
    );
  }

  // Render the SoftN application
  // Let SoftNWithXDB handle all state, function execution, and data block processing
  return (
    <ThemeProvider followSystem>
      <Box style={{ height: '100vh', width: '100vw', background: '#0c0a09' }}>
        <SoftNWithXDB
          source={mainSource}
          scriptExecutionMode="main"
          resumeSavedSyncRoom={false}
          appId={_manifest?.name || 'softn-app'}
          permissions={_manifest?.permissions}
          importResolver={importResolver}
          logicBasePath={logicBasePath}
          preIncludedLogicPaths={preIncludedLogicPaths}
          permissionConfig={permissionConfig ?? undefined}
          serverUrl={_manifest?.config?.server?.url}
          serverToken={_manifest?.config?.server?.auth_token}
          serverCollections={_manifest?.config?.server?.collections}
          functions={{
            asset: (path: unknown) => {
              if (typeof path !== 'string' || !assetResolver) return '';
              return assetResolver(path) || '';
            },
          }}
          loading={
            <Box
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100vh',
                width: '100vw',
              }}
            >
              <Spinner size="lg" />
            </Box>
          }
          error={(err) => (
            <Box style={{ padding: '2rem' }}>
              <Card
                style={{ padding: '1.5rem', background: '#1c1917', border: '1px solid #ef4444' }}
              >
                <Text style={{ color: '#ef4444' }}>Render Error: {err.message}</Text>
              </Card>
            </Box>
          )}
        />
      </Box>
    </ThemeProvider>
  );
}

export default App;
