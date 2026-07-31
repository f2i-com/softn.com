import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ThemeProvider, Spinner, Box, Text } from '@softn/components';
import { DropZone } from './components/DropZone';
import { Launcher } from './components/Launcher';
import { AppRunner } from './components/AppRunner';
import { TabBar } from './components/TabBar';
import { PermissionPrompt } from './components/PermissionPrompt';
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
    --softn-tab-bar-height: 38px;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
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
    background: #3a3a44 !important;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }
  .softn-shell-error-btn:active {
    transform: translateY(0) scale(0.98);
  }
  @media (max-width: 640px) {
    .softn-shell {
      --softn-tab-bar-height: 34px;
    }
  }
  /* Touch overrides the narrow-window shrink: the bar has to match the 44px
     targets TabBar gives its controls, or the app area is laid out short. */
  @media (pointer: coarse) {
    .softn-shell {
      --softn-tab-bar-height: 44px;
    }
  }
`;
import {
  readZip,
  loadXDBData,
  processBundle,
  createImportResolver,
  extractIconDataUrl,
  extractPermissions,
  requestedCapabilities,
  type BundleManifest,
} from './lib/bundleProcessor';
import {
  getCachedApps,
  cacheApp,
  computeAppOrigin,
  getCachedAppByName,
  getCachedAppByOrigin,
  removeCachedApp,
  updateLastOpened,
  updateGrantedPermissions,
  type CachedApp,
} from './lib/appCache';
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
} {
  restoreForwardedPath();
  const params = new URLSearchParams(window.location.search);
  const embedded = params.get('embed') === '1';
  const openValue = params.get('open');
  if (openValue) return { openValue, appName: null, page: null, embedded };
  return { openValue: null, ...parseAppUrl(), embedded };
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
  source: string; // empty string = skeleton tab (loading)
  icon?: string;
  initialPage?: string;
  permissions?: import('@softn/core').AppPermissions;
  permissionConfig?: PermissionConfig;
  importResolver?: (path: string) => Promise<string | null>;
  logicBasePath?: string;
  preIncludedLogicPaths?: string[];
  serverUrl?: string;
  serverToken?: string;
  serverCollections?: string[];
}

/**
 * One bundle waiting on a permission decision.
 *
 * Identity matters: the callbacks close over the entry itself so a decision
 * removes the right one from the queue even when several are outstanding.
 */
interface PendingPermission {
  config: PermissionConfig;
  appName: string;
  appIcon?: string;
  onAllow: () => void;
  onDeny: () => void;
}

// ── App Component ────────────────────────────────────────────────

function App(): React.ReactElement {
  // Parse URL once for initial state
  const [urlInit] = useState(readEntry);
  // Pre-create a skeleton tab ID if loading from URL (so tab bar shows immediately)
  const [urlTabId] = useState(() => (urlInit.appName ? crypto.randomUUID() : null));
  const embedded = urlInit.embedded;

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
  // A queue, not a slot. Each entry owns the promise that a processBundleData
  // call is parked on, and only the head is rendered. It used to be a single
  // slot: opening a second bundle while the first was still asking replaced the
  // first entry outright, and with it the only references to that promise's
  // resolve — so the first tab waited on a promise nothing could ever settle and
  // sat on "Loading…" for the rest of the session.
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const pendingPermission = pendingPermissions[0] ?? null;
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  /** Process a .softn bundle from raw bytes. Resolves with the app's name, or null if it did not open. */
  const processBundleData = useCallback(
    async (
      data: Uint8Array,
      fileName: string,
      cachedAppId?: string,
      initialPage?: string
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

        // Check if a tab with this name already exists (use ref for fresh value).
        //
        // A URL load names its placeholder after the file, which need not match
        // the name inside — AIChat.softn calls itself "AI Chat" — so a
        // placeholder still waiting on this file counts as the same tab. Without
        // that second lookup the bundle would open in a fresh tab and leave the
        // placeholder loading forever.
        const placeholderName = fileName.replace(/\.softn$/i, '');
        const existingTab =
          openTabsRef.current.find((t) => t.name === appName) ||
          openTabsRef.current.find((t) => !t.source && t.name === placeholderName);
        if (existingTab && existingTab.source) {
          // Already fully loaded — just switch to it
          setActiveTabId(existingTab.id);
          // A placeholder opened for this file has nothing left to become, and
          // would otherwise sit in the tab bar loading forever.
          setOpenTabs((prev) => prev.filter((t) => t.source || t.name !== placeholderName));
          return appName;
        }

        // Use existing skeleton tab ID (from URL pre-populate) or create new
        const tabId = existingTab?.id || crypto.randomUUID();
        // A tab with no source is a placeholder waiting for this load. If the
        // load fails it has to go, or it renders "Loading …" indefinitely.
        if (existingTab && !existingTab.source) skeletonTabId = existingTab.id;

        if (!existingTab) {
          // Fresh open (not from URL) — show loading overlay
          setLoadingTabId(tabId);
          setLoadingFileName(appName);
          setActiveTabId(null); // Show loading on Home
        }

        // Extract permission config from permission.json or manifest.permissions
        const permissionConfig = extractPermissions(textFiles, manifest);

        // Extract icon early (needed for permission prompt)
        const icon = extractIconDataUrl(binaryFiles, manifest);

        // Check if permissions are declared and need consent
        if (permissionConfig) {
          // Look up cached app to check for prior grant.
          //
          // The grant has to be compared against what *this* bundle asks for.
          // The old check was a boolean "has this name ever been prompted",
          // and the lookup is by manifest name — so version 2 of an app, or
          // any unrelated .softn calling itself the same thing, could add
          // net + camera + files to a bundle the user had approved for `qr`
          // alone and never see a prompt. The stored grant map was written and
          // then never read by anything.
          // By origin, not by name. A grant belongs to the bundle the user
          // actually approved; looking it up by name handed it to anything that
          // later called itself the same thing.
          const cachedApp = await getCachedAppByOrigin(appOrigin);
          const requested = requestedCapabilities(permissionConfig);
          const granted = cachedApp?.grantedPermissions ?? {};
          const hasGrant =
            Boolean(cachedApp?.permissionsPromptedAt) &&
            requested.every((capability) => granted[capability]);

          if (!hasGrant) {
            // Show permission prompt and wait for user decision
            const userDecision = await new Promise<boolean>((resolve) => {
              const entry: PendingPermission = {
                config: permissionConfig,
                appName,
                appIcon: icon,
                // Drop THIS entry, not whatever happens to be showing — the two
                // are the same only when nothing else queued up behind it.
                onAllow: () => {
                  setPendingPermissions((queue) => queue.filter((item) => item !== entry));
                  resolve(true);
                },
                onDeny: () => {
                  setPendingPermissions((queue) => queue.filter((item) => item !== entry));
                  resolve(false);
                },
              };
              setPendingPermissions((queue) => [...queue, entry]);
            });

            if (!userDecision) {
              // User denied — clean up and show error
              setLoadingTabId(null);
              setLoadingFileName('');
              // Remove skeleton tab if it was created for URL
              if (existingTab && !existingTab.source) {
                setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
              }
              setActiveTabId(null);
              setError(new Error(`Permission denied: "${appName}" was not granted the requested permissions.`));
              return null;
            }

            // User allowed — store grant in cache.
            //
            // Recorded from the same list the check above reads, so the two
            // cannot drift. The previous version enumerated four capabilities
            // by hand and silently omitted ai, gpu and sync, which meant a
            // grant for those was never written down.
            const grantedPerms: Record<string, boolean> = {};
            for (const capability of requestedCapabilities(permissionConfig)) {
              grantedPerms[capability] = true;
            }

            // Cache the app first so we have an ID to store grants against
            const cached = await cacheApp(data, manifest, icon);
            if (cached) {
              await updateGrantedPermissions(cached.id, grantedPerms);
            }
          }
        }

        // Load XDB data (per-app isolation)
        await loadXDBData(textFiles, manifest, appOrigin);

        // Process source
        const { source, logicBasePath, preIncludedLogicPaths } = processBundle(textFiles, manifest);
        const importResolver = createImportResolver(textFiles);

        // Cache the app (may already be cached from permission flow above, cacheApp handles dedup by name)
        await cacheApp(data, manifest, icon);

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

        const newTab: OpenTab = {
          id: tabId,
          name: appName,
          appId: appOrigin,
          source,
          icon: icon || undefined,
          initialPage: initialPage || existingTab?.initialPage,
          permissions: manifest.permissions,
          permissionConfig: permissionConfig || undefined,
          importResolver,
          logicBasePath,
          preIncludedLogicPaths,
          serverUrl,
          serverToken: serverConfig?.token,
          serverCollections: serverConfig?.collections,
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

      const displayName = bundleNameFromUrl(url);
      const loadedTab = openTabsRef.current.find((t) => t.name === displayName && t.source);
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

        let data: Uint8Array;
        try {
          data = await fetchRemoteBundle(url);
        } catch (err) {
          console.error('[SoftN Web] Failed to fetch bundle:', err);
          setError(err instanceof Error ? err : new Error(String(err)));
          discardPlaceholder(skeletonTabId);
          return null;
        }

        // Whatever happens from here the placeholder is this function's to
        // account for: it is gone unless processBundleData reports that it
        // opened the bundle, in which case the tab it adopted is the running app.
        let opened: string | null = null;
        try {
          opened = await processBundleData(data, `${displayName}.softn`);
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
      processBundleData(app.bundleData, `${app.name}.softn`, app.id);
    },
    [processBundleData]
  );

  /** Handle removing a cached app */
  const handleRemove = useCallback(async (id: string) => {
    await removeCachedApp(id);
    const updatedApps = await getCachedApps();
    setApps(updatedApps);
  }, []);

  /** Close a tab */
  const handleCloseTab = useCallback(
    (tabId: string) => {
      // Clean up page tracking
      delete tabPagesRef.current[tabId];

      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.id !== tabId);
        // If we're closing the active tab, activate the nearest neighbor or Home
        if (activeTabIdRef.current === tabId) {
          if (next.length === 0) {
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

  /** "+" button triggers file input */
  const handleAddTab = useCallback(() => {
    fileInputRef.current?.click();
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
  const announceReady = useCallback(
    (appName: string) => {
      if (!embedded || window.parent === window) return;
      window.parent.postMessage({ type: 'softn:app-ready', app: appName }, '*');
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
      getCachedAppByName(urlInit.appName).then((cachedApp) => {
        if (cachedApp) {
          // The tab this component pre-created is under the same rule as the
          // one ?open= makes: a cached bundle that no longer reads as a bundle
          // throws before processBundleData can adopt it, so the placeholder is
          // retired here rather than in there.
          processBundleData(cachedApp.bundleData, `${cachedApp.name}.softn`, cachedApp.id, urlInit.page || undefined)
            .then((appName) => {
              if (appName === null && urlTabId) discardPlaceholder(urlTabId);
            });
        } else {
          // App not in cache — remove skeleton tab and go Home
          setOpenTabs([]);
          setActiveTabId(null);
          window.history.replaceState({}, '', entryUrl(buildAppUrl(null)));
        }
        urlReadyRef.current = true;
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

      // Find open tab with matching name
      const tab = openTabsRef.current.find((t) => t.name === appName);
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

      <div className="softn-shell">
        {/* Embedded in someone else's page: the app is the whole frame, and tabs
            belong to the host document rather than to us. */}
        {!embedded && (
          <TabBar
            tabs={openTabs.map((t) => ({ id: t.id, name: t.name, icon: t.icon }))}
            activeTabId={activeTabId}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
            onAddTab={handleAddTab}
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
                  background: '#0c0c0e',
                  zIndex: 10,
                }}
              >
                <Spinner size="lg" />
                <Text style={{ color: '#5a5a66', fontSize: '0.875rem', letterSpacing: '-0.01em' }}>Loading {loadingFileName}...</Text>
              </Box>
            </ThemeProvider>
          )}

          {/* Permission consent prompt */}
          {pendingPermission && (
            <PermissionPrompt
              appName={pendingPermission.appName}
              appIcon={pendingPermission.appIcon}
              permissions={pendingPermission.config}
              onAllow={pendingPermission.onAllow}
              onDeny={pendingPermission.onDeny}
            />
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
                  background: '#0c0c0e',
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
                    background: '#16161a',
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
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                      </svg>
                    </div>
                    <div style={{
                      color: '#ececf0',
                      fontWeight: 600,
                      fontSize: '1.0625rem',
                      letterSpacing: '-0.02em',
                    }}>
                      Failed to load application
                    </div>
                  </div>
                  <div style={{
                    color: '#7a7a86',
                    fontSize: '0.8125rem',
                    lineHeight: 1.6,
                    padding: '0.75rem 1rem',
                    background: 'rgba(255, 255, 255, 0.02)',
                    borderRadius: '8px',
                    border: '1px solid rgba(255, 255, 255, 0.04)',
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
                      background: '#1e1e23',
                      color: '#ececf0',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
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
              onOpenFile={handleOpenFile}
              onOpenCached={handleOpenCached}
              onOpenUrl={openFromUrl}
              onRemove={handleRemove}
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
              logicBasePath={tab.logicBasePath}
              preIncludedLogicPaths={tab.preIncludedLogicPaths}
              permissionConfig={tab.permissionConfig}
              onPageChange={(page) => handlePageChange(tab.id, page)}
              onReady={() => announceReady(tab.name)}
              serverUrl={tab.serverUrl}
              serverToken={tab.serverToken}
              serverCollections={tab.serverCollections}
            />
          ))}
        </div>
      </div>
    </DropZone>
  );
}

export default App;
