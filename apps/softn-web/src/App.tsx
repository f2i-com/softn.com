import React, { useState, useEffect, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { ThemeProvider, Spinner, Box, Text } from '@softn/components';
import { DropZone } from './components/DropZone';
import { Launcher } from './components/Launcher';
import { AppRunner } from './components/AppRunner';
import { FrameBar } from './components/FrameBar';
import { ProductBar } from '@softn/brand';
import type { ConsentRequest } from './components/PermissionBar';
import type { PermissionConfig } from '@softn/core';

const appShellStyles = `
  @keyframes softn-shell-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes softn-shell-slide-up {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .softn-shell {
    /* Two names for one number, because a tab showing a permission bar has to
       ADD to this rather than replace it, and a self-referential calc() on one
       custom property is invalid at computed-value time. --softn-tab-bar-height
       is the name @softn/components sizes an app root against, so it stays;
       the base is what the breakpoints below move. */
    /* On the home screen the product bar; over a running app the slim frame
       bar, which is what an app root is sized against. */
    --softn-chrome-base: var(--bar-height, 3rem);
    --softn-tab-bar-height: var(--softn-chrome-base);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    background: var(--ink);
    color: var(--paper);
  }
  /* The frame bar is one row at every width, where the product bar it
     replaces grows to two on a phone. */
  .softn-shell.softn-shell--playing {
    --softn-chrome-base: 3rem;
  }
  .softn-shell-loading {
    animation: softn-shell-fade-in 300ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-shell-error {
    animation: softn-shell-slide-up 350ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-shell-error-card {
    transition: box-shadow 250ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-shell-error-card:hover {
    box-shadow: 0 8px 32px rgba(239, 68, 68, 0.08), 0 0 0 1px rgba(239, 68, 68, 0.2);
  }
  .softn-shell-error-btn {
    transition: all 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-shell-error-btn:hover {
    background: var(--ink-3) !important;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }
  .softn-shell-error-btn:active {
    transform: translateY(0) scale(0.98);
  }
  /* Embedded, there is no tab bar, so there is no chrome to subtract: without
     this an app in a host page's frame stopped 38px short of the bottom. The
     same holds when the bar has been folded away. */
  .softn-shell.softn-shell--embedded,
  .softn-shell.softn-shell--embedded .softn-runner-host,
  .softn-shell.softn-shell--bare,
  .softn-shell.softn-shell--bare .softn-runner-host {
    --softn-chrome-base: 0px !important;
  }
  /* The corner tab that brings a hidden bar back. */
  .softn-chrome-peek {
    position: fixed;
    top: 0;
    right: 12px;
    z-index: 50;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-top: 0;
    border-radius: 0 0 8px 8px;
    background: var(--nav-bg);
    color: var(--dim);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    opacity: 0.6;
    backdrop-filter: blur(6px);
    transition: opacity 160ms ease;
  }
  .softn-chrome-peek:hover, .softn-chrome-peek:focus-visible { opacity: 1; color: var(--paper); }
`;
import {
  readZip,
  loadXDBData,
  processBundle,
  createImportResolver,
  createAssetResolver,
  extractIconDataUrl,
  extractPermissions,
  requestedCapabilities,
  withheldPermissions,
  type BundleManifest,
  type AssetResolver,
  type DisposableImportResolver,
} from './lib/bundleProcessor';
import {
  getCachedApp,
  getCachedApps,
  cacheApp,
  computeAppOrigin,
  copyAppData,
  isSecureAppOrigin,
  getCachedAppByName,
  getCachedAppByOrigin,
  removeAppData,
  removeCachedApp,
  updateLastOpened,
  recordPermissionGrant,
  type CachedApp,
} from './lib/appCache';
import { displayNameFor, findPlaceholder, findRunningTab, findTabForUrlName } from './lib/tabIdentity';
import { parseAppPath, buildAppPath } from './lib/appUrl';
import { resolveBundleUrl, fetchRemoteBundle, bundleNameFromUrl } from './lib/remoteBundle';

// ── URL Routing Helpers ──────────────────────────────────────────

function parseAppUrl(): { appName: string | null; page: string | null } {
  return parseAppPath(window.location.pathname, import.meta.env.BASE_URL);
}

function buildAppUrl(appName: string | null, page?: string | null): string {
  return buildAppPath(appName, page, import.meta.env.BASE_URL);
}

/** The URL as the history API sees it, base and query included. */
function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

/**
 * How this page was entered.
 *
 * `?open=` beats an `/app/` path deliberately: both want the one skeleton tab,
 * and a bundle arriving over the network racing a bundle arriving from the
 * cache would leave whichever lost holding a tab that never finishes loading.
 */
/**
 * Put the address back after a static host bounced it here.
 *
 * `/web/app/Notes` is a route, not a file, so a host with no SPA rewrite serves
 * its 404 page — which forwards the original path as `?softn-restore=`. This
 * restores it before anything reads the URL, so the app sees the address the
 * visitor actually typed and the address bar shows it. Same-origin paths only:
 * the value arrives from the query string, so it is not ours to trust.
 */
function restoreForwardedPath(): void {
  const params = new URLSearchParams(window.location.search);
  const forwarded = params.get('softn-restore');
  if (!forwarded) return;
  // A leading single slash and nothing that could read as another origin.
  if (!forwarded.startsWith('/') || forwarded.startsWith('//')) return;
  try {
    window.history.replaceState(null, '', forwarded);
  } catch {
    // Some embedded contexts refuse replaceState; the launcher still opens.
  }
}

function readEntry(): {
  openValue: string | null;
  appName: string | null;
  page: string | null;
  embedded: boolean;
  /** Where Close goes when the app was opened from another page of this site. */
  backTo: string | null;
} {
  restoreForwardedPath();
  const params = new URLSearchParams(window.location.search);
  const embedded = params.get('embed') === '1';
  // `?back=` is a page of this origin — an app's directory page, usually —
  // and nothing else: it arrives from the query string, so it is not ours to
  // trust with a scheme or a second slash.
  const back = params.get('back');
  const backTo = back && back.startsWith('/') && !back.startsWith('//') && !back.startsWith('/\\') ? back : null;
  const openValue = params.get('open');
  if (openValue) return { openValue, appName: null, page: null, embedded, backTo };
  return { openValue: null, ...parseAppUrl(), embedded, backTo };
}

// ── Types ────────────────────────────────────────────────────────

interface OpenTab {
  id: string;
  name: string;
  /**
   * The app's identity: a digest of its bundle. `name` is for the user to read,
   * this is what its stored data and its permission grants belong to. Absent on
   * a skeleton tab, which has no bundle yet.
   */
  appId?: string;
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
  /** The manifest's `config.execution`: where the bundle asked its script to run. */
  execution?: 'worker' | 'main';
  serverUrl?: string;
  serverToken?: string;
  serverCollections?: string[];
  /** The app's slug in the site's directory, when it was opened from there. */
  directorySlug?: string;
  /** The address the bundle was fetched from, when it came from one. */
  bundleUrl?: string;
}

/** The directory slug a bundle URL names, if it is one of the directory's. */
function directorySlugOf(url: URL): string | undefined {
  const m = url.pathname.match(/^\/api\/apps\/([^/]+)\//);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

// ── App Component ────────────────────────────────────────────────

function App(): React.ReactElement {
  // Parse URL once for initial state
  const [urlInit] = useState(readEntry);
  // Pre-create a skeleton tab ID if loading from URL (so tab bar shows immediately)
  const [urlTabId] = useState(() => (urlInit.appName ? crypto.randomUUID() : null));
  const embedded = urlInit.embedded;
  // Set when the app was opened from a page of this site — its directory page —
  // so that Close returns there rather than to the runtime's home.
  const backTo = urlInit.backTo;
  // The tab bar can be folded away for a game that wants the whole viewport;
  // the choice is remembered, and a fresh session keeps it.
  const [chromeHidden, setChromeHiddenState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('softn.web.chromeHidden') === '1';
    } catch {
      return false;
    }
  });
  const setChromeHidden = useCallback((hidden: boolean) => {
    setChromeHiddenState(hidden);
    try {
      localStorage.setItem('softn.web.chromeHidden', hidden ? '1' : '0');
    } catch {
      // Storage blocked: the bar simply comes back next time.
    }
  }, []);

  const [openTabs, setOpenTabs] = useState<OpenTab[]>(() => {
    // Pre-populate tab from URL so it appears in tab bar instantly on reload
    if (urlInit.appName && urlTabId) {
      return [{
        id: urlTabId,
        name: urlInit.appName,
        source: '', // empty = still loading
        initialPage: urlInit.page || undefined,
      }];
    }
    return [];
  });
  const [activeTabId, setActiveTabId] = useState<string | null>(urlTabId); // skeleton tab or Home
  const [apps, setApps] = useState<CachedApp[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loadingTabId, setLoadingTabId] = useState<string | null>(null);
  const [loadingFileName, setLoadingFileName] = useState('');
  // Nothing here queues consent any more. A permission request used to park
  // processBundleData on a promise the modal resolved, which is why it needed a
  // queue at all — two bundles asking at once could strand each other's load.
  // A tab now carries its own request and raises it as a bar over the running
  // app, so no load waits on an answer and there is no queue to strand.
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** The shell — bar and app together — which is what fullscreen is asked of. */
  const shellRef = useRef<HTMLDivElement>(null);
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // URL routing state
  const tabPagesRef = useRef<Record<string, string>>({}); // tabId → current page
  const urlReadyRef = useRef(false); // true after initial URL parsing
  const skipNextUrlPushRef = useRef(false); // skip URL push after popstate
  // The address the page was opened at is a one-shot instruction, and acting on
  // it twice opens the bundle twice. StrictMode invokes every mount effect
  // twice in development, so "runs on mount" is not the same as "runs once".
  const entryHandledRef = useRef(false);
  // Bundle loads that have started but not finished, by resolved URL. A second
  // request for one already in flight joins it rather than starting its own —
  // the tab-reuse check below cannot help, because it can only recognise a tab
  // that has finished loading, and the whole point here is that this one has not.
  const inFlightRef = useRef(new Map<string, Promise<string | null>>());
  /** Downloads still running, by the placeholder tab they belong to. */
  const loadAbortsRef = useRef(new Map<string, AbortController>());
  const unmountCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stop work and release blob URLs when the runtime itself is unmounted.
  // Closing an individual app does the same below; this covers navigation away
  // from the entire shell while tabs or downloads are still alive.
  useEffect(() => {
    const pendingDownloads = loadAbortsRef.current;
    const tabsRef = openTabsRef;

    // React Strict Mode immediately replays mount effects in development. Its
    // synthetic cleanup is followed by this setup in the same turn, so cancel
    // the deferred teardown and let an entry-point bundle keep downloading.
    // A real unmount has no matching setup, and the timer performs the cleanup.
    if (unmountCleanupTimerRef.current) {
      clearTimeout(unmountCleanupTimerRef.current);
      unmountCleanupTimerRef.current = null;
    }

    return () => {
      unmountCleanupTimerRef.current = setTimeout(() => {
        unmountCleanupTimerRef.current = null;
        for (const controller of pendingDownloads.values()) controller.abort();
        pendingDownloads.clear();
        for (const tab of tabsRef.current) {
          tab.importResolver?.dispose();
          tab.assetResolver?.dispose();
        }
      }, 0);
    };
  }, []);

  // An embedded frame keeps ?embed=1 through every rewrite, so a frame that
  // reloads itself does not sprout a tab bar inside somebody else's page.
  const entryUrl = useCallback(
    (path: string) => (embedded ? `${path}?embed=1` : path),
    [embedded]
  );

  // Load cached apps on mount
  useEffect(() => {
    getCachedApps().then(setApps).catch(console.error);
  }, []);

  // Update document title when active tab changes
  useEffect(() => {
    if (activeTabId === null) {
      document.title = 'SoftN Web';
    } else {
      const tab = openTabs.find((t) => t.id === activeTabId);
      if (tab) document.title = tab.name;
    }
  }, [activeTabId, openTabs]);

  /**
   * Drop a placeholder tab that a load never took over.
   *
   * Whoever put the placeholder on screen calls this once the load is done and
   * did not open anything, so the cleanup does not depend on how far
   * processBundleData got: `readZip` and every manifest check throw before it
   * has adopted the tab, and a placeholder nothing will ever fill in renders
   * "Loading …" for the rest of the session.
   */
  const discardPlaceholder = useCallback((tabId: string) => {
    setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
    // Only send the window Home if the tab going away is the one being looked
    // at; a load that finished elsewhere keeps whatever it selected.
    setActiveTabId((current) => (current === tabId ? null : current));
  }, []);

  /**
   * Process a .softn bundle from raw bytes. Resolves with the app's name, or null if it did not open.
   *
   * `placeholderId` is the tab the caller put in the bar while the bytes were
   * on their way; this call adopts that tab and no other. A placeholder used
   * to be found by name — the file's name, which need not match the manifest's
   * — and a running tab by the manifest's name, so an update, or an unrelated
   * bundle with the same name, activated whatever was already open under it.
   */
  const processBundleData = useCallback(
    async (
      data: Uint8Array,
      fileName: string,
      cachedAppId?: string,
      initialPage?: string,
      directorySlug?: string,
      placeholderId?: string
    ): Promise<string | null> => {
      // The placeholder tab this call adopted, once it has adopted one.
      //
      // Tracked out here so the catch below can remove it — but only failures
      // past the adoption point are its to clean up. Everything that throws
      // before then is the caller's, which is why the two places that create a
      // placeholder retire it themselves.
      let skeletonTabId: string | null = null;

      try {
        setError(null);

        const { textFiles, binaryFiles } = readZip(data);

        const manifestContent = textFiles.get('manifest.json');
        if (!manifestContent) {
          throw new Error('Bundle missing manifest.json');
        }

        let manifest: BundleManifest;
        try {
          manifest = JSON.parse(manifestContent);
        } catch {
          throw new Error('Invalid manifest.json: not valid JSON');
        }

        // Validate required manifest fields
        if (!manifest.name || typeof manifest.name !== 'string') {
          throw new Error('Invalid manifest.json: missing or invalid "name"');
        }
        if (!manifest.main || typeof manifest.main !== 'string') {
          throw new Error('Invalid manifest.json: missing or invalid "main"');
        }
        if (manifest.name.length > 255) {
          throw new Error('Invalid manifest.json: name exceeds 255 characters');
        }

        const appName = manifest.name || fileName.replace(/\.softn$/, '');

        // What the app IS, as distinct from what it calls itself. Everything
        // that persists — its database, its granted permissions, its cached
        // copy — hangs off this rather than off manifest.name, which the bundle
        // chooses for itself and could therefore choose to be someone else's.
        const appOrigin = await computeAppOrigin(data);

        // These exact bytes already running: the same app, opened again.
        // Identity, not name — two builds of one app, or two unrelated
        // bundles called Notes, are two tabs, and the bar tells them apart.
        const running = findRunningTab(openTabsRef.current, appOrigin);
        if (running) {
          setActiveTabId(running.id);
          // The placeholder this load was given has nothing left to become,
          // and would otherwise sit in the tab bar loading forever.
          if (placeholderId) setOpenTabs((prev) => prev.filter((t) => t.id !== placeholderId));
          return appName;
        }

        // The placeholder this load was given, if it is still there; else a
        // fresh tab. A tab with no source is waiting for this load, and if the
        // load fails it has to go, or it renders "Loading …" indefinitely.
        const existingTab = findPlaceholder(openTabsRef.current, placeholderId);
        const tabId = existingTab?.id || crypto.randomUUID();
        if (existingTab) skeletonTabId = existingTab.id;

        if (!existingTab) {
          // Fresh open (not from URL) — show loading overlay
          setLoadingTabId(tabId);
          setLoadingFileName(appName);
          setActiveTabId(null); // Show loading on Home
        }

        // Extract permission config from permission.json or manifest.permissions.
        //
        // A bundle that ships neither declared nothing, and is run as exactly
        // that: an empty declaration. It used to be run with no config at all,
        // which the script runtime denies but the renderer and the device
        // components read as "no host is enforcing" — the reading a preview
        // outside any bundle needs — so the least-trusted bundles got the
        // camera and remote images unasked while an honest one was refused.
        const permissionConfig = extractPermissions(textFiles, manifest) ?? { permissions: {} };

        // Extract icon early (the consent bar's detail dialog shows it)
        const icon = extractIconDataUrl(binaryFiles, manifest);

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
        const cachedApp = permissionConfig ? await getCachedAppByOrigin(appOrigin) : null;
        const requested = permissionConfig ? requestedCapabilities(permissionConfig) : [];
        const granted = cachedApp?.grantedPermissions ?? {};
        // A bundle that asks for nothing has nothing to consent to, and a bar
        // reading "this app wants to use nothing" trains people to press Allow
        // without reading — which is what the dialog was already doing wrong.
        // `granted[c] === true`, not truthy: the map comes off disk unchecked.
        const hasGrant =
          !permissionConfig ||
          requested.length === 0 ||
          (Boolean(cachedApp?.permissionsPromptedAt) &&
            requested.every((capability) => granted[capability] === true));

        // Load XDB data (per-app isolation)
        await loadXDBData(textFiles, manifest, appOrigin);

        // Process source
        const { source, logicBasePath, preIncludedLogicPaths } = processBundle(textFiles, manifest);
        // Withheld until the user answers, and withheld here too: a remote
        // `import` is network access just as surely as fetch() in app logic,
        // and it resolves during loadScript — before the bar has been on
        // screen long enough to read, let alone answer.
        const runningConfig =
          hasGrant || !permissionConfig ? permissionConfig : withheldPermissions(permissionConfig);
        const importResolver = createImportResolver(textFiles, runningConfig);

        // Unconditional, and before any consent: the app is about to run and
        // can already write records into its own database, and removing it from
        // Home is the only thing that deletes those. No record, nothing to
        // remove them with. Origin dedup means opening it again is an update.
        await cacheApp(data, manifest, icon, directorySlug);

        if (cachedAppId) {
          await updateLastOpened(cachedAppId);
        }

        // Refresh cached apps list
        const updatedApps = await getCachedApps();
        setApps(updatedApps);

        // Create or update the tab
        // Build server sync URL (convert http(s) to ws(s) if needed)
        const serverConfig = manifest.config?.server;
        let serverUrl: string | undefined;
        if (serverConfig?.url) {
          const url = serverConfig.url;
          if (url.startsWith('ws://') || url.startsWith('wss://')) {
            serverUrl = url;
          } else if (url.startsWith('http://')) {
            serverUrl = url.replace('http://', 'ws://');
          } else if (url.startsWith('https://')) {
            serverUrl = url.replace('https://', 'wss://');
          } else {
            serverUrl = url;
          }
          // Ensure /sync path
          if (!serverUrl.endsWith('/sync')) {
            serverUrl = serverUrl.replace(/\/$/, '') + '/sync';
          }
        }

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
          if (!permissionConfig) return;
          // Recorded from the same list the check above reads, so the two
          // cannot drift. An earlier version enumerated four capabilities by
          // hand and omitted ai, gpu and sync, so a grant for those was never
          // written down.
          const grantedPerms: Record<string, boolean> = {};
          for (const capability of requested) grantedPerms[capability] = true;
          // Not awaited, and its failure does not block the grant. getDB
          // rejects outright in private browsing, and an Allow that does
          // nothing until a write succeeds is a button that looks broken to
          // exactly the users with the most reason to distrust it. The tab is
          // the authority for this run; IndexedDB is only the memory of it.
          void recordPermissionGrant(appOrigin, grantedPerms);

          const grantedResolver = createImportResolver(textFiles, permissionConfig);
          // The resolver being replaced is read out of the updater's own
          // `prev`, not out of openTabsRef. That ref is only refreshed on
          // render, so two activations in one frame both read the pre-grant
          // tab: the second built a resolver that replaced nothing and was
          // never disposed, and the first one's stayed live for the session.
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
            setOpenTabs((prev) => {
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

        const newTab: OpenTab = {
          id: tabId,
          name: appName,
          appId: appOrigin,
          version: typeof manifest.version === 'string' ? manifest.version : undefined,
          source,
          icon: icon || undefined,
          initialPage: initialPage || existingTab?.initialPage,
          permissions: manifest.permissions,
          permissionConfig: runningConfig || undefined,
          consent:
            hasGrant || !permissionConfig
              ? undefined
              : { config: permissionConfig, capabilities: requested, appName, appIcon: icon || undefined, onAllow },
          importResolver,
          assetResolver: createAssetResolver(binaryFiles, textFiles),
          logicBasePath,
          preIncludedLogicPaths,
          execution: manifest.config?.execution,
          serverUrl,
          serverToken: serverConfig?.token,
          serverCollections: serverConfig?.collections,
          directorySlug,
        };
        setOpenTabs((prev) => {
          const idx = prev.findIndex((t) => t.id === tabId);
          if (idx !== -1) {
            // Update skeleton tab in-place
            return prev.map((t) => (t.id === tabId ? newTab : t));
          }
          return [...prev, newTab];
        });
        setActiveTabId(tabId);
        setLoadingTabId(null);
        setLoadingFileName('');
        return appName;
      } catch (err) {
        console.error('[SoftN Web] Failed to load bundle:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoadingTabId(null);
        setLoadingFileName('');
        if (skeletonTabId) {
          setOpenTabs((prev) => prev.filter((t) => t.id !== skeletonTabId));
          setActiveTabId(null);
        }
        return null;
      }
    },
    []
  );

  /** Handle file from picker or drag-drop */
  const handleOpenFile = useCallback(
    (data: Uint8Array, fileName: string) => {
      processBundleData(data, fileName);
    },
    [processBundleData]
  );

  /**
   * Open a bundle served from this site — the `?open=` entry point, and what a
   * demo card on the launcher clicks.
   */
  const openFromUrl = useCallback(
    (value: string): Promise<string | null> => {
      let url: URL;
      try {
        url = resolveBundleUrl(value, window.location.origin);
      } catch (err) {
        // Nothing has been fetched and no tab exists yet, so a rejected value is
        // only ever the error card.
        setError(err instanceof Error ? err : new Error(String(err)));
        setActiveTabId(null);
        return Promise.resolve(null);
      }

      // A bundle from the directory is known by its slug; the placeholder tab
      // wears it until the manifest's own name arrives.
      // A tab already opened from this address is the same app — the slug is
      // the directory's identity for it, the address the runtime's — and is
      // shown again rather than fetched again. Not by name: that is the
      // bundle's own, and two bundles may share it.
      const directorySlug = directorySlugOf(url);
      const displayName = directorySlug ?? bundleNameFromUrl(url);
      const loadedTab = openTabsRef.current.find(
        (t) => t.source && (directorySlug ? t.directorySlug === directorySlug : t.bundleUrl === url.href)
      );
      if (loadedTab) {
        setActiveTabId(loadedTab.id);
        return Promise.resolve(loadedTab.name);
      }

      // A load for this exact bundle is already running: join it. Without this,
      // a double-clicked demo card and StrictMode's doubled mount effect both
      // download the bundle twice and leave a placeholder nobody owns — the tab
      // bar ends up with the running app beside a tab loading forever.
      const joined = inFlightRef.current.get(url.href);
      if (joined) return joined;

      const run = async (): Promise<string | null> => {
        // The same placeholder the /app/:name flow uses, so the download shows
        // up in the tab bar instead of leaving the window blank until it lands.
        // processBundleData adopts it once the real name is known.
        const skeletonTabId = crypto.randomUUID();
        setError(null);
        setOpenTabs((prev) => [...prev, { id: skeletonTabId, name: displayName, source: '' }]);
        setActiveTabId(skeletonTabId);

        // The placeholder is the download's lease. Closing the tab aborts it —
        // a large bundle used to keep downloading after its tab was gone, and
        // then open anyway, so the app the user had just dismissed appeared in
        // a new tab a few seconds later.
        const controller = new AbortController();
        loadAbortsRef.current.set(skeletonTabId, controller);

        let data: Uint8Array;
        try {
          data = await fetchRemoteBundle(url, controller.signal);
        } catch (err) {
          // An abort is the user closing the tab, not a failure to report.
          if (controller.signal.aborted) return null;
          console.error('[SoftN Web] Failed to fetch bundle:', err);
          setError(err instanceof Error ? err : new Error(String(err)));
          discardPlaceholder(skeletonTabId);
          return null;
        } finally {
          loadAbortsRef.current.delete(skeletonTabId);
        }

        // Closed while the bytes were on their way, or between the abort and
        // the fetch noticing: either way there is nothing left to open into.
        if (controller.signal.aborted || !openTabsRef.current.some((t) => t.id === skeletonTabId)) {
          return null;
        }

        // Whatever happens from here the placeholder is this function's to
        // account for: it is gone unless processBundleData reports that it
        // opened the bundle, in which case the tab it adopted is the running app.
        let opened: string | null = null;
        try {
          opened = await processBundleData(data, `${displayName}.softn`, undefined, undefined, directorySlug, skeletonTabId);
          if (opened) {
            setOpenTabs((prev) => prev.map((t) => (t.id === skeletonTabId && t.source ? { ...t, bundleUrl: url.href } : t)));
          }
          // The run is counted when the app reports itself ready, not here:
          // see announceReady. Counting at this point said "the bundle
          // parsed", which is not the same as "the app ran".
          return opened;
        } catch (err) {
          // processBundleData reports its own failures, so anything thrown out
          // of it is a surprise — surfacing it here keeps the promise this
          // function returns resolved, which the ?open= caller relies on.
          console.error('[SoftN Web] Failed to open bundle:', err);
          setError(err instanceof Error ? err : new Error(String(err)));
          return null;
        } finally {
          if (opened === null) discardPlaceholder(skeletonTabId);
        }
      };

      // `load` is referenced inside its own initializer, which is safe because
      // the callback cannot run until the promise settles, long after binding.
      const load: Promise<string | null> = run().finally(() => {
        // Only clear the entry if it is still this load's; a later request for
        // the same bundle owns the slot by then.
        if (inFlightRef.current.get(url.href) === load) inFlightRef.current.delete(url.href);
      });
      inFlightRef.current.set(url.href, load);
      return load;
    },
    [processBundleData, discardPlaceholder]
  );

  /** Handle opening a cached app */
  /**
   * Carry one build's records into another, then open it.
   *
   * The runtime will not do this by itself — a digest is what keeps apps apart,
   * and nothing proves two bundles share an author — but the person who chose to
   * install the update can say so. The records are copied, not moved, so the
   * older build still has its own to go back to if the update turns out wrong.
   */
  const handleAdoptData = useCallback(
    (from: CachedApp, to: CachedApp) => {
      if (!from.origin || !to.origin) return;
      const result = copyAppData(from.origin, to.origin);
      if (!result.ok) {
        // Whole or not at all: the destination is as it was, and the user
        // stays where they can try again rather than being sent into an
        // update that carries some of their records and none of the rest.
        console.warn(`[SoftN Web] Could not copy stored data from v${from.version} to v${to.version}: ${result.error}`);
        setError(
          new Error(
            `Your data could not be brought forward from v${from.version} to v${to.version}: ${result.error ?? 'unknown error'} ` +
              `Nothing was changed: v${from.version} still has its data, and v${to.version} is as it was.`
          )
        );
        setActiveTabId(null);
        return;
      }
      console.info(
        `[SoftN Web] Copied ${result.copied} of ${result.total} stored keys from "${from.name}" v${from.version} to v${to.version}${result.skipped ? ` (${result.skipped} already there)` : ''}.`
      );
      handleOpenCached(to);
    },
    // handleOpenCached is defined below; referenced lazily inside the callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const handleOpenCached = useCallback(
    (app: CachedApp) => {
      // By identity, not by label. Two cached apps can legitimately share a
      // name — that is precisely what content-addressed identity allows, and
      // the launcher lists both — so matching on name meant clicking the second
      // card just re-focused the first one's tab. The user pressed a card for
      // one app and was shown a different app, with nothing to say so. Name is
      // kept only as a fallback for records cached before origins existed.
      const existingTab = openTabsRef.current.find((t) =>
        app.origin && t.appId ? t.appId === app.origin : t.name === app.name
      );
      if (existingTab) {
        setActiveTabId(existingTab.id);
        return;
      }
      processBundleData(app.bundleData, `${app.name}.softn`, app.id, undefined, app.directorySlug);
    },
    [processBundleData]
  );

  /** Handle removing a cached app */
  const handleRemove = useCallback(async (id: string) => {
    // Take the build's saved records with it. Leaving them behind meant every
    // removal orphaned data that nothing could reach or clear again.
    const going = await getCachedApp(id);
    const dropped = removeAppData(going?.origin);
    await removeCachedApp(id);
    if (dropped > 0) {
      console.info(`[SoftN Web] Removed "${going?.name}" v${going?.version} and its ${dropped} saved keys.`);
    }
    const updatedApps = await getCachedApps();
    setApps(updatedApps);
  }, []);

  /**
   * Hand the running app's bundle back as a file. What is downloaded is the
   * exact bytes that were opened — the cache keeps them — so what someone
   * takes away is what they were running, not a re-export of it.
   */
  const handleDownloadTab = useCallback(async (tabId: string) => {
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (!tab || !tab.appId) return;
    const cached = await getCachedAppByOrigin(tab.appId);
    if (!cached) return;
    const blob = new Blob([cached.bundleData as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(tab.directorySlug || tab.name).replace(/[\\/:*?"<>|]+/g, '-')}.softn`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  /** Close a tab */
  const handleCloseTab = useCallback(
    (tabId: string, andGoHome = false) => {
      // Clean up page tracking
      delete tabPagesRef.current[tabId];

      // Stop a download this tab was waiting on. Without it the bytes kept
      // coming for a tab that no longer existed, and the app opened anyway.
      const pending = loadAbortsRef.current.get(tabId);
      if (pending) {
        pending.abort();
        loadAbortsRef.current.delete(tabId);
      }

      // Asset resolvers own blob URLs. A closed SoftN tab should release its
      // images and models now rather than retain every bundle until the browser
      // tab eventually closes.
      const closingTab = openTabsRef.current.find((tab) => tab.id === tabId);
      closingTab?.importResolver?.dispose();
      closingTab?.assetResolver?.dispose();

      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.id !== tabId);
        // If we're closing the active tab, activate the nearest neighbor or
        // Home — or Home regardless, when Close was pressed over the app: the
        // person asked to stop what they were looking at, not to be handed
        // whatever else happened to be open.
        if (activeTabIdRef.current === tabId) {
          if (andGoHome || next.length === 0) {
            setActiveTabId(null);
          } else if (idx < next.length) {
            setActiveTabId(next[idx].id);
          } else {
            setActiveTabId(next[next.length - 1].id);
          }
        }
        return next;
      });
    },
    []
  );

  /** Select a tab */
  const handleSelectTab = useCallback((id: string | null) => {
    setActiveTabId(id);
    setError(null);
  }, []);

  /** File input change handler */
  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        handleOpenFile(new Uint8Array(buffer), file.name);
      } catch (err) {
        console.error('[SoftN Web] Failed to read file:', err);
        setError(err instanceof Error ? err : new Error('Failed to read file'));
      } finally {
        // Always reset so same file can be re-selected
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [handleOpenFile]
  );

  /**
   * Tell an embedder that the app is actually on screen.
   *
   * An iframe's `load` event only says the runtime shell arrived; parsing the
   * bundle and starting the engine takes another moment, and a page that
   * announces "running" during that gap is lying to its reader. There is
   * nothing sensitive in the message, so it is not worth narrowing the target
   * origin to a list the runtime would then have to maintain.
   */
  /** Tabs whose run has been counted, so a reload of the runtime inside one tab is not a second run. */
  const countedRunsRef = useRef(new Set<string>());

  /**
   * The app is up: its script loaded and its first page rendered. Two things
   * hear about it. An embedding page, if there is one, so it can stop
   * showing a spinner. And the directory the app came from, which counts the
   * run — here, on readiness, rather than when the bundle was fetched, so
   * that the number on the app's page means "ran" and not "was downloaded".
   * The site counts the press of Play separately, as a launch. A tab is
   * counted once: a permission grant reloads the runtime in place, and that
   * is the same run.
   */
  const announceReady = useCallback(
    (tab: OpenTab) => {
      if (embedded && window.parent !== window) {
        window.parent.postMessage({ type: 'softn:app-ready', app: tab.name }, '*');
      }
      if (tab.directorySlug && !countedRunsRef.current.has(tab.id)) {
        countedRunsRef.current.add(tab.id);
        // Best effort: a directory that is down is not a reason the app is not running.
        void fetch(`/api/apps/${encodeURIComponent(tab.directorySlug)}/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'open' }),
          keepalive: true,
        }).catch(() => {});
      }
    },
    [embedded]
  );

  /** Called by AppRunner when an app's currentPage changes */
  const handlePageChange = useCallback((tabId: string, page: string) => {
    tabPagesRef.current[tabId] = page;
    // Update URL (replace, not push — page changes don't create history entries)
    if (activeTabIdRef.current === tabId) {
      const tab = openTabsRef.current.find((t) => t.id === tabId);
      if (tab) {
        const url = entryUrl(buildAppUrl(tab.name, page));
        if (currentUrl() !== url) {
          window.history.replaceState({}, '', url);
        }
      }
    }
  }, [entryUrl]);

  // ── URL Routing: Load app from URL on mount ───────────────────

  useEffect(() => {
    if (entryHandledRef.current) return;
    entryHandledRef.current = true;

    if (urlInit.openValue) {
      // ?open= is a one-shot instruction: once it has been acted on the URL
      // becomes the ordinary /app/<name> form, so a reload replays the bundle
      // out of the cache instead of downloading it a second time — and a value
      // that was rejected does not sit in the address bar reproducing the same
      // error on every refresh.
      openFromUrl(urlInit.openValue).then((appName) => {
        window.history.replaceState({}, '', entryUrl(buildAppUrl(appName)));
        urlReadyRef.current = true;
      });
      return;
    }

    if (urlInit.appName) {
      // Always fetch the latest bundle from the directory API so updates/changes
      // are loaded immediately, with graceful offline fallback to cached app.
      if (urlTabId) discardPlaceholder(urlTabId);
      openFromUrl(`/api/apps/${encodeURIComponent(urlInit.appName!)}/bundle.softn`).then((appName) => {
        if (appName) {
          window.history.replaceState({}, '', entryUrl(buildAppUrl(appName, urlInit.page)));
          urlReadyRef.current = true;
        } else {
          // If server fetch failed (e.g. offline), fall back to cached version
          getCachedAppByName(urlInit.appName!).then((cachedApp) => {
            if (cachedApp) {
              processBundleData(cachedApp.bundleData, `${cachedApp.name}.softn`, cachedApp.id, urlInit.page || undefined, cachedApp.directorySlug)
                .then((cachedOpened) => {
                  if (cachedOpened) {
                    window.history.replaceState({}, '', entryUrl(buildAppUrl(cachedOpened, urlInit.page)));
                  } else {
                    setOpenTabs([]);
                    setActiveTabId(null);
                    window.history.replaceState({}, '', entryUrl(buildAppUrl(null)));
                  }
                });
            } else {
              setOpenTabs([]);
              setActiveTabId(null);
              window.history.replaceState({}, '', entryUrl(buildAppUrl(null)));
            }
            urlReadyRef.current = true;
          });
        }
      });
    } else {
      urlReadyRef.current = true;
    }
  }, [processBundleData, openFromUrl, entryUrl, urlInit, urlTabId, discardPlaceholder]);

  // ── URL Routing: Sync activeTabId → URL ──────────────────────

  useEffect(() => {
    if (!urlReadyRef.current) return;
    if (skipNextUrlPushRef.current) {
      skipNextUrlPushRef.current = false;
      return;
    }

    let url = buildAppUrl(null);
    if (activeTabId) {
      const tab = openTabs.find((t) => t.id === activeTabId);
      if (tab) {
        const page = tabPagesRef.current[activeTabId];
        url = buildAppUrl(tab.name, page);
      }
    }

    const next = entryUrl(url);
    if (currentUrl() !== next) {
      window.history.pushState({}, '', next);
    }
  }, [activeTabId, openTabs, entryUrl]);

  // ── URL Routing: Browser back/forward ────────────────────────

  useEffect(() => {
    const handlePopState = () => {
      const { appName } = parseAppUrl();
      skipNextUrlPushRef.current = true;

      if (!appName) {
        setActiveTabId(null);
        return;
      }

      // The address carries a name; the tab being looked at wins a tie.
      const tab = findTabForUrlName(openTabsRef.current, appName, activeTabIdRef.current);
      if (tab) {
        setActiveTabId(tab.id);
      } else {
        // App not open as a tab — go Home
        setActiveTabId(null);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Refresh cached apps when returning to Home
  useEffect(() => {
    if (activeTabId === null) {
      getCachedApps().then(setApps).catch(console.error);
    }
  }, [activeTabId]);

  const isHome = activeTabId === null;
  const activeTab = isHome ? null : openTabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <DropZone onFile={handleOpenFile}>
      <style dangerouslySetInnerHTML={{ __html: appShellStyles }} />
      {/* Hidden file input for the + button */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".softn"
        onChange={handleFileInputChange}
        style={{ display: 'none' }}
      />

      <div
        ref={shellRef}
        className={`softn-shell${embedded ? ' softn-shell--embedded' : ''}${!isHome ? ' softn-shell--playing' : ''}${!isHome && chromeHidden ? ' softn-shell--bare' : ''}`}
      >
        {/* Home wears the same product bar as the site, Studio and Builder. A
            running app takes the whole window under the same slim frame bar
            the site draws over an app playing from its directory page, so an
            app looks the same wherever it was opened from; the bar folds to a
            corner tab when the app wants every pixel. Embedded in someone
            else's page, the app is the whole frame and the host has the bar. */}
        {!embedded && isHome && <ProductBar current="runtime" />}
        {!embedded && !isHome && activeTab && chromeHidden && (
          <button type="button" className="softn-chrome-peek" onClick={() => setChromeHidden(false)} title="Show the bar">
            {activeTab.name}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}
        {!embedded && !isHome && activeTab && !chromeHidden && (
          <FrameBar
            tab={{ id: activeTab.id, name: activeTab.name, icon: activeTab.icon, directorySlug: activeTab.directorySlug }}
            onHome={() => handleSelectTab(null)}
            onClose={() => {
              handleCloseTab(activeTab.id, true);
              // Opened from an app's page on the site: Close is the way back
              // there. Opened here: Close is the runtime's home.
              if (backTo) window.location.assign(backTo);
            }}
            onHide={() => setChromeHidden(true)}
            fullscreenTarget={shellRef}
            onDownload={handleDownloadTab}
          />
        )}

        {/* Content area below tab bar */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {/* Loading indicator (for non-URL opens that don't have skeleton tabs) */}
          {loadingTabId && (
            <ThemeProvider followSystem>
              <Box
                className="softn-shell-loading"
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  flexDirection: 'column',
                  gap: '1rem',
                  background: 'var(--ink)',
                  zIndex: 10,
                }}
              >
                <Spinner size="lg" />
                <Text style={{ color: 'var(--dim)', fontSize: '0.875rem', letterSpacing: '-0.01em' }}>Loading {loadingFileName}...</Text>
              </Box>
            </ThemeProvider>
          )}

          {/* Error state */}
          {error && !loadingTabId && (
            <ThemeProvider followSystem>
              <div
                className="softn-shell-error"
                style={{
                  position: 'absolute',
                  inset: 0,
                  padding: '2rem',
                  background: 'var(--ink)',
                  zIndex: 10,
                  overflow: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div
                  className="softn-shell-error-card"
                  style={{
                    padding: '2rem',
                    background: 'var(--ink-2)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '14px',
                    maxWidth: '480px',
                    width: '100%',
                    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                    <div style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '10px',
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                      </svg>
                    </div>
                    <div style={{
                      color: 'var(--paper)',
                      fontWeight: 600,
                      fontSize: '1.0625rem',
                      letterSpacing: '-0.02em',
                    }}>
                      Failed to load application
                    </div>
                  </div>
                  <div style={{
                    color: 'var(--dim)',
                    fontSize: '0.8125rem',
                    lineHeight: 1.6,
                    padding: '0.75rem 1rem',
                    background: 'var(--inset)',
                    borderRadius: '8px',
                    border: '1px solid var(--inset)',
                    fontFamily: 'monospace',
                    wordBreak: 'break-word',
                  }}>
                    {error.message}
                  </div>
                  <button
                    className="softn-shell-error-btn"
                    onClick={() => {
                      setError(null);
                      setActiveTabId(null);
                    }}
                    style={{
                      marginTop: '1.25rem',
                      padding: '0.5rem 1.25rem',
                      background: 'var(--ink-3)',
                      color: 'var(--paper)',
                      border: '1px solid var(--line)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    Back to Home
                  </button>
                </div>
              </div>
            </ThemeProvider>
          )}

          {/* Home / Launcher */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'auto',
              display: isHome && !loadingTabId && !error ? 'block' : 'none',
            }}
          >
            <Launcher
              apps={apps}
              running={openTabs.map((t) => ({ id: t.id, name: displayNameFor(t, openTabs), icon: t.icon }))}
              onResume={(id) => handleSelectTab(id)}
              onStop={(id) => handleCloseTab(id, true)}
              onOpenFile={handleOpenFile}
              onOpenCached={handleOpenCached}
              onRemove={handleRemove}
              onAdoptData={handleAdoptData}
            />
          </div>

          {/* All open app tabs — stay mounted, toggled via display */}
          {openTabs.map((tab) => (
            <AppRunner
              key={tab.id}
              source={tab.source}
              appName={tab.name}
              appId={tab.appId}
              active={activeTabId === tab.id && !error}
              initialPage={tab.initialPage}
              permissions={tab.permissions}
              importResolver={tab.importResolver}
              assetResolver={tab.assetResolver}
              logicBasePath={tab.logicBasePath}
              preIncludedLogicPaths={tab.preIncludedLogicPaths}
              executionPreference={tab.execution}
              permissionConfig={tab.permissionConfig}
              consent={tab.consent}
              onPageChange={(page) => handlePageChange(tab.id, page)}
              onReady={() => announceReady(tab)}
              serverUrl={tab.serverUrl}
              serverToken={tab.serverToken}
              serverCollections={tab.serverCollections}
              storageEndpoint={
                tab.directorySlug ? `/api/apps/${encodeURIComponent(tab.directorySlug)}/storage` : undefined
              }
            />
          ))}
        </div>
      </div>
    </DropZone>
  );
}

export default App;
