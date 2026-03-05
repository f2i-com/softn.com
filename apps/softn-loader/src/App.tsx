/**
 * SoftN Loader Application
 *
 * A dedicated runtime for opening and rendering .softn application bundles.
 * Double-click any .softn file to open it with this app.
 */

import React, { useState, useEffect } from 'react';
import { registerAllBuiltins, ThemeProvider } from '@softn/components';
import { SoftNWithXDB, getXDB } from '@softn/core';
import { Spinner, Box, Text, Card, Stack, Button } from '@softn/components';
import { unzipSync } from 'fflate';

// Compile-time constant from Vite define
declare const __ANDROID__: boolean;

// Register all components with the SoftN engine
registerAllBuiltins();

// Check if running in Tauri
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

// Platform detection
const isMobile = typeof __ANDROID__ !== 'undefined' && __ANDROID__;

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
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.bmp', '.avif', '.tiff', '.tif',
    '.glb', '.obj', '.fbx', '.stl', '.3ds', '.dae', '.bin',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.hdr', '.exr', '.pdf',
  ];
  const lowerName = fileName.toLowerCase();
  return binaryExtensions.some((ext) => lowerName.endsWith(ext));
}

const MAX_ZIP_INPUT_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_ZIP_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

function preflightZip(data: Uint8Array): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const EOCD_SIGNATURE = 0x06054b50;
  const CEN_SIGNATURE = 0x02014b50;
  const LFH_SIGNATURE = 0x04034b50;
  const MAX_COMMENT = 0xffff;
  const eocdMinOffset = Math.max(0, data.byteLength - (22 + MAX_COMMENT));

  let eocdOffset = -1;
  for (let i = data.byteLength - 22; i >= eocdMinOffset; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP: missing end-of-central-directory');
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error('Bundle has too many files');
  }
  if (centralDirSize > data.byteLength || centralDirOffset > data.byteLength) {
    throw new Error('Invalid ZIP central directory');
  }
  if (centralDirOffset + centralDirSize > data.byteLength) {
    throw new Error('Corrupt ZIP: central directory out of bounds');
  }

  let offset = centralDirOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > data.byteLength || view.getUint32(offset, true) !== CEN_SIGNATURE) {
      throw new Error('Invalid ZIP central directory entry');
    }

    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('ZIP64 bundles are not supported');
    }
    if (uncompressedSize > MAX_ZIP_FILE_BYTES) {
      throw new Error('File too large in bundle');
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Bundle contents too large');
    }

    if (localHeaderOffset + 30 > data.byteLength) {
      throw new Error('Corrupt ZIP: local header out of bounds');
    }
    if (view.getUint32(localHeaderOffset, true) !== LFH_SIGNATURE) {
      throw new Error('Corrupt ZIP: invalid local file header');
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }
}

// Read ZIP entries from Uint8Array using fflate
function readZip(data: Uint8Array): ZipResult {
  if (data.byteLength > MAX_ZIP_INPUT_BYTES) {
    throw new Error('Bundle too large');
  }

  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  preflightZip(data);

  // Use fflate to decompress the ZIP (supports all compression methods)
  const unzipped = unzipSync(data);
  const entries = Object.entries(unzipped);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error('Bundle has too many files');
  }
  let totalBytes = 0;

  for (const [path, content] of entries) {
    // Normalize path: convert backslashes to forward slashes
    const normalizedPath = path.replace(/\\/g, '/');
    if (
      normalizedPath.startsWith('/') ||
      normalizedPath.includes('..') ||
      normalizedPath.includes('\0') ||
      /^[a-zA-Z]:/.test(normalizedPath)
    ) {
      continue;
    }

    // Skip directories
    if (normalizedPath.endsWith('/')) continue;

    if (content.byteLength > MAX_ZIP_FILE_BYTES) {
      throw new Error(`File too large in bundle: ${normalizedPath}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Bundle contents too large');
    }

    if (isBinaryFile(normalizedPath)) {
      binaryFiles.set(normalizedPath, content);
    } else {
      textFiles.set(normalizedPath, decoder.decode(content));
    }
  }

  console.log('[SoftN Loader] Loaded files:', Array.from(textFiles.keys()));

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
            try { await (screen.orientation as any).lock(orient); } catch {}
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
            nextSource = nextSource.replace(selfClosingRegex, templateContent);

            const pairedRegex = new RegExp(`<${escapedName}[^>]*>.*?</${escapedName}>`, 'gs');
            nextSource = nextSource.replace(pairedRegex, templateContent);
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
        const urlCache = new Map<string, string>();
        const resolver = async (path: string): Promise<string | null> => {
          if (path.startsWith('http://') || path.startsWith('https://')) {
            if (urlCache.has(path)) return urlCache.get(path)!;
            const resp = await fetch(path);
            if (!resp.ok) return null;
            const text = await resp.text();
            urlCache.set(path, text);
            return text;
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
          if (!bin) return null;
          const ext = normalized.split('.').pop()?.toLowerCase() || '';
          const mimeByExt: Record<string, string> = {
            wav: 'audio/wav',
            mp3: 'audio/mpeg',
            ogg: 'audio/ogg',
            webm: 'audio/webm',
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            svg: 'image/svg+xml',
            webp: 'image/webp',
            ico: 'image/x-icon',
          };
          const mime = mimeByExt[ext] || 'application/octet-stream';
          const blob = new Blob([bin as unknown as BlobPart], { type: mime });
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
      } finally {
        // Cleanup URLs if this specific load invocation is replaced/unmounted.
        return () => {
          // Unlock orientation when leaving app
          try { (screen.orientation as any).unlock(); } catch {}
          for (const url of objectUrls) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              // Ignore revoke failures.
            }
          }
        };
      }
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
            background: isDragOver
              ? 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)'
              : 'linear-gradient(135deg, #0c0a09 0%, #1c1917 100%)',
            padding: '2rem',
            transition: 'background 0.2s ease',
          }}
        >
          <Card
            style={{
              maxWidth: '500px',
              width: '100%',
              padding: '3rem',
              background: '#1c1917',
              border: isDragOver ? '2px dashed #3b82f6' : '1px solid rgba(255,255,255,0.1)',
              borderRadius: '16px',
              textAlign: 'center',
              transition: 'border 0.2s ease, transform 0.2s ease',
              transform: isDragOver ? 'scale(1.02)' : 'scale(1)',
            }}
          >
            <Stack direction="vertical" gap="lg" style={{ alignItems: 'center' }}>
              <svg width="80" height="80" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ filter: 'drop-shadow(0 8px 24px rgba(59, 130, 246, 0.3))' }}>
                <defs>
                  <linearGradient id="loader-logo" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#60a5fa"/>
                    <stop offset="100%" stopColor="#2563eb"/>
                  </linearGradient>
                </defs>
                <rect width="32" height="32" rx="8" fill="url(#loader-logo)"/>
                <path d="M10.5 9C20 9 21 16 16 16S12 23 21.5 23" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round"/>
                <circle cx="10.5" cy="9" r="2.5" fill="#fff"/>
                <circle cx="21.5" cy="23" r="2.5" fill="#fff"/>
              </svg>
              <Stack direction="vertical" gap="sm" style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'white' }}>
                  SoftN
                </Text>
                <Text style={{ color: '#a8a29e', fontSize: '0.875rem' }}>Application Runtime</Text>
              </Stack>
              <Text
                style={{
                  color: isDragOver ? '#3b82f6' : '#78716c',
                  lineHeight: 1.6,
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
                    marginTop: '0.5rem',
                    padding: '0.625rem 1.5rem',
                    fontSize: '0.9375rem',
                  }}
                >
                  Open File
                </Button>
              )}
              <Box
                style={{
                  marginTop: '0.5rem',
                  padding: '1rem',
                  background: '#292524',
                  borderRadius: '8px',
                  width: '100%',
                }}
              >
                <Text style={{ color: '#a8a29e', fontSize: '0.75rem' }}>
                  SoftN applications are self-contained bundles that include UI, logic, and data.
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
