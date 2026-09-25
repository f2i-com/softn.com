/**
 * SoftN Loader Application
 *
 * A dedicated runtime for opening and rendering .softn application bundles.
 * Double-click any .softn file to open it with this app.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { registerAllBuiltins, ThemeProvider } from '@softn/components';
import {
  SoftNWithXDB,
  XDBStorageNotice,
  readBundleEntries,
  classifyAsset,
  extractPermissions,
  readManifest,
  type ComposedBundleSource,
  type PermissionConfig,
  type AppAssetResolver,
} from '@softn/core';
import { Spinner } from '@softn/components';
import { DesktopShell, DesktopWelcome } from './DesktopShell';
import { createBundleAssetResolver } from './bundleAssets';
import { isSoftnPath, resolveServerConfig, type BundleServerConfig } from './runtimeConfig';
import { createBundleImportResolver } from './remoteImport';
import { computeBundleAppId, loadBundleXDBData, processBundleSource } from './bundleRuntime';
// The consent rule, bar and dialog every host that runs one bundle shares
// (@softn/runtime-shell), so a bundle is asked in the same words here as in
// the browser. Grants stay under this loader's own prefix, where earlier
// versions wrote them.
import { grantKey, hasSavedGrant, requestedCapabilities, saveGrant, withheldPermissions } from '@softn/runtime-shell/consent';
import { PermissionBar, DESKTOP_WORDING, type ConsentRequest } from '@softn/runtime-shell/PermissionBar';
import { createNativeFetch, createNativeNetFetch } from './nativeNetFetch';
import { shortIdentity, type PendingUpgrade } from './installations';
import {
  UpgradeBlockedError,
  abandonUpgrade,
  finishUpgrade,
  resolveDataIdentity,
  type AbandonOutcome,
  type InstallationChoice,
  type LoaderDecision,
  type LoaderQuestion,
  type RecoveryRequiredChoice,
  type RegistryDamagedChoice,
  type UnresolvedUpgradeChoice,
  type UpgradeInProgress,
} from './upgradeFlow';
import { debug } from '@softn/core';

export { UpgradeBlockedError } from './upgradeFlow';

/** A question shown by the loader, with the answer channel attached. */
type LoaderChoice = LoaderQuestion & { resolve: (decision: LoaderDecision) => void };

function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined {
  // @ts-expect-error - Tauri invoke
  return window.__TAURI__?.core?.invoke as ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
}

/**
 * Consistent SQLite snapshot of the installation's data, written by the
 * native side beside the database; throws when it cannot be verified. The
 * page never learns or chooses a file system path.
 */
async function backupBeforeUpgrade(dataId: string): Promise<string> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('the native database is not available in this environment');
  const written = await invoke('backup_database', { appId: dataId });
  if (typeof written !== 'string' || !written) throw new Error('the backup was not written');
  return written;
}

/** Restore the data namespace from a pre-upgrade snapshot (local scope: this device only). */
async function restoreFromBackup(dataId: string, backup: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('the native database is not available in this environment');
  await invoke('restore_database', { appId: dataId, backup });
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
  /** Absent in a manifest that names only its entry; core's readManifest fills the groups in. */
  files?: {
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
    /** Where the bundle asked its script to run; only the literal 'worker' asks for a worker. */
    execution?: string;
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
    debug(`[SoftN Loader] Skipping unsupported icon format: ${manifest.icon}`);
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
    debug(`[SoftN Loader] Window icon set from: ${manifest.icon}`);
  } catch (err) {
    console.error('[SoftN Loader] Failed to set window icon:', err);
  }
}

/**
 * Where an Allow is remembered. The loader's own prefix, the one earlier
 * versions wrote under, so a package allowed before still opens allowed. (The
 * bar needs no height report: the shell measures it with its header.)
 */
const GRANT_KEY_PREFIX = 'softn-loader:grant:';

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
  // A Python app's project. Without it the renderer has only the empty logic
  // block the composer leaves in the markup, and the app runs no logic.
  const [python, setPython] = useState<ComposedBundleSource['python']>();
  // What the app runs with: its declaration once allowed, everything withheld
  // until then. `consent` is the request the bar shows while it is withheld.
  const [permissionConfig, setPermissionConfig] = useState<PermissionConfig | null>(null);
  const [consent, setConsent] = useState<ConsentRequest | null>(null);
  // The element the app renders in: where focus goes back to after Allow.
  const contentRef = useRef<HTMLElement>(null);
  const [installationChoice, setInstallationChoice] = useState<LoaderChoice | null>(null);
  const upgradeInProgress = useRef<UpgradeInProgress | null>(null);
  const [upgradeNotice, setUpgradeNotice] = useState<string | null>(null);
  const [assetResolver, setAssetResolver] = useState<AppAssetResolver>();
  const [serverConfig, setServerConfig] = useState(() => resolveServerConfig());
  // `softn.net.fetch` goes through the native side, under the config the app
  // is running with (see nativeNetFetch.ts). A new one on Allow is what makes
  // the renderer rebuild the runtime with the granted config.
  const netFetchHandler = useMemo(() => {
    const invoke = tauriInvoke();
    return invoke && permissionConfig ? createNativeNetFetch(permissionConfig, invoke) : undefined;
  }, [permissionConfig]);

  // Open a file picker to choose a .softn file. On the desktop the native
  // side opens the picker and records the choice, so only files the person
  // chose can be read back (see read_softn_bundle in src-tauri); on Android
  // the plugin's picker returns a content URI that plugin-fs reads.
  const openFilePicker = async () => {
    try {
      if (!isMobile) {
        const invoke = tauriInvoke();
        if (!invoke) throw new Error('the native file picker is not available in this environment');
        const selected = await invoke('pick_softn_bundle');
        if (typeof selected === 'string' && selected) selectBundle(selected);
        return;
      }
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        // On Android, custom extensions may not be filterable, so accept all files
        filters: [],
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

    // The question the identity flow is waiting on, if any: a newer selection
    // answers it with "cancel" so the old continuation stops before any new
    // side effect (R4-SN-01), and the dialog disappears.
    let pendingQuestion: ((decision: LoaderDecision) => void) | null = null;
    const cleanup = () => {
      setConsent(null);
      for (const controller of remoteControllers) controller.abort();
      remoteControllers.clear();
      if (pendingQuestion) {
        const answer = pendingQuestion;
        pendingQuestion = null;
        setInstallationChoice(null);
        answer({ kind: 'cancel' });
      }
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

        // The one manifest read every host shares (core's readManifest): a
        // manifest without `files` opens, and one that cannot run is refused
        // in the inspector's words rather than as a raw SyntaxError.
        const parsedManifest = readManifest<BundleManifest>(textFiles);

        // Keep this load's parsed config in the closure as well as state. React
        // state updates are asynchronous; reading `permissionConfig` below
        // would otherwise inspect the previously opened bundle's policy.
        //
        // Core's read, shared with the browser runtime and the single-app
        // hosts: permission.json when the bundle ships one, else the legacy
        // `manifest.permissions` block, which this loader used to ignore, so
        // a bundle published before permission.json existed ran with the
        // network in the browser and was refused it here (audit-core 2.2).
        //
        // A bundle that ships neither declared nothing, and runs as exactly
        // that: an empty declaration, as it does in the web runtime and the
        // single-app shell. Handed no config at all, the renderer and the
        // device components read "no host is enforcing" (the reading a
        // preview outside any bundle needs), and the least-trusted bundles got
        // the camera, the microphone and remote images unasked.
        const declaredConfig: PermissionConfig = extractPermissions(textFiles, parsedManifest) ?? { permissions: {} };

        // Withheld until the person allows it, and remembered per package and
        // per declaration (grantKey in @softn/runtime-shell/consent), so a
        // package that changes what it asks for asks again. A bundle that asks
        // for nothing has nothing to consent to and raises no bar.
        const requested = requestedCapabilities(declaredConfig);
        const consentKey = grantKey(resolvedAppId, declaredConfig, GRANT_KEY_PREFIX);
        const alreadyGranted = requested.length === 0 || hasSavedGrant(consentKey);
        const runningConfig = alreadyGranted ? declaredConfig : withheldPermissions(declaredConfig);

        const resolvedServerConfig = resolveServerConfig(parsedManifest.config?.server);
        setManifest(parsedManifest);

        // Data identity (audit SN-03): the digest is the integrity identity;
        // the data namespace may be an installation this package upgrades.
        upgradeInProgress.current = null;
        setUpgradeNotice(null);
        const identity = await resolveDataIdentity(
          resolvedAppId,
          parsedManifest,
          question => new Promise<LoaderDecision>(resolve => {
            if (!active) { resolve({ kind: 'cancel' }); return; }
            pendingQuestion = resolve;
            setInstallationChoice({ ...question, resolve: decision => { pendingQuestion = null; setInstallationChoice(null); resolve(decision); } });
          }),
          backupBeforeUpgrade,
          restoreFromBackup,
          undefined,
          { get aborted() { return !active; } }
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

        const { source, logicBasePath, preIncludedLogicPaths, python } = processBundleSource(
          textFiles,
          parsedManifest
        );
        debug('[SoftN Loader] Final source prepared with inlined components');

        // A remote `import` is network access as surely as fetch() in the
        // app's logic, so it is withheld with the rest, and made through the
        // native side for the same reason fetch() is.
        const invoke = tauriInvoke();
        const importResolverFor = (config: PermissionConfig) => createBundleImportResolver(textFiles, {
          permissionConfig: config,
          isActive: () => active,
          trackController: (controller) => {
            remoteControllers.add(controller);
            return () => remoteControllers.delete(controller);
          },
          ...(invoke ? { fetchImpl: createNativeFetch(config, invoke) } : {}),
        });
        const resolver = importResolverFor(runningConfig);
        // Allow upgrades the running app in place: a new config and import
        // resolver make the renderer rebuild the script runtime and keep the
        // state the person already has, as the web runtime's grant does.
        const onAllow = () => {
          if (!active) return;
          saveGrant(consentKey);
          setPermissionConfig(declaredConfig);
          setImportResolver(() => importResolverFor(declaredConfig));
          setConsent(null);
        };

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
        setPermissionConfig(runningConfig);
        setConsent(alreadyGranted ? null : {
          config: declaredConfig,
          capabilities: requested,
          appName: parsedManifest.name,
          onAllow,
        });
        setImportResolver(() => resolver);
        setAssetResolver(() => loadedAssets);
        setServerConfig(resolvedServerConfig);
        setRuntimeAppId(dataId);
        setLogicBasePath(logicBasePath);
        setPreIncludedLogicPaths(preIncludedLogicPaths);
        setPython(python);
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
    setConsent(null);
    if (isTauri && !isMobile) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle('Softn — Desktop runtime')).catch(() => {});
    }
  };

  const running = Boolean(bundlePath) && !loading && !error;
  // Runtime chrome, above the app and outside its theme, so the bundle cannot
  // paint it as its own UI.
  const consentBar = running && consent
    ? <PermissionBar {...consent} wording={DESKTOP_WORDING} appRootRef={contentRef} />
    : null;

  return <DesktopShell contentRef={contentRef} appName={bundlePath ? _manifest?.name : undefined} chrome={consentBar} onHome={goHome} onOpen={openFilePicker} canOpen={isTauri || isMobile}>
    {installationChoice?.kind === 'upgrade' && <InstallationChoiceDialog choice={installationChoice} />}
    {installationChoice?.kind === 'registry-damaged' && <RegistryDamagedDialog choice={installationChoice} />}
    {installationChoice?.kind === 'upgrade-unresolved' && <UnresolvedUpgradeDialog choice={installationChoice} />}
    {installationChoice?.kind === 'recovery-required' && <RecoveryRequiredDialog choice={installationChoice} />}
    {!bundlePath && !loading ? <DesktopWelcome onOpen={openFilePicker} canOpen={isTauri || isMobile} dragging={isDragOver} error={error} />
      : loading ? <div className="desktop-state" role="status"><Spinner size="lg" /><p>Opening {bundlePath?.split(/[/\\]/).pop() || 'your app'}…</p></div>
      : error ? <div className="desktop-state" role="alert"><h1>We couldn’t open this app</h1><p className="desktop-error">{error.message}</p><p>{bundlePath}</p><button className="desktop-button" onClick={goHome}>Back to runtime home</button></div>
      : <ThemeProvider followHost followSystem>
        <XDBStorageNotice appId={runtimeAppId ?? undefined} />
        <SoftNWithXDB
          key={runtimeAppId ?? undefined}
          source={mainSource}
          executionPreference={_manifest?.config?.execution === 'worker' ? 'worker' : 'main'}
          resumeSavedSyncRoom={false}
          appId={runtimeAppId ?? undefined}
          permissions={_manifest?.permissions}
          importResolver={importResolver}
          assetResolver={assetResolver}
          logicBasePath={logicBasePath}
          preIncludedLogicPaths={preIncludedLogicPaths}
          python={python}
          permissionConfig={permissionConfig ?? undefined}
          netFetchHandler={netFetchHandler}
          {...serverConfig}
          onLoad={() => {
            // A staged upgrade is complete only now that the new package started (R2-SN-03).
            const upgrade = upgradeInProgress.current;
            if (upgrade) {
              const outcome = finishUpgrade(upgrade);
              if (outcome.finalized) {
                upgradeInProgress.current = null;
              } else {
                // The pending record is still the truth. The app is NOT left
                // running on unfinalized data (R3-SN-01): it is closed with the
                // pending record intact, so reopening the file resumes the same
                // operation with the same backup, and the older package stays
                // gated until then.
                upgradeInProgress.current = null;
                setError(new UpgradeBlockedError(`The app started, but the upgrade could not be recorded (${outcome.reason}). It was closed so the pre-upgrade backup stays valid: free storage in this runtime and reopen the file to finish the upgrade. Your data is intact.`));
                return;
              }
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
  const [outcome, setOutcome] = useState<AbandonOutcome | null>(upgrade.current ? null : { restored: false, finalized: false, message: '' });
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
    {outcome === null ? <p role="status">Restoring the data from the pre-upgrade backup…</p> : outcome.message ? <p className={outcome.restored && outcome.finalized ? undefined : 'desktop-error'}>{outcome.message}</p> : null}
    <button className="desktop-button" disabled={outcome === null} onClick={onHome}>Back to runtime home</button>
  </div>;
}

/** The installation registry could not be read: decide before anything is opened (R2-SN-03). */
function RegistryDamagedDialog({ choice }: { choice: RegistryDamagedChoice & { resolve: (decision: LoaderDecision) => void } }) {
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
/**
 * An upgrade of this installation to another package never finished
 * (R3-SN-01): the newer package may already have changed the data, so this
 * older package is not run against it until the person decides.
 */
/**
 * A failed upgrade could not be rolled back (R4-SN-02): the installation is
 * blocked until the verified backup is restored AND that recovery is
 * recorded. Retry here, or keep the backup file for a manual recovery.
 */
function RecoveryRequiredDialog({ choice }: { choice: RecoveryRequiredChoice & { resolve: (decision: LoaderDecision) => void } }) {
  const { recovery } = choice;
  return <div className="desktop-state" role="dialog" aria-modal="true" aria-labelledby="recovery-required-title" data-testid="recovery-required">
    <h1 id="recovery-required-title">{choice.name || 'This app'} needs recovery</h1>
    <p>On {new Date(recovery.at).toLocaleString()} an upgrade of this installation failed and its data could not be put back from the pre-upgrade backup ({recovery.reason}). Until that backup is restored, no package is run against this data.</p>
    <p><strong>Restore the backup and retry</strong> restores the verified pre-upgrade snapshot again. The installation is unblocked only when both the restore and its record succeed; otherwise it stays blocked and says why.</p>
    <p><strong>Cancel</strong> leaves everything as it is. The backup file below is a complete SQLite copy of the pre-upgrade data and can be recovered from by hand.</p>
    <p className="desktop-muted">Backup: <code>{recovery.backup}</code></p>
    <div className="desktop-actions">
      <button className="desktop-button" onClick={() => choice.resolve({ kind: 'retry-restore' })}>Restore the backup and retry</button>
      <button className="desktop-button desktop-button-primary" onClick={() => choice.resolve({ kind: 'cancel' })}>Cancel</button>
    </div>
  </div>;
}

function UnresolvedUpgradeDialog({ choice }: { choice: UnresolvedUpgradeChoice & { resolve: (decision: LoaderDecision) => void } }) {
  const pending: PendingUpgrade = choice.pending;
  return <div className="desktop-state" role="dialog" aria-modal="true" aria-labelledby="upgrade-unresolved-title" data-testid="upgrade-unresolved">
    <h1 id="upgrade-unresolved-title">An upgrade of {choice.name || 'this app'} was not finished</h1>
    <p>On {new Date(pending.at).toLocaleString()} an upgrade of this installation to package <code>{shortIdentity(pending.to)}</code>{pending.version ? ` (version ${pending.version})` : ''} was approved, but that package never confirmed it started. Its data may already have been changed, so the package you opened will not run against it until this is resolved.</p>
    <p><strong>Restore the backup and open this version</strong> puts the data back to the verified pre-upgrade snapshot taken at approval time and clears the unfinished upgrade. Changes the newer package made after that snapshot are discarded.</p>
    <p><strong>Cancel</strong> leaves everything as it is. To finish the upgrade instead, open the newer package file: it resumes with the same backup.</p>
    <p className="desktop-muted">Backup: <code>{pending.backup}</code></p>
    <div className="desktop-actions">
      <button className="desktop-button" onClick={() => choice.resolve({ kind: 'rollback' })}>Restore the backup and open this version</button>
      <button className="desktop-button desktop-button-primary" onClick={() => choice.resolve({ kind: 'cancel' })}>Cancel</button>
    </div>
  </div>;
}

function InstallationChoiceDialog({ choice }: { choice: InstallationChoice & { resolve: (decision: LoaderDecision) => void } }) {
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
