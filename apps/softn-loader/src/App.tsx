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
  XDBStorageNotice,
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
import {
  beginUpgrade,
  completeUpgrade,
  loadRegistry,
  recordNewInstallation,
  resolveInstallation,
  rollbackUpgrade,
  saveRegistry,
  shortIdentity,
  type InstallationRecord,
} from './installations';

/** The question a changed package asks before it touches any data (audit SN-03). */
interface InstallationChoice {
  kind: 'upgrade';
  bundleId: string;
  name: string;
  version?: string;
  candidates: InstallationRecord[];
  resolve: (decision: { kind: 'new' } | { kind: 'upgrade'; dataId: string } | { kind: 'cancel' }) => void;
}

/** The registry itself is unreadable: nothing about an unknown package can be decided (R2-SN-03). */
interface RegistryDamagedChoice {
  kind: 'registry-damaged';
  quarantineKey: string | null;
  reason: string;
  resolve: (decision: { kind: 'discard' } | { kind: 'cancel' }) => void;
}

type LoaderChoice = InstallationChoice | RegistryDamagedChoice;

/** What an upgrade left behind for the running session to finish (R2-SN-03). */
interface UpgradeInProgress {
  dataId: string;
  bundleId: string;
  backup: string;
}

export class UpgradeBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'UpgradeBlockedError'; }
}

/** The runtime's own storage for the installation registry; never an app's records. */
function registryStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void } {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Opaque origin: fall back to a per-session registry (every package opens as new).
  }
  const memory = new Map<string, string>();
  return { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); } };
}

type IdentityDecision = { dataId: string; upgrade?: UpgradeInProgress };

/**
 * Resolve the DATA identity for an opened bundle. The digest stays the
 * integrity identity; a mapped digest reuses its data namespace; an unmapped
 * digest that repeats an installed name asks the person before anything is
 * seeded or shown (open as new, or upgrade one installation). Nothing is
 * ever inherited on a name alone.
 *
 * An upgrade is STAGED, not approved (R2-SN-03): it needs a verified backup
 * and a durable registry write first, otherwise it stops with an actionable
 * error; the digest is mapped only when the new package has started, and a
 * failed start restores the snapshot and drops the staging.
 */
export async function resolveDataIdentity(
  bundleId: string,
  manifest: { name?: string; version?: string },
  ask: (choice: Omit<InstallationChoice, 'resolve'> | Omit<RegistryDamagedChoice, 'resolve'>) => Promise<{ kind: 'new' } | { kind: 'upgrade'; dataId: string } | { kind: 'discard' } | { kind: 'cancel' }>,
  backup: (dataId: string) => Promise<string>,
  storage: RegistryStorageLike = registryStorage()
): Promise<IdentityDecision | null> {
  let registry = loadRegistry(storage);
  let resolution = resolveInstallation(registry, bundleId, manifest.name);
  if (resolution.kind === 'registry-damaged') {
    const decision = await ask({ kind: 'registry-damaged', quarantineKey: resolution.quarantineKey, reason: resolution.reason });
    if (decision.kind !== 'discard') return null;
    // The quarantined copy stays; a fresh registry replaces the damaged key.
    if (!saveRegistry(storage, registry, { acknowledgeDamage: true })) {
      throw new UpgradeBlockedError('The installation records could not be rewritten. Nothing was opened.');
    }
    registry = loadRegistry(storage);
    resolution = resolveInstallation(registry, bundleId, manifest.name);
    if (resolution.kind === 'registry-damaged') throw new UpgradeBlockedError('The installation records are still unreadable after discarding them. Nothing was opened.');
  }
  if (resolution.kind === 'recovery-required') {
    const r = resolution.record.recoveryRequired!;
    throw new UpgradeBlockedError(`This installation needs recovery before it can be opened: a failed upgrade could not be rolled back (${r.reason}). Its pre-upgrade backup is ${r.backup}.`);
  }
  if (resolution.kind === 'pending-upgrade') {
    // The previous session approved this upgrade and never confirmed it
    // started. Try again with the SAME backup; completion is recorded on load.
    return { dataId: resolution.dataId, upgrade: { dataId: resolution.dataId, bundleId, backup: resolution.pending.backup } };
  }
  if (resolution.kind === 'known') return { dataId: resolution.dataId };
  const persistNew = (): IdentityDecision => {
    recordNewInstallation(registry, bundleId, manifest.name, manifest.version);
    if (!saveRegistry(storage, registry)) {
      throw new UpgradeBlockedError('The installation record could not be saved, so this app was not opened: its data would be lost after a restart. Free storage and try again.');
    }
    return { dataId: bundleId };
  };
  if (resolution.kind === 'new') return persistNew();
  const choice = resolution;
  const decision = await ask({ kind: 'upgrade', bundleId, name: choice.name, version: manifest.version, candidates: choice.candidates });
  if (decision.kind === 'cancel' || decision.kind === 'discard') return null;
  if (decision.kind === 'new') return persistNew();

  // Upgrade: verified snapshot FIRST, then a durable staging record, then the
  // package may touch the data. Either failure stops the upgrade unapplied.
  let backupPath: string;
  try {
    backupPath = await backup(decision.dataId);
  } catch (error) {
    throw new UpgradeBlockedError(`The upgrade was not applied because a backup of the installed data could not be taken (${error instanceof Error ? error.message : String(error)}). Reopen the previous package, or free disk space and try again.`);
  }
  beginUpgrade(registry, bundleId, decision.dataId, { backup: backupPath, manifestName: manifest.name, version: manifest.version });
  if (!saveRegistry(storage, registry)) {
    throw new UpgradeBlockedError('The upgrade was not applied because its record could not be saved; without it the upgrade would be forgotten after a restart. Free storage and try again.');
  }
  return { dataId: decision.dataId, upgrade: { dataId: decision.dataId, bundleId, backup: backupPath } };
}

type RegistryStorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** The new package started: map its digest durably. */
export function finishUpgrade(upgrade: UpgradeInProgress, storage: RegistryStorageLike = registryStorage()): boolean {
  const registry = loadRegistry(storage);
  if (registry.damaged || !registry.installations[upgrade.dataId]?.pendingUpgrade) return false;
  completeUpgrade(registry, upgrade.dataId);
  return saveRegistry(storage, registry);
}

/**
 * The new package failed to start: put the data snapshot back and drop the
 * staged upgrade, or leave an explicit recovery-only state when the snapshot
 * cannot be restored. Reopening the old package is never called a rollback.
 */
export async function abandonUpgrade(
  upgrade: UpgradeInProgress,
  restore: (dataId: string, backup: string) => Promise<void>,
  storage: RegistryStorageLike = registryStorage()
): Promise<{ restored: boolean; message: string }> {
  const registry = loadRegistry(storage);
  const record = registry.installations[upgrade.dataId];
  if (registry.damaged || !record?.pendingUpgrade) return { restored: false, message: 'The upgrade record is missing; the installed data was not changed by this loader.' };
  try {
    await restore(upgrade.dataId, upgrade.backup);
    rollbackUpgrade(registry, upgrade.dataId, { restored: true });
    saveRegistry(storage, registry);
    return { restored: true, message: 'The app failed to start, so its data was restored from the pre-upgrade backup and the upgrade was undone.' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    rollbackUpgrade(registry, upgrade.dataId, { restored: false, reason });
    saveRegistry(storage, registry);
    return { restored: false, message: `The app failed to start AND its data could not be restored from the pre-upgrade backup (${reason}). The installation is in a recovery-only state; the backup is at ${upgrade.backup}.` };
  }
}

function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined {
  // @ts-expect-error - Tauri invoke
  return window.__TAURI__?.core?.invoke as ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
}

/** Consistent SQLite snapshot of the installation's data; throws when it cannot be verified. */
async function backupBeforeUpgrade(dataId: string): Promise<string> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('the native database is not available in this environment');
  const dbPath = String(await invoke('get_db_path', { appId: dataId }));
  const separator = dbPath.includes('\\') ? '\\' : '/';
  const directory = dbPath.slice(0, dbPath.lastIndexOf(separator));
  const target = `${directory}${separator}pre-upgrade-${Date.now().toString(36)}.sqlite`;
  const written = await invoke('export_database', { appId: dataId, path: target });
  if (written !== target) throw new Error('the backup was not written where expected');
  return target;
}

/** Restore the data namespace from a pre-upgrade snapshot (local scope: this device only). */
async function restoreFromBackup(dataId: string, backup: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('the native database is not available in this environment');
  await invoke('import_database', { appId: dataId, sourcePath: backup, scope: 'local' });
}

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
  const [installationChoice, setInstallationChoice] = useState<LoaderChoice | null>(null);
  const upgradeInProgress = useRef<UpgradeInProgress | null>(null);
  const [upgradeNotice, setUpgradeNotice] = useState<string | null>(null);
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

        // Data identity (audit SN-03): the digest is the integrity identity;
        // the data namespace may be an installation this package upgrades.
        upgradeInProgress.current = null;
        setUpgradeNotice(null);
        const identity = await resolveDataIdentity(
          resolvedAppId,
          parsedManifest,
          choice => new Promise(resolve => {
            if (!active) { resolve({ kind: 'cancel' }); return; }
            setInstallationChoice({ ...choice, resolve: (decision: { kind: 'new' } | { kind: 'upgrade'; dataId: string } | { kind: 'discard' } | { kind: 'cancel' }) => { setInstallationChoice(null); resolve(decision); } } as LoaderChoice);
          }),
          backupBeforeUpgrade
        );
        if (!active) return;
        if (identity === null) {
          // The person cancelled: nothing was seeded or mapped.
          cleanup();
          setBundlePath(null);
          setLoading(false);
          return;
        }
        const dataId = identity.dataId;
        upgradeInProgress.current = identity.upgrade ?? null;

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
        await loadBundleXDBData(textFiles, parsedManifest, dataId, () => active);
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
        setRuntimeAppId(dataId);
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
    {installationChoice?.kind === 'upgrade' && <InstallationChoiceDialog choice={installationChoice} />}
    {installationChoice?.kind === 'registry-damaged' && <RegistryDamagedDialog choice={installationChoice} />}
    {!bundlePath && !loading ? <DesktopWelcome onOpen={openFilePicker} canOpen={isTauri || isMobile} dragging={isDragOver} error={error} />
      : loading ? <div className="desktop-state" role="status"><Spinner size="lg" /><p>Opening {bundlePath?.split(/[/\\]/).pop() || 'your app'}…</p></div>
      : error ? <div className="desktop-state" role="alert"><h1>We couldn’t open this app</h1><p className="desktop-error">{error.message}</p><p>{bundlePath}</p><button className="desktop-button" onClick={goHome}>Back to runtime home</button></div>
      : <ThemeProvider followHost followSystem>
        <XDBStorageNotice appId={runtimeAppId ?? undefined} />
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
            // A staged upgrade is complete only now that the new package started (R2-SN-03).
            const upgrade = upgradeInProgress.current;
            if (upgrade) {
              upgradeInProgress.current = null;
              if (!finishUpgrade(upgrade)) setUpgradeNotice('The app started, but the upgrade record could not be saved. Until it can be, reopening this file will ask about the upgrade again; your data is intact.');
            }
            if (isTauri && !isMobile) {
              void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(`${_manifest?.config?.window?.title || _manifest?.name || 'App'} — Softn`)).catch(() => {});
            }
          }}
          functions={{ asset: (path: unknown) => typeof path === 'string' ? assetResolver?.(path) || '' : '' }}
          loading={<div className="desktop-state" role="status"><Spinner size="lg" /><p>Starting your app…</p></div>}
          error={(err) => <UpgradeAwareError error={err} upgrade={upgradeInProgress} onHome={goHome} />}
        />
        {upgradeNotice && <p role="status" className="desktop-error">{upgradeNotice}</p>}
      </ThemeProvider>}
  </DesktopShell>;
}

/**
 * The app failed to start. If a staged upgrade was in progress, the data
 * snapshot is restored and the staging dropped BEFORE the person is told
 * what happened (R2-SN-03); the message states exactly what remains.
 */
function UpgradeAwareError({ error, upgrade, onHome }: { error: Error; upgrade: React.MutableRefObject<UpgradeInProgress | null>; onHome: () => void }) {
  const [outcome, setOutcome] = useState<{ restored: boolean; message: string } | null>(upgrade.current ? null : { restored: false, message: '' });
  useEffect(() => {
    const pending = upgrade.current;
    if (!pending) return;
    upgrade.current = null;
    let alive = true;
    void abandonUpgrade(pending, restoreFromBackup).then(result => { if (alive) setOutcome(result); });
    return () => { alive = false; };
  }, [upgrade]);
  return <div className="desktop-state" role="alert">
    <h1>The app encountered a problem</h1>
    <p className="desktop-error">{error.message}</p>
    {outcome === null ? <p role="status">Restoring the data from the pre-upgrade backup…</p> : outcome.message ? <p className={outcome.restored ? undefined : 'desktop-error'}>{outcome.message}</p> : null}
    <button className="desktop-button" disabled={outcome === null} onClick={onHome}>Back to runtime home</button>
  </div>;
}

/** The installation registry could not be read: decide before anything is opened (R2-SN-03). */
function RegistryDamagedDialog({ choice }: { choice: RegistryDamagedChoice }) {
  return <div className="desktop-state" role="dialog" aria-modal="true" aria-labelledby="registry-damaged-title" data-testid="registry-damaged">
    <h1 id="registry-damaged-title">Installation records are damaged</h1>
    <p>The record of which packages belong to which installed data could not be read ({choice.reason}). Until it is resolved, no package can be matched to existing data, so nothing was opened.</p>
    <p>{choice.quarantineKey ? `The damaged record was kept under "${choice.quarantineKey}" in this runtime's storage for recovery.` : 'The damaged record could not be copied aside; it is still in place.'}</p>
    <p><strong>Discard the damaged records</strong> starts a fresh registry: installed apps keep their data on disk, but each package will be matched again when it is next opened (it may ask whether it is a new app or an upgrade).</p>
    <div className="desktop-actions">
      <button className="desktop-button" onClick={() => choice.resolve({ kind: 'discard' })}>Discard damaged records</button>
      <button className="desktop-button desktop-button-primary" onClick={() => choice.resolve({ kind: 'cancel' })}>Cancel</button>
    </div>
  </div>;
}

/**
 * "This package is not the one that was installed" (audit SN-03). Shows both
 * identities and what each choice means, and never defaults to inheriting.
 */
function InstallationChoiceDialog({ choice }: { choice: InstallationChoice }) {
  const [target, setTarget] = useState<string>(choice.candidates[0]?.dataId ?? '');
  const selected = choice.candidates.find(c => c.dataId === target);
  return <div className="desktop-state" role="dialog" aria-modal="true" aria-labelledby="installation-choice-title" data-testid="installation-choice">
    <h1 id="installation-choice-title">Is this a new version of {choice.name || 'this app'}?</h1>
    <p>The file you opened is a different package from the one installed under this name. Its contents have not been checked by a publisher signature, so only you can say whether it belongs to the same app.</p>
    <dl className="desktop-identity">
      <dt>Package you opened</dt><dd><code>{shortIdentity(choice.bundleId)}</code>{choice.version ? ` · version ${choice.version}` : ''}</dd>
      <dt>Installed data</dt>
      <dd>
        {choice.candidates.length > 1
          ? <select value={target} onChange={event => setTarget(event.target.value)} aria-label="Installation to upgrade">{choice.candidates.map(c => <option key={c.dataId} value={c.dataId}>{c.name} · {shortIdentity(c.dataId)}{c.version ? ` · v${c.version}` : ''} · updated {new Date(c.updatedAt).toLocaleDateString()}</option>)}</select>
          : <><code>{shortIdentity(target)}</code>{selected?.version ? ` · version ${selected.version}` : ''} · installed {selected ? new Date(selected.createdAt).toLocaleDateString() : ''}</>}
      </dd>
    </dl>
    <p><strong>Upgrade this installation</strong> keeps its saved records: a verified backup of the database is taken first (the upgrade stops if that fails), the new package&apos;s starting data is only added for records that do not exist yet, and if the new package fails to start the data is restored from that backup. Reopening the previous file reaches the same records, but that is not a rollback of changes the new package made. Permissions are not carried over; this package&apos;s own permission list applies.</p>
    <p><strong>Open as a new app</strong> starts with fresh data and leaves the installed app untouched. Choose this if you do not trust where this file came from: a package that merely repeats the name must not read the installed app&apos;s records.</p>
    <div className="desktop-actions">
      <button className="desktop-button desktop-button-primary" onClick={() => choice.resolve({ kind: 'new' })}>Open as a new app</button>
      <button className="desktop-button" disabled={!selected} onClick={() => selected && choice.resolve({ kind: 'upgrade', dataId: selected.dataId })}>Upgrade this installation</button>
      <button className="desktop-button" onClick={() => choice.resolve({ kind: 'cancel' })}>Cancel</button>
    </div>
  </div>;
}

export default App;
