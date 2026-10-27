/**
 * Opening a bundle's bytes as a tab of the web runtime: identity, the cache
 * record, the consent decision, the XDB seed, the composition and the tab
 * itself. App.tsx owns the tabs and what is on screen; this is handed the
 * pieces of its state it needs (`OpenBundleHost`) and is called once per
 * open, from a file, a link, the cache or Studio and Builder's hand-off.
 */

import type { Dispatch, SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import type { PermissionConfig, PythonProject } from '@softn/core';
import { ManifestError, preloadRememberedFirstDraw, readManifest } from '@softn/core';
import { randomUUID } from '@softn/bundle-format/crypto';
import {
  createAssetResolver,
  createImportResolver,
  extractIconDataUrl,
  extractPermissions,
  firstScreenAssets,
  loadXDBData,
  processBundle,
  readZip,
  requestedCapabilities,
  withheldPermissions,
  type AssetResolver,
  type BundleManifest,
  type DisposableImportResolver,
  type ZipResult,
} from '@softn/runtime-shell/bundleProcessor';
import { warmFirstScreen, type FirstScreenWarmup } from '@softn/runtime-shell/zipWarmup';
import { resolveServerConfig } from '@softn/runtime-shell/net';
// The consent rule the desktop loader and the single-app shell share. The
// grant itself is kept on the app's cache record (appCache), by origin, where
// adoption and the secure-context rule already govern it.
import { grantCovers, grantRecord } from '@softn/runtime-shell/consent';
import type { ConsentRequest } from '@softn/runtime-shell/PermissionBar';
import {
  cacheApp,
  computeAppOrigin,
  getCachedAppByOrigin,
  getCachedApps,
  isSecureAppOrigin,
  recordPermissionGrant,
  updateLastOpened,
  type CachedApp,
} from './appCache';
import { findPlaceholder, findRunningTab } from './tabIdentity';
import { describePreviousBuild, previousBuildFor, type PreviousBuild } from './consentDiff';

export interface OpenTab {
  id: string;
  name: string;
  /**
   * The app's identity: a digest of its bundle. `name` is for the user to read,
   * this is what its stored data and its permission grants belong to. Absent on
   * a skeleton tab, which has no bundle yet.
   */
  appId?: string;
  /** The exact running bundle stays downloadable even when browser caching fails. */
  bundleData?: Uint8Array;
  /** The manifest's version, to tell two open tabs with one name apart. */
  version?: string;
  source: string; // empty string = skeleton tab (loading)
  icon?: string;
  initialPage?: string;
  permissions?: import('@softn/core').AppPermissions;
  /**
   * What the runtime is actually running with. While consent is pending this
   * is the withheld config, not the declared one — the bundle's own request
   * lives on `consent.config` until the user answers.
   */
  permissionConfig?: PermissionConfig;
  /**
   * Raised by the tab as a bar over the running app. Cleared on Allow.
   */
  consent?: ConsentRequest;
  importResolver?: DisposableImportResolver;
  /** Turns a bundle-relative asset path into a URL the browser can load. */
  assetResolver?: AssetResolver;
  logicBasePath?: string;
  preIncludedLogicPaths?: string[];
  /** The app's Python project, when its logic is Python. */
  python?: PythonProject;
  /** The manifest's `config.execution`: where the bundle asked its script to run. */
  execution?: 'worker' | 'main';
  /**
   * The manifest's `config.theme.mode`, as the bundle has it: the side the
   * project declares. Judged by the theme rule, not here.
   */
  themeMode?: unknown;
  serverUrl?: string;
  serverToken?: string;
  serverCollections?: string[];
  /** The app's slug in the site's directory, when it was opened from there. */
  directorySlug?: string;
  /** The address the bundle was fetched from, when it came from one. */
  bundleUrl?: string;
}

/** What an open needs of the runtime around it. */
export interface OpenBundleHost {
  /** The tabs as last rendered. */
  tabs: () => OpenTab[];
  /** The tab on screen as last rendered; null is Home. */
  activeTabId: () => string | null;
  setOpenTabs: Dispatch<SetStateAction<OpenTab[]>>;
  setActiveTabId: Dispatch<SetStateAction<string | null>>;
  setError: (error: Error | null) => void;
  /** Cover Home with "Opening <name>…" for an open that has no tab in the bar yet. */
  showOpening: (tabId: string, appName: string) => void;
  /** Take that cover away, if it is still this open's. */
  hideOpening: (tabId: string) => void;
  /** The cache's records changed; Home lists them. */
  appsChanged: (apps: CachedApp[]) => void;
  /** Make the app openable without a network, in the background. */
  installOffline: (
    tabId: string,
    record: CachedApp,
    source: string,
    execution: 'worker' | 'main' | undefined,
    capabilities: string[],
    pythonPackages?: readonly string[]
  ) => void;
}

/** One open: the bytes, and where they came from. */
export interface OpenBundleRequest {
  data: Uint8Array;
  /** The file's name, which stands in for the app's if the manifest has none. */
  fileName: string;
  /** The cache record this open came from, whose last-opened time is updated. */
  cachedAppId?: string;
  /** The page of the app to show first. */
  initialPage?: string;
  /** The app's slug in the site's directory, when it came from there. */
  directorySlug?: string;
  /**
   * The tab the caller put in the bar while the bytes were on their way; this
   * open adopts that tab and no other. A placeholder used to be found by name
   * — the file's name, which need not match the manifest's — and a running tab
   * by the manifest's name, so an update, or an unrelated bundle with the same
   * name, activated whatever was already open under it.
   */
  placeholderId?: string;
  /** Whether this open is still the person's latest navigation, and so may take the screen. */
  isForeground?: () => boolean;
}

/**
 * Phase boundaries for scripts/bench/measure.mjs, which pairs each
 * `softn:<phase>:start` with the first `:end` after it. Guarded because the
 * runtime is also rendered where the User Timing API is absent or stubbed.
 * Every `:end` below is in a finally: a corrupt archive or a rejected seed
 * used to throw between the two, leaving a `:start` the harness then paired
 * with the NEXT open's `:end` — a phase measured across two opens and a
 * failure, reported as one number.
 */
function mark(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(name);
  }
}

/**
 * Open a .softn bundle from raw bytes. Resolves with the app's name, or null
 * if it did not open; a failure is reported through `host.setError` and
 * never thrown.
 */
export async function openBundle(host: OpenBundleHost, request: OpenBundleRequest): Promise<string | null> {
  const { data, fileName, cachedAppId, initialPage, directorySlug, placeholderId } = request;
  const isForeground = request.isForeground ?? (() => true);

  // The placeholder tab this call adopted, once it has adopted one.
  //
  // Tracked out here so the catch below can remove it — but only failures
  // past the adoption point are its to clean up. Everything that throws
  // before then is the caller's, which is why the two places that create a
  // placeholder retire it themselves.
  let skeletonTabId: string | null = null;
  let loadingOwner: string | null = null;

  // The first-screen warm-up this open started, so a failure after it
  // began stops it rather than leaving a worker inflating for a tab that
  // will never exist.
  let warmup: FirstScreenWarmup | undefined;

  // Whether the placeholder this load was given has since been closed.
  //
  // Asked again after every await below. The caller checks once, after
  // the download, but the steps here — hashing the bytes, seeding the
  // database, writing the cache — take long enough on a large bundle that
  // a tab closed during them used to open anyway: the app the user had
  // just dismissed appeared a moment later. A load with no placeholder
  // has nothing to be closed and never bails.
  const placeholderClosed = (): boolean =>
    placeholderId !== undefined && !host.tabs().some((t) => t.id === placeholderId);

  // The app's identity (below), started beside the archive's read: as soon
  // as it is known, what its first screen waited for last time is started
  // too (core's first-draw-memory), while the rest of the open goes on. A
  // failure is the await's below to report.
  const origin = computeAppOrigin(data);
  origin.then(preloadRememberedFirstDraw, () => {});

  try {
    if (isForeground()) host.setError(null);

    // Indexes the archive. A text file is decoded when something reads it
    // (the manifest, the composer, an import); binaries are read when an
    // asset() asks for them, or by the warm-up below.
    let zip: ZipResult;
    mark('softn:zip:start');
    try {
      zip = readZip(data);
    } finally {
      mark('softn:zip:end');
    }
    const { textFiles, binaryFiles, archive } = zip;

    // The one manifest read every host shares (core's readManifest): a
    // manifest without `files` opens, as it always did in core, and what
    // cannot run is refused in the inspector's words.
    let manifest: BundleManifest;
    try {
      manifest = readManifest<BundleManifest>(textFiles);
    } catch (err) {
      throw err instanceof ManifestError ? new Error(`Invalid manifest.json: ${err.message}`) : err;
    }
    if (manifest.name.length > 255) {
      throw new Error('Invalid manifest.json: name exceeds 255 characters');
    }

    const appName = manifest.name || fileName.replace(/\.softn$/, '');

    // What the app IS, as distinct from what it calls itself. Everything
    // that persists — its database, its granted permissions, its cached
    // copy — hangs off this rather than off manifest.name, which the bundle
    // chooses for itself and could therefore choose to be someone else's.
    const appOrigin = await origin;
    // Before the running-tab check as well: a closed placeholder means the
    // user dismissed this load, not that they asked for whatever copy of
    // the app is already open.
    if (placeholderClosed()) return null;

    // These exact bytes already running: the same app, opened again.
    // Identity, not name — two builds of one app, or two unrelated
    // bundles called Notes, are two tabs, and the bar tells them apart.
    const running = findRunningTab(host.tabs(), appOrigin);
    if (running) {
      if (isForeground() && (!placeholderId || host.activeTabId() === placeholderId)) host.setActiveTabId(running.id);
      // The placeholder this load was given has nothing left to become,
      // and would otherwise sit in the tab bar loading forever.
      if (placeholderId) host.setOpenTabs((prev) => prev.filter((t) => t.id !== placeholderId));
      return appName;
    }

    // The placeholder this load was given, if it is still there; else a
    // fresh tab. A tab with no source is waiting for this load, and if the
    // load fails it has to go, or it renders "Loading …" indefinitely.
    const existingTab = findPlaceholder(host.tabs(), placeholderId);
    const tabId = existingTab?.id || randomUUID();
    if (existingTab) skeletonTabId = existingTab.id;

    if (!existingTab && isForeground()) {
      // Fresh open (not from URL) — show loading overlay
      host.showOpening(tabId, appName);
      loadingOwner = tabId;
      host.setActiveTabId(null); // Show loading on Home
    }

    // Extract permission config from permission.json or manifest.permissions.
    //
    // A bundle that ships neither declared nothing, and is run as exactly
    // that: an empty declaration. It used to be run with no config at all,
    // which the script runtime denies but the renderer and the device
    // components read as "no host is enforcing" — the reading a preview
    // outside any bundle needs — so the least-trusted bundles got the
    // camera and remote images unasked while an honest one was refused.
    const permissionConfig: PermissionConfig = extractPermissions(textFiles, manifest) ?? { permissions: {} };

    // Extract icon early (the consent bar's detail dialog shows it).
    //
    // Bounded by the declared size before its bytes exist, as softn-single
    // does: the archive allows an entry of 50 MB, and an icon that size
    // was inflated and base64-encoded whole on the way to a data: URL.
    const icon =
      typeof manifest.icon === 'string' && (binaryFiles.declaredSize(manifest.icon) ?? Infinity) <= 256 * 1024
        ? extractIconDataUrl(binaryFiles, manifest)
        : undefined;

    // Decide what the app runs with. It runs either way — the bundle's UI
    // is on screen from the first frame and the request becomes a bar over
    // it — so this decides whether the runtime is handed the capabilities
    // the bundle declared or an empty set, not whether it starts.
    //
    // The grant has to be compared against what *this* bundle asks for.
    // The old check was a boolean "has this name ever been prompted",
    // and the lookup was by manifest name — so version 2 of an app, or
    // any unrelated .softn calling itself the same thing, could add
    // net + camera + files to a bundle the user had approved for `qr`
    // alone and never see a prompt.
    // By origin, not by name. A grant belongs to the bundle the user
    // actually approved; looking it up by name handed it to anything that
    // later called itself the same thing. This read must stay ahead of the
    // cacheApp below: that call adopts a legacy record on the way past, and
    // reading after it would find the record it had just written.
    const cachedApp = await getCachedAppByOrigin(appOrigin);
    if (placeholderClosed()) return null;
    const requested = requestedCapabilities(permissionConfig);
    const granted = cachedApp?.grantedPermissions ?? {};
    // A bundle that asks for nothing has nothing to consent to, and a bar
    // reading "this app wants to use nothing" trains people to press Allow
    // without reading — which is what the dialog was already doing wrong.
    // `granted[c] === true`, not truthy: the map comes off disk unchecked.
    const hasGrant =
      requested.length === 0 || (Boolean(cachedApp?.permissionsPromptedAt) && grantCovers(granted, requested));

    // Load XDB data (per-app isolation)
    mark('softn:xdb-seed:start');
    try {
      await loadXDBData(textFiles, manifest, appOrigin);
    } finally {
      mark('softn:xdb-seed:end');
    }
    if (placeholderClosed()) return null;

    // Process source
    let composed: ReturnType<typeof processBundle>;
    mark('softn:compose:start');
    try {
      composed = processBundle(textFiles, manifest);
    } finally {
      mark('softn:compose:end');
    }
    const { source, logicBasePath, preIncludedLogicPaths, python } = composed;

    // The assets the composed source names by literal, then the manifest's
    // asset list, start inflating now, in a worker where there is one,
    // while the cache write, the consent lookup and the render go on. Not
    // awaited: an asset() the app makes before its entry lands reads the
    // entry itself. Disposing the tab's asset resolver releases the
    // archive, which ends the warm-up.
    warmup = warmFirstScreen(archive, data, firstScreenAssets(source, manifest, binaryFiles));
    // Withheld until the user answers, and withheld here too: a remote
    // `import` is network access just as surely as fetch() in app logic,
    // and it resolves during loadScript — before the bar has been on
    // screen long enough to read, let alone answer.
    const runningConfig = hasGrant ? permissionConfig : withheldPermissions(permissionConfig);
    const importResolver = createImportResolver(textFiles, runningConfig);

    // Unconditional, and before any consent: the app is about to run and
    // can already write records into its own database, and removing it from
    // Home is the only thing that deletes those. No record, nothing to
    // remove them with. Origin dedup means opening it again is an update.
    // The record comes back for the offline install below, which is keyed
    // by it and writes its outcome onto it.
    const cachedRecord = await cacheApp(data, manifest, icon, directorySlug, requested);

    if (cachedAppId) {
      await updateLastOpened(cachedAppId);
    }

    // Refresh cached apps list
    const updatedApps = await getCachedApps();
    host.appsChanged(updatedApps);
    // The record stays — it is the memory of an app that was opened, and
    // Home shows it — but the warm-up and the resolver were minted for a
    // tab that no longer exists, so they go the way the failure path
    // below sends them.
    if (placeholderClosed()) {
      warmup.abort();
      importResolver.dispose();
      return null;
    }

    // What this build asks for that the one before it did not, for the
    // consent bar: an update must not add a capability under a request
    // that reads like the one the user already approved.
    let previousBuild: PreviousBuild | undefined;
    if (!hasGrant) {
      const prev = previousBuildFor(updatedApps, appName, appOrigin);
      if (prev) previousBuild = describePreviousBuild(prev, permissionConfig);
    }

    // The sync server the manifest names, as one WebSocket address (the
    // same rule as the other hosts': runtime-shell's resolveServerConfig).
    // Whether it is ever reached is the renderer's: it needs `sync` declared
    // and allowed.
    const server = resolveServerConfig(manifest.config?.server);

    // Granting upgrades the running tab in place. It does not remount it.
    //
    // The bar's whole premise is that people look first and grant after, so
    // by the time Allow is pressed they have typed, played, navigated or
    // started something. A remount threw all of it away with no warning —
    // measured: text typed into WarbleWire reverted to the bundle's default
    // and TheOffice went from LIVE back to PAUSED.
    //
    // Handing the tab a new permissionConfig and a new importResolver is
    // enough to rebuild everything that captured the withheld one. Both are
    // dependencies of the renderer's script-load effect, so it tears the old
    // VM down, builds a fresh runtime with the granted config — new import
    // resolution, new AI and GPU managers — reloads the script and runs
    // `_init()` again, now allowed. What it does not throw away is
    // `componentState`: the renderer merges reloaded script state under it
    // (`{...result.state, ...prev.componentState}`), so what the user did
    // survives, including the page they are on.
    const onAllow = (): void => {
      // Recorded from the same list the check above reads, so the two
      // cannot drift. An earlier version enumerated four capabilities by
      // hand and omitted ai, gpu and sync, so a grant for those was never
      // written down.
      const grantedPerms = grantRecord(requested);
      // Not awaited, and its failure does not block the grant. getDB
      // rejects outright in private browsing, and an Allow that does
      // nothing until a write succeeds is a button that looks broken to
      // exactly the users with the most reason to distrust it. The tab is
      // the authority for this run; IndexedDB is only the memory of it.
      void recordPermissionGrant(appOrigin, grantedPerms);

      const grantedResolver = createImportResolver(textFiles, permissionConfig);
      // The resolver being replaced is read out of the updater's own
      // `prev`, not out of the tabs as last rendered. Those are only
      // refreshed on render, so two activations in one frame both read the
      // pre-grant tab: the second built a resolver that replaced nothing and
      // was never disposed, and the first one's stayed live for the session.
      //
      // Nothing is disposed from inside the updater. A state updater must
      // be pure — React runs it speculatively and, under StrictMode, twice
      // — and it may not run at all for a tab that no longer exists, which
      // is how the granted resolver leaked whole: closing the tab between
      // pressing Allow and the re-render left `prev.map` matching nothing,
      // and the blob URLs it holds stayed alive for the session. The
      // updater only decides; the decision is carried out here, where a
      // tab that was never matched is an outcome instead of a silence.
      let adopted = false;
      let superseded: DisposableImportResolver | undefined;
      // flushSync so the updater has run by the next line. onAllow is only
      // ever reached from a click — the bar's Allow, or the detail
      // dialog's — which is where flushSync is permitted; the alternative
      // is reading the outcome on a later tick, by which time the tab may
      // have been closed and the answer is unrecoverable either way.
      flushSync(() => {
        host.setOpenTabs((prev) => {
          adopted = false;
          superseded = undefined;
          return prev.map((t) => {
            if (t.id !== tabId) return t;
            // Already granted. A second activation has nothing to replace,
            // and must not dispose the resolver the app is running on.
            if (!t.consent) return t;
            adopted = true;
            superseded = t.importResolver;
            return {
              ...t,
              permissionConfig,
              importResolver: grantedResolver,
              consent: undefined,
            };
          });
        });
      });
      // dispose() is idempotent, so a StrictMode-doubled updater reporting
      // the same outcome twice is harmless.
      if (adopted) superseded?.dispose();
      else grantedResolver.dispose();
    };

    if (!isSecureAppOrigin(appOrigin)) {
      console.warn(
        `[SoftN Web] "${appName}" is identified without a secure context (no crypto.subtle); its data stays isolated but no grant will be remembered.`
      );
    }

    // Create or update the tab
    const newTab: OpenTab = {
      id: tabId,
      name: appName,
      appId: appOrigin,
      bundleData: data,
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
      source,
      icon: icon || undefined,
      initialPage: initialPage || existingTab?.initialPage,
      permissions: manifest.permissions,
      permissionConfig: runningConfig,
      consent: hasGrant
        ? undefined
        : { config: permissionConfig, capabilities: requested, appName, appIcon: icon || undefined, previous: previousBuild, onAllow },
      importResolver,
      assetResolver: createAssetResolver(binaryFiles, textFiles),
      logicBasePath,
      preIncludedLogicPaths,
      python,
      execution: manifest.config?.execution,
      themeMode: manifest.config?.theme?.mode,
      ...server,
      directorySlug,
    };
    host.setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx !== -1) {
        // Update skeleton tab in-place
        return prev.map((t) => (t.id === tabId ? newTab : t));
      }
      return [...prev, newTab];
    });
    // Home or another app may have been selected while this download was
    // being prepared. Finish its tab in the background without stealing focus.
    if (isForeground() && (!placeholderId || host.activeTabId() === placeholderId)) host.setActiveTabId(tabId);
    if (loadingOwner) host.hideOpening(loadingOwner);

    // Make the app openable without a network, in the background. It is
    // on screen already; nothing waits on this, and the outcome is a word
    // on its card at Home. Not started for a record the cache could not
    // write: there is nothing to record the outcome on.
    if (cachedRecord) {
      host.installOffline(tabId, cachedRecord, source, manifest.config?.execution, requested, python?.packages);
    }
    return appName;
  } catch (err) {
    warmup?.abort();
    console.error('[SoftN Web] Failed to load bundle:', err);
    if (isForeground()) host.setError(err instanceof Error ? err : new Error(String(err)));
    if (loadingOwner) host.hideOpening(loadingOwner);
    if (skeletonTabId) {
      const failedTab = skeletonTabId;
      host.setOpenTabs((prev) => prev.filter((t) => t.id !== failedTab));
      host.setActiveTabId((current) => (current === failedTab ? null : current));
    }
    return null;
  }
}
