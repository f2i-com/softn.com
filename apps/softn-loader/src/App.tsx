/**
 * SoftN Loader Application
 *
 * A dedicated runtime for opening and rendering .softn application bundles.
 * Double-click any .softn file to open it with this app.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { Spinner } from '@softn/components/essentials';
import { ThemeProvider } from '@softn/components/theme';
import {
  SoftNWithXDB,
  XDBStorageNotice,
  extractPermissions,
  readManifest,
  type ComposedBundleSource,
  type PermissionConfig,
  type AppAssetResolver,
} from '@softn/core';
// The bundle pipeline the browser hosts use: one archive reader, composer,
// XDB seed, asset and import resolver, judged by the same rules. The loader
// kept a copy of each, and the copies had drifted.
import {
  createAssetResolver,
  createImportResolver,
  loadXDBData,
  processBundle,
  readZip,
  type BundleBinaryReader,
  type BundleManifest as SharedBundleManifest,
  type DisposableImportResolver,
} from '@softn/runtime-shell/bundleProcessor';
import { resolveServerConfig, type ServerSyncSettings } from '@softn/runtime-shell/net';
import { DesktopShell, DesktopWelcome } from './DesktopShell';
import { computeBundleAppId, isSoftnPath } from './bundleFile';
// The consent rule, bar and dialog every host that runs one bundle shares
// (@softn/runtime-shell), so a bundle is asked in the same words here as in
// the browser. Grants stay under this loader's own prefix, where earlier
// versions wrote them.
import { grantKey, hasSavedGrant, requestedCapabilities, saveGrant, withheldPermissions } from '@softn/runtime-shell/consent';
import { PermissionBar, DESKTOP_WORDING, type ConsentRequest } from '@softn/runtime-shell/PermissionBar';
import { createNativeFetch, createNativeNetFetch } from './nativeNetFetch';
import { shortIdentity, type PendingUpgrade } from './installations';
import { bindDataIdentity, chooseDataIdentity, nativeInvoke } from './nativeIdentity';
import {
  UpgradeBlockedError,
  abandonUpgrade,
  finishUpgrade,
  resolveDataIdentity,
  type AbandonOutcome,
  type LoaderDecision,
  type LoaderQuestion,
  type RecoveryRequiredChoice,
  type RegistryDamagedChoice,
  type UnresolvedUpgradeChoice,
  type UpgradeInProgress,
} from './upgradeFlow';
import { debug } from '@softn/core';

/** A question shown by the loader, with the answer channel attached. */
type LoaderChoice = LoaderQuestion & { resolve: (decision: LoaderDecision) => void };

/**
 * Consistent SQLite snapshot of the installation's data, written by the
 * native side beside the database; throws when it cannot be verified. The
 * page never learns or chooses a file system path.
 */
async function backupBeforeUpgrade(dataId: string): Promise<string> {
  const invoke = nativeInvoke();
  if (!invoke) throw new Error('the native database is not available in this environment');
  const written = await invoke('backup_database', { appId: dataId });
  if (typeof written !== 'string' || !written) throw new Error('the backup was not written');
  return written;
}

/** Restore the data namespace from a pre-upgrade snapshot (local scope: this device only). */
async function restoreFromBackup(dataId: string, backup: string): Promise<void> {
  const invoke = nativeInvoke();
  if (!invoke) throw new Error('the native database is not available in this environment');
  await invoke('restore_database', { appId: dataId, backup });
}

// Compile-time constant from Vite define
declare const __ANDROID__: boolean;

// The components, as the browser runtimes register them: the start-up set
// now, every other component (the light groups, charts, editors, Scene3D and
// Three.js, media) loaded the first time an app draws it.
registerRuntimeComponents();

// Check if running in Tauri
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

// Platform detection
const isMobile = typeof __ANDROID__ !== 'undefined' && __ANDROID__;

/** The name of the one box an app is drawn in here: the shell's content area. */
const THEME_BOX = 'desktop-app';

/**
 * The manifest as every host reads it, and what only the desktop reads
 * besides: the orientation to lock a phone to. Only the literal 'worker' in
 * `config.execution` asks for a worker.
 */
type BundleManifest = SharedBundleManifest & {
  config?: NonNullable<SharedBundleManifest['config']> & {
    mobile?: {
      orientation?: 'portrait' | 'landscape' | 'auto';
    };
  };
};

// Set window icon from bundle
async function setWindowIconFromBundle(
  binaryFiles: BundleBinaryReader,
  manifest: BundleManifest
): Promise<void> {
  // The manifest is the bundle's, read as it came: an icon written as a list
  // or a number stopped the app opening here, where the web runtime and the
  // single-app shell skip it.
  if (typeof manifest.icon !== 'string' || !manifest.icon) return;

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

  // Read from the archive on demand, and checked as it is read: a corrupt
  // icon is a window without one, not an app that will not open.
  let iconData: Uint8Array | undefined;
  try {
    iconData = binaryFiles.get(manifest.icon);
  } catch (err) {
    console.warn(`[SoftN Loader] Icon ${manifest.icon} could not be read from the bundle:`, err);
    return;
  }
  if (!iconData) {
    console.warn(`[SoftN Loader] Icon file not found in bundle: ${manifest.icon}`);
    return;
  }

  try {
    await nativeInvoke()?.('set_window_icon', {
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
  // Set when a load failed after it staged an upgrade: the failure is shown
  // as UpgradeAwareError, which restores the backup and drops the staging.
  const [failedWhileUpgrading, setFailedWhileUpgrading] = useState(false);
  const [assetResolver, setAssetResolver] = useState<AppAssetResolver>();
  const [serverConfig, setServerConfig] = useState<ServerSyncSettings>({});
  // `softn.net.fetch` goes through the native side, under the config the app
  // is running with (see nativeNetFetch.ts). A new one on Allow is what makes
  // the renderer rebuild the runtime with the granted config.
  const netFetchHandler = useMemo(() => {
    const invoke = nativeInvoke();
    return invoke && permissionConfig ? createNativeNetFetch(permissionConfig, invoke) : undefined;
  }, [permissionConfig]);

  // Open a file picker to choose a .softn file. The native side opens the
  // picker and records the choice, so only files the person chose can be read
  // back (see read_softn_bundle in src-tauri), and the file chosen last is the
  // app whose data the page may use (data_identity.rs). On Android the picker
  // returns a content URI, which the native side reads too: the page there has
  // no file system plugin, which read every app's database.
  const openFilePicker = async () => {
    try {
      const invoke = nativeInvoke();
      if (!invoke) throw new Error('the native file picker is not available in this environment');
      const selected = await invoke('pick_softn_bundle');
      if (typeof selected === 'string' && selected) selectBundle(selected);
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
        const openedFile = await nativeInvoke()?.('get_opened_file');
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
    // Every import resolver this load made: disposing one aborts its requests
    // and reads, and resolves nothing after.
    const importResolvers = new Set<DisposableImportResolver>();

    // The question the identity flow is waiting on, if any: a newer selection
    // answers it with "cancel" so the old continuation stops before any new
    // side effect (R4-SN-01), and the dialog disappears.
    let pendingQuestion: ((decision: LoaderDecision) => void) | null = null;
    const cleanup = () => {
      setConsent(null);
      for (const resolver of importResolvers) resolver.dispose();
      importResolvers.clear();
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
        setFailedWhileUpgrading(false);

        // The runtime hands the bytes over as an ArrayBuffer (an array of
        // numbers before; see read_softn_bundle in src-tauri).
        let rawData: ArrayBuffer | number[] | Uint8Array;

        if (isMobile && bundlePath!.startsWith('__intent__:')) {
          // Intent-opened file: read from app cache via Rust command
          const filename = bundlePath!.replace('__intent__:', '');
          rawData = (await nativeInvoke()?.('read_cached_bundle', { filename })) as ArrayBuffer;
        } else {
          // A path, or on Android the content URI the picker returned: read via Rust command
          rawData = (await nativeInvoke()?.('read_softn_bundle', {
            path: bundlePath,
          })) as ArrayBuffer;
        }

        if (!active) return;
        if (!rawData) {
          throw new Error('Failed to read bundle file');
        }

        const data = new Uint8Array(rawData);
        const resolvedAppId = await computeBundleAppId(data);
        if (!active) return;
        // Indexes the archive and reads its text; binaries are read, and
        // checked, when the icon or an asset() asks for them. Disposing the
        // asset resolver releases the archive.
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
        // Which data the page may use is the native side's decision
        // (nativeIdentity.ts): every step below that touches data binds it
        // there first, and "is this a new version of an installed app?" is
        // asked there, in a native dialog nothing in this page can answer.
        upgradeInProgress.current = null;
        setUpgradeNotice(null);
        const bindTo = (dataId: string, start = false) => bindDataIdentity(resolvedAppId, dataId, parsedManifest, start);
        const identity = await resolveDataIdentity(
          resolvedAppId,
          parsedManifest,
          question => question.kind === 'upgrade'
            ? chooseDataIdentity(question)
            : new Promise<LoaderDecision>(resolve => {
              if (!active) { resolve({ kind: 'cancel' }); return; }
              pendingQuestion = resolve;
              setInstallationChoice({ ...question, resolve: decision => { pendingQuestion = null; setInstallationChoice(null); resolve(decision); } });
            }),
          async dataId => { await bindTo(dataId); return backupBeforeUpgrade(dataId); },
          async (dataId, backup) => { await bindTo(dataId); return restoreFromBackup(dataId, backup); },
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
        // Bound before a staged upgrade is marked as in progress: a refusal
        // here leaves the staging for the next open to resume, and is not the
        // package failing to start, which would restore the backup. The last
        // bind for this open: the app is started on this data and no other.
        await bindTo(dataId, true);
        if (!active) return;
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

        // Load XDB data from bundle (await for Tauri backend). Seeding stops
        // as soon as another selection replaces this load.
        await loadXDBData(textFiles, parsedManifest, dataId, () => active);
        if (!active) return;

        // Set window icon from bundle (desktop only)
        if (!isMobile) {
          await setWindowIconFromBundle(binaryFiles, parsedManifest);
        }
        if (!active) return;

        const { source, logicBasePath, preIncludedLogicPaths, python } = processBundle(
          textFiles,
          parsedManifest
        );

        // A remote `import` is network access as surely as fetch() in the
        // app's logic, so it is withheld with the rest, judged by the same
        // rule (local network included), and made through the native side for
        // the same reason fetch() is.
        const invoke = nativeInvoke();
        const importResolverFor = (config: PermissionConfig) => {
          const resolver = createImportResolver(
            textFiles,
            config,
            invoke ? { fetchImpl: createNativeFetch(config, invoke) } : {}
          );
          importResolvers.add(resolver);
          return resolver;
        };
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

        loadedAssets = createAssetResolver(binaryFiles, textFiles);
        if (!active) { cleanup(); return; }
        // Update window title (desktop only)
        if (!isMobile && (parsedManifest.config?.window?.title || parsedManifest.name)) {
          try {
            const windowModule = await import('@tauri-apps/api/window');
            if (!active) return;
            const appWindow = windowModule.getCurrentWindow();
            await appWindow.setTitle(`Opening ${parsedManifest.config?.window?.title || parsedManifest.name} — SoftN`);
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
        // A failure after this load staged an upgrade is the package failing
        // to start, as much as one the runtime reports: the data goes back to
        // the pre-upgrade backup. Shown as the plain error, the staging and
        // the backup were left behind and the older package stayed gated.
        setFailedWhileUpgrading(upgradeInProgress.current !== null);
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
    setFailedWhileUpgrading(false);
    setManifest(null);
    setMainSource('');
    setRuntimeAppId(null);
    setAssetResolver(undefined);
    setImportResolver(undefined);
    setConsent(null);
    if (isTauri && !isMobile) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle('SoftN — Desktop runtime')).catch(() => {});
    }
  };

  const running = Boolean(bundlePath) && !loading && !error;
  // Runtime chrome, above the app and outside its theme, so the bundle cannot
  // paint it as its own UI.
  const consentBar = running && consent
    ? <PermissionBar {...consent} wording={DESKTOP_WORDING} appRootRef={contentRef} />
    : null;

  return <DesktopShell contentRef={contentRef} themeBox={THEME_BOX} appName={bundlePath ? _manifest?.name : undefined} chrome={consentBar} onHome={goHome} onOpen={openFilePicker} canOpen={isTauri || isMobile}>
    {installationChoice?.kind === 'registry-damaged' && <RegistryDamagedDialog choice={installationChoice} />}
    {installationChoice?.kind === 'upgrade-unresolved' && <UnresolvedUpgradeDialog choice={installationChoice} />}
    {installationChoice?.kind === 'recovery-required' && <RecoveryRequiredDialog choice={installationChoice} />}
    {!bundlePath && !loading ? <DesktopWelcome onOpen={openFilePicker} canOpen={isTauri || isMobile} dragging={isDragOver} error={error} />
      : loading ? <div className="desktop-state" role="status"><Spinner size="lg" /><p>Opening {bundlePath?.split(/[/\\]/).pop() || 'your app'}…</p></div>
      : error && failedWhileUpgrading ? <UpgradeAwareError error={error} upgrade={upgradeInProgress} onHome={goHome} />
      : error ? <div className="desktop-state" role="alert"><h1>We couldn’t open this app</h1><p className="desktop-error">{error.message}</p><p>{bundlePath}</p><button className="desktop-button" onClick={goHome}>Back to runtime home</button></div>
      // The side the project declares (the manifest's `config.theme.mode`, as
      // written) over this shell's own theme and the device, as in the web
      // runtime; the rule that weighs them is the provider's.
      : <ThemeProvider followHost followSystem declaredMode={_manifest?.config?.theme?.mode} box={THEME_BOX}>
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
              void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(`${_manifest?.config?.window?.title || _manifest?.name || 'App'} — SoftN`)).catch(() => {});
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
  // The restore is started once and its answer kept: StrictMode runs this
  // effect twice, and the second run used to find the upgrade already taken
  // and the first run's answer thrown away, leaving "Restoring…" up for good.
  const restoring = useRef<Promise<AbandonOutcome> | null>(null);
  useEffect(() => {
    if (!restoring.current) {
      const pending = upgrade.current;
      if (!pending) return;
      upgrade.current = null;
      restoring.current = abandonUpgrade(pending, restoreFromBackup);
    }
    let alive = true;
    void restoring.current.then(result => { if (alive) setOutcome(result); });
    return () => { alive = false; };
  }, [upgrade]);
  return <div className="desktop-state" role="alert">
    <h1>The app encountered a problem</h1>
    <p className="desktop-error">{error.message}</p>
    {outcome === null ? <p role="status">Restoring the data from the pre-upgrade backup…</p> : outcome.message ? <p className={outcome.restored && outcome.finalized ? undefined : 'desktop-error'}>{outcome.message}</p> : null}
    <button className="desktop-button" disabled={outcome === null} onClick={onHome}>Back to runtime home</button>
  </div>;
}

/**
 * A question asked before anything is opened behaves as the dialog it is
 * marked as: focus moves onto the answer that changes nothing, Tab stays
 * among its answers, Escape gives that answer, and focus goes back to where
 * it was once the question is gone. Marked `aria-modal` with none of that,
 * focus stayed on the button behind it and Escape did nothing.
 */
function useQuestion(cancel: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const answer = useRef(cancel);
  answer.current = cancel;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        answer.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      const outside = !dialog.contains(active);
      if (event.shiftKey ? outside || active === first : outside || active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return { dialogRef, cancelRef };
}

/** The installation registry could not be read: decide before anything is opened (R2-SN-03). */
function RegistryDamagedDialog({ choice }: { choice: RegistryDamagedChoice & { resolve: (decision: LoaderDecision) => void } }) {
  const { dialogRef, cancelRef } = useQuestion(() => choice.resolve({ kind: 'cancel' }));
  return <div ref={dialogRef} className="desktop-state" role="dialog" aria-modal="true" aria-labelledby="registry-damaged-title" data-testid="registry-damaged">
    <h1 id="registry-damaged-title">Installation records are damaged</h1>
    <p>The record of which packages belong to which installed data could not be read ({choice.reason}). Until it is resolved, no package can be matched to existing data, so nothing was opened.</p>
    <p>{choice.quarantineKey ? `The damaged record was kept under "${choice.quarantineKey}" in this runtime's storage for recovery.` : 'The damaged record could not be copied aside; it is still in place.'}</p>
    <p><strong>Discard the damaged records</strong> starts a fresh registry: installed apps keep their data on disk, but each package will be matched again when it is next opened (it may ask whether it is a new app or an upgrade).</p>
    <div className="desktop-actions">
      <button className="desktop-button" onClick={() => choice.resolve({ kind: 'discard' })}>Discard damaged records</button>
      <button ref={cancelRef} className="desktop-button desktop-button-primary" onClick={() => choice.resolve({ kind: 'cancel' })}>Cancel</button>
    </div>
  </div>;
}

/**
 * A failed upgrade could not be rolled back (R4-SN-02): the installation is
 * blocked until the verified backup is restored AND that recovery is
 * recorded. Retry here, or keep the backup file for a manual recovery.
 */
function RecoveryRequiredDialog({ choice }: { choice: RecoveryRequiredChoice & { resolve: (decision: LoaderDecision) => void } }) {
  const { recovery } = choice;
  const { dialogRef, cancelRef } = useQuestion(() => choice.resolve({ kind: 'cancel' }));
  return <div ref={dialogRef} className="desktop-state" role="dialog" aria-modal="true" aria-labelledby="recovery-required-title" data-testid="recovery-required">
    <h1 id="recovery-required-title">{choice.name || 'This app'} needs recovery</h1>
    <p>On {new Date(recovery.at).toLocaleString()} an upgrade of this installation failed and its data could not be put back from the pre-upgrade backup ({recovery.reason}). Until that backup is restored, no package is run against this data.</p>
    <p><strong>Restore the backup and retry</strong> restores the verified pre-upgrade snapshot again. The installation is unblocked only when both the restore and its record succeed; otherwise it stays blocked and says why.</p>
    <p><strong>Cancel</strong> leaves everything as it is. The backup file below is a complete SQLite copy of the pre-upgrade data and can be recovered from by hand.</p>
    <p className="desktop-muted">Backup: <code>{recovery.backup}</code></p>
    <div className="desktop-actions">
      <button className="desktop-button" onClick={() => choice.resolve({ kind: 'retry-restore' })}>Restore the backup and retry</button>
      <button ref={cancelRef} className="desktop-button desktop-button-primary" onClick={() => choice.resolve({ kind: 'cancel' })}>Cancel</button>
    </div>
  </div>;
}

/**
 * An upgrade of this installation to another package never finished
 * (R3-SN-01): the newer package may already have changed the data, so this
 * older package is not run against it until the person decides.
 */
function UnresolvedUpgradeDialog({ choice }: { choice: UnresolvedUpgradeChoice & { resolve: (decision: LoaderDecision) => void } }) {
  const pending: PendingUpgrade = choice.pending;
  const { dialogRef, cancelRef } = useQuestion(() => choice.resolve({ kind: 'cancel' }));
  return <div ref={dialogRef} className="desktop-state" role="dialog" aria-modal="true" aria-labelledby="upgrade-unresolved-title" data-testid="upgrade-unresolved">
    <h1 id="upgrade-unresolved-title">An upgrade of {choice.name || 'this app'} was not finished</h1>
    <p>On {new Date(pending.at).toLocaleString()} an upgrade of this installation to package <code>{shortIdentity(pending.to)}</code>{pending.version ? ` (version ${pending.version})` : ''} was approved, but that package never confirmed it started. Its data may already have been changed, so the package you opened will not run against it until this is resolved.</p>
    <p><strong>Restore the backup and open this version</strong> puts the data back to the verified pre-upgrade snapshot taken at approval time and clears the unfinished upgrade. Changes the newer package made after that snapshot are discarded.</p>
    <p><strong>Cancel</strong> leaves everything as it is. To finish the upgrade instead, open the newer package file: it resumes with the same backup.</p>
    <p className="desktop-muted">Backup: <code>{pending.backup}</code></p>
    <div className="desktop-actions">
      <button className="desktop-button" onClick={() => choice.resolve({ kind: 'rollback' })}>Restore the backup and open this version</button>
      <button ref={cancelRef} className="desktop-button desktop-button-primary" onClick={() => choice.resolve({ kind: 'cancel' })}>Cancel</button>
    </div>
  </div>;
}

export default App;
