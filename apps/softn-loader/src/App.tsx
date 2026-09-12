/**
 * SoftN Loader Application
 *
 * A dedicated runtime for opening and rendering .softn application bundles.
 * Double-click any .softn file to open it with this app.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { registerAllBuiltins, ThemeProvider } from '@softn/components';
import {
  SoftNWithXDB,
  readBundleEntries,
  classifyAsset,
  type PermissionConfig,
  type AppAssetResolver,
} from '@softn/core';
import { Spinner } from '@softn/components';
import { DesktopShell, DesktopWelcome } from './DesktopShell';
import { createBundleAssetResolver } from './bundleAssets';
import { isSoftnPath, resolveServerConfig, type BundleServerConfig } from './runtimeConfig';
import { createBundleImportResolver } from './remoteImport';
import { computeBundleAppId, loadBundleXDBData, processBundleSource } from './bundleRuntime';

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
    server?: BundleServerConfig;
  };
  permissions?: import('@softn/core').AppPermissions;
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

// Set window icon from bundle
async function setWindowIconFromBundle(
  binaryFiles: Map<string, Uint8Array>,
  manifest: BundleManifest
): Promise<void> {
  if (!manifest.icon) return;

  const lowerIconPath = manifest.icon.toLowerCase();
  if (
    !(
      lowerIconPath.endsWith('.png') ||
      lowerIconPath.endsWith('.ico') ||
      lowerIconPath.endsWith('.jpg') ||
      lowerIconPath.endsWith('.jpeg')
    )
  ) {
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
  const [openRevision, setOpenRevision] = useState(0);
  const selectionRevision = useRef(0);
  const selectBundle = useCallback((path: string) => {
    selectionRevision.current += 1;
    setBundlePath(path);
    setOpenRevision((revision) => revision + 1);
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [mainSource, setMainSource] = useState<string>('');
  const [_manifest, setManifest] = useState<BundleManifest | null>(null);
  const [runtimeAppId, setRuntimeAppId] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [importResolver, setImportResolver] = useState<
    ((path: string) => Promise<string | null>) | undefined
  >();
  const [logicBasePath, setLogicBasePath] = useState<string | undefined>();
  const [preIncludedLogicPaths, setPreIncludedLogicPaths] = useState<string[]>([]);
  const [permissionConfig, setPermissionConfig] = useState<PermissionConfig | null>(null);
  const [assetResolver, setAssetResolver] = useState<AppAssetResolver>();
  const [serverConfig, setServerConfig] = useState(() => resolveServerConfig());

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
        selectBundle(selected as string);
      }
    } catch (err) {
      setError(new Error(`Unable to open the file picker: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  // Set up Tauri drag-drop listener (desktop only)
  useEffect(() => {
    if (!isTauri || isMobile) return;

    let unlisten: (() => void) | undefined;
    let listening = true;

    async function setupDragDrop() {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const webview = getCurrentWebview();

        unlisten = await webview.onDragDropEvent(
          (event: { payload: { type: string; paths?: string[] } }) => {
            if (!listening) return;
            if (event.payload.type === 'enter' || event.payload.type === 'over') {
              setIsDragOver(true);
            } else if (event.payload.type === 'drop') {
              setIsDragOver(false);
              const paths = event.payload.paths || [];
              const softnFile = paths.find(isSoftnPath);
              if (softnFile) {
                selectBundle(softnFile);
              } else if (paths.length > 0) {
                setError(new Error('Please drop a .softn file'));
              }
            } else if (event.payload.type === 'leave') {
              setIsDragOver(false);
            }
          }
        );
        if (!listening) unlisten();
      } catch (err) {
        console.error('Failed to set up drag-drop listener:', err);
      }
    }

    setupDragDrop();

    return () => {
      listening = false;
      if (unlisten) unlisten();
    };
  }, [selectBundle]);

  // Check for opened file on mount
  useEffect(() => {
    let active = true;
    let unlistenFileOpened: (() => void) | null = null;
    let unlistenIntentFile: (() => void) | null = null;

    async function checkForOpenedFile() {
      const revision = selectionRevision.current;
      if (!isTauri) {
        setLoading(false);
        return;
      }

      try {
        // @ts-expect-error - Tauri invoke
        const openedFile = await window.__TAURI__?.core?.invoke('get_opened_file');
        if (!active) return;
        if (revision === selectionRevision.current) {
          if (openedFile && typeof openedFile === 'string' && isSoftnPath(openedFile)) {
            selectBundle(openedFile);
          } else {
            setLoading(false);
          }
        }

        // Listen for file-opened events (desktop: single-instance, CLI)
        // @ts-expect-error - Tauri event
        const unlisten = await window.__TAURI__?.event?.listen(
          'file-opened',
          (event: { payload: { path: string } }) => {
            if (!active) return;
            if (event.payload?.path && isSoftnPath(event.payload.path)) {
              selectBundle(event.payload.path);
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
              if (filename && isSoftnPath(filename)) {
                // Use special prefix so loadBundle knows to use read_cached_bundle
                selectBundle(`__intent__:${filename}`);
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
        if (revision === selectionRevision.current) setLoading(false);
      }
    }

    checkForOpenedFile();

    return () => {
      active = false;
      if (unlistenFileOpened) unlistenFileOpened();
      if (unlistenIntentFile) unlistenIntentFile();
    };
  }, [selectBundle]);

  // Load bundle when path is set
  useEffect(() => {
    if (!bundlePath) return;

    let active = true;
    let loadedAssets: AppAssetResolver | undefined;
    const remoteControllers = new Set<AbortController>();

    const cleanup = () => {
      for (const controller of remoteControllers) controller.abort();
      remoteControllers.clear();
      try {
        (screen.orientation as { unlock?: () => void }).unlock?.();
      } catch {
        // Orientation lock is not available everywhere.
      }
      loadedAssets?.dispose?.();
    };

    async function loadBundle() {
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

        if (!active) return;
        if (!rawData) {
          throw new Error('Failed to read bundle file');
        }

        const data = new Uint8Array(rawData);
        const resolvedAppId = await computeBundleAppId(data);
        if (!active) return;
        const { textFiles, binaryFiles } = readZip(data);

        // Keep this load's parsed config in the closure as well as state. React
        // state updates are asynchronous; reading `permissionConfig` below
        // would otherwise inspect the previously opened bundle's policy.
        let bundlePermissionConfig: PermissionConfig | null = null;
        const permJson = textFiles.get('permission.json');
        if (permJson) {
          try {
            const parsed: unknown = JSON.parse(permJson);
            bundlePermissionConfig =
              parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as PermissionConfig)
                : { permissions: {} };
          } catch (e) {
            console.error('[SoftN Loader] Invalid permission.json — denying all capabilities:', e);
            bundlePermissionConfig = { permissions: {} };
          }
        }
        setPermissionConfig(bundlePermissionConfig);

        const manifestContent = textFiles.get('manifest.json');
        if (!manifestContent) {
          throw new Error('Bundle missing manifest.json');
        }

        const parsedManifest: BundleManifest = JSON.parse(manifestContent);
        const resolvedServerConfig = resolveServerConfig(parsedManifest.config?.server);
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
        if (!active) {
          cleanup();
          return;
        }

        // Load XDB data from bundle (await for Tauri backend)
        await loadBundleXDBData(textFiles, parsedManifest, resolvedAppId, () => active);
        if (!active) return;

        // Set window icon from bundle (desktop only)
        if (!isMobile) {
          await setWindowIconFromBundle(binaryFiles, parsedManifest);
        }
        if (!active) return;

        const { source, logicBasePath, preIncludedLogicPaths } = processBundleSource(
          textFiles,
          parsedManifest
        );
        console.log('[SoftN Loader] Final source prepared with inlined components');

        const resolver = createBundleImportResolver(textFiles, {
          permissionConfig: bundlePermissionConfig,
          isActive: () => active,
          trackController: (controller) => {
            remoteControllers.add(controller);
            return () => remoteControllers.delete(controller);
          },
        });

        loadedAssets = createBundleAssetResolver(binaryFiles, textFiles);
        if (!active) { cleanup(); return; }
        // Update window title (desktop only)
        if (!isMobile && (parsedManifest.config?.window?.title || parsedManifest.name)) {
          try {
            const windowModule = await import('@tauri-apps/api/window');
            if (!active) return;
            const appWindow = windowModule.getCurrentWindow();
            await appWindow.setTitle(`Opening ${parsedManifest.config?.window?.title || parsedManifest.name} — Softn`);
          } catch {
            // Window API not available
          }
        }
        if (!active) return;
        setImportResolver(() => resolver);
        setAssetResolver(() => loadedAssets);
        setServerConfig(resolvedServerConfig);
        setRuntimeAppId(resolvedAppId);
        setLogicBasePath(logicBasePath);
        setPreIncludedLogicPaths(preIncludedLogicPaths);
        setMainSource(source);
        setLoading(false);


      } catch (err) {
        if (!active) return;
        cleanup();
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
        setAssetResolver(undefined);
      }
    }

    void loadBundle();
    return () => {
      // React runs this before starting the effect for a newly selected file.
      // Every awaited continuation below checks the flag before publishing, so
      // an older read can finish but can no longer replace the newer bundle.
      active = false;
      cleanup();
    };
  }, [bundlePath, openRevision]);

  const goHome = () => {
    selectionRevision.current += 1;
    setBundlePath(null);
    setLoading(false);
    setError(null);
    setManifest(null);
    setMainSource('');
    setRuntimeAppId(null);
    setAssetResolver(undefined);
    setImportResolver(undefined);
    if (isTauri && !isMobile) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle('Softn — Desktop runtime')).catch(() => {});
    }
  };

  return <DesktopShell appName={bundlePath ? _manifest?.name : undefined} onHome={goHome} onOpen={openFilePicker} canOpen={isTauri || isMobile}>
    {!bundlePath && !loading ? <DesktopWelcome onOpen={openFilePicker} canOpen={isTauri || isMobile} dragging={isDragOver} error={error} />
      : loading ? <div className="desktop-state" role="status"><Spinner size="lg" /><p>Opening {bundlePath?.split(/[/\\]/).pop() || 'your app'}…</p></div>
      : error ? <div className="desktop-state" role="alert"><h1>We couldn’t open this app</h1><p className="desktop-error">{error.message}</p><p>{bundlePath}</p><button className="desktop-button" onClick={goHome}>Back to runtime home</button></div>
      : <ThemeProvider followHost followSystem>
        <SoftNWithXDB
          key={runtimeAppId ?? undefined}
          source={mainSource}
          scriptExecutionMode="main"
          resumeSavedSyncRoom={false}
          appId={runtimeAppId ?? undefined}
          permissions={_manifest?.permissions}
          importResolver={importResolver}
          assetResolver={assetResolver}
          logicBasePath={logicBasePath}
          preIncludedLogicPaths={preIncludedLogicPaths}
          permissionConfig={permissionConfig ?? undefined}
          {...serverConfig}
          onLoad={() => {
            if (isTauri && !isMobile) {
              void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(`${_manifest?.config?.window?.title || _manifest?.name || 'App'} — Softn`)).catch(() => {});
            }
          }}
          functions={{ asset: (path: unknown) => typeof path === 'string' ? assetResolver?.(path) || '' : '' }}
          loading={<div className="desktop-state" role="status"><Spinner size="lg" /><p>Starting your app…</p></div>}
          error={(err) => <div className="desktop-state" role="alert"><h1>The app encountered a problem</h1><p className="desktop-error">{err.message}</p><button className="desktop-button" onClick={goHome}>Back to runtime home</button></div>}
        />
      </ThemeProvider>}
  </DesktopShell>;
}

export default App;
