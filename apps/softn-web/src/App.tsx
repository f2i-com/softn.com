import { reopenBundle } from './lib/reopenBundle';
import { useLocalBundleFile } from './lib/useLocalBundleFile';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
// From the minimal and theme entries, not the root barrel: the barrel is the
// eager path, and keeping Scene3D out of the shell would then rest on the
// bundler tree-shaking it away (docs/engineering/COMPONENT_LOADING.md).
import { Spinner, Text } from '@softn/components/essentials';
import { ThemeProvider } from '@softn/components/theme';
// Before the components' own stylesheets, which used to follow this one in
// the document as <style> elements.
import './App.css';
import { DropZone } from './components/DropZone';
import { ErrorCard } from './components/ErrorCard';
import { Launcher } from './components/Launcher';
import { AppRunner } from './components/AppRunner';
import { FrameBar } from '@softn/runtime-shell/FrameBar';
import { ProductBar } from '@softn/brand';
import { describeHandoffFailure, handoffIdFrom, takeBundleHandoff } from '@softn/core';
import { debug } from '@softn/core';
import { randomUUID } from '@softn/bundle-format/crypto';

import { installAppOffline } from './lib/offlineInstall';
import { whenIdle } from './lib/idle';
import {
  getCachedApp,
  getCachedApps,
  copyAppData,
  currentBuildId,
  exportAppData,
  importAppData,
  readAppDataSnapshot,
  recoverInterruptedImports,
  snapshotEntryCount,
  hasStoredData,
  isOfflineReady,
  getCachedAppByName,
  getCachedAppByOrigin,
  removeAppData,
  removeCachedApp,
  setOfflineState,
  type CachedApp,
} from './lib/appCache';
import { displayNameFor, findCachedAppTab, findTabForUrlName } from './lib/tabIdentity';
import { openBundle, type OpenBundleHost, type OpenBundleRequest, type OpenTab } from './lib/openBundle';
import { parseAppPath, buildAppPath, publicPath } from './lib/appUrl';
import { resolveBundleUrl, fetchRemoteBundle, bundleNameFromUrl } from './lib/remoteBundle';

// ── URL Routing Helpers ──────────────────────────────────────────

function parseAppUrl(): { appName: string | null; page: string | null } {
  return parseAppPath(window.location.pathname, import.meta.env.BASE_URL);
}

function buildAppUrl(appName: string | null, page?: string | null): string {
  return buildAppPath(appName, page, import.meta.env.BASE_URL);
}

// ── Demo catalogue ──
//
// The directory API answers /api/apps/<slug>/bundle.softn in production and
// knows an app by the slug of its name. A development checkout without PHP has
// no API at all, so reloading /app/<name> for a demo the runtime ships 404ed
// and fell back to whatever the cache held — a console error on every refresh
// of every demo. The catalogue in public/demos lists each shipped demo by id,
// name and file, so the same demo can be reopened from there. The slug rule
// matches the API's (Apps::slugify) so that "The Night Window" finds
// the-night-window either way.
function slugOfName(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'app').slice(0, 48);
}

async function demoBundleUrlFor(appName: string): Promise<string | null> {
  // The production distribution has no bundled demo catalogue.
  if (!import.meta.env.DEV) return null;
  try {
    const response = await fetch(publicPath('demos/index.json', import.meta.env.BASE_URL), {
      credentials: 'same-origin',
      cache: 'no-cache',
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    const entries: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { demos?: unknown }).demos)
        ? ((parsed as { demos: unknown[] }).demos)
        : [];
    const wanted = slugOfName(appName);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const { id, name, file } = entry as { id?: unknown; name?: unknown; file?: unknown };
      // A catalogue file is a bare name inside demos/, never a path.
      if (typeof file !== 'string' || !/^[^/\\]+\.softn$/i.test(file) || file.includes('..')) continue;
      if (id === wanted || (typeof name === 'string' && slugOfName(name) === wanted)) {
        return publicPath(`demos/${file}`, import.meta.env.BASE_URL);
      }
    }
  } catch {
    // No catalogue is not an error: the cache is the next place to look.
  }
  return null;
}

/** The URL as the history API sees it, base and query included. */
function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

/**
 * A query-string value as a path of this origin, or null.
 *
 * Judged by where the URL parser actually sends it, not by its first
 * characters: the parser strips tabs and newlines before it looks for a
 * scheme or an authority, so `/%09/evil.com` — which a string test passes as
 * a plain path — resolves to `//evil.com`. What comes back is the parsed
 * path, query and fragment, so what is navigated to is what was checked.
 */
function sameOriginPath(value: string | null): string | null {
  if (!value || !value.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(value, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.pathname + url.search + url.hash;
}

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
  const forwarded = sameOriginPath(params.get('softn-restore'));
  if (!forwarded) return;
  try {
    window.history.replaceState(null, '', forwarded);
  } catch {
    // Some embedded contexts refuse replaceState; the launcher still opens.
  }
}

/**
 * How this page was entered.
 *
 * `?open=` beats an `/app/` path deliberately: both want the one skeleton tab,
 * and a bundle arriving over the network racing a bundle arriving from the
 * cache would leave whichever lost holding a tab that never finishes loading.
 */
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
  const backTo = sameOriginPath(params.get('back'));
  const openValue = params.get('open');
  if (openValue === 'handoff') {
    const { id } = handoffIdFrom(window.location.search, 'runtime');
    return { openValue: id ? `handoff:${id}` : 'handoff', appName: null, page: null, embedded, backTo };
  }
  if (openValue) return { openValue, appName: null, page: null, embedded, backTo };
  return { openValue: null, ...parseAppUrl(), embedded, backTo };
}

/** A line on Home, and the one thing to do about it when there is one. */
interface HomeNotice {
  text: string;
  /** Something to do first, rather than something that went right. */
  warning?: boolean;
  /** Stop a running app, which is what the line asks for. */
  stop?: { tabId: string; label: string };
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
  const [urlTabId] = useState(() => (urlInit.appName ? randomUUID() : null));
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
  /** Home's scroller: Home is not the window's scroll but its own. */
  const homeRef = useRef<HTMLDivElement>(null);
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  /** Cached apps whose open from Home is still loading, by record id, each with the navigation its latest press claimed. */
  const openingCachedRef = useRef(new Map<string, { isForeground: () => boolean }>());
  // Selection belongs to the last user navigation, including requests still
  // reading the cache before they have a placeholder or a real tab.
  const navigationRevisionRef = useRef(0);
  const claimNavigation = useCallback(() => {
    const revision = ++navigationRevisionRef.current;
    return () => revision === navigationRevisionRef.current;
  }, []);

  // URL routing state
  const tabPagesRef = useRef<Record<string, string>>({}); // tabId → current page
  const [urlReady, setUrlReady] = useState(false);
  const replaceNextUrlRef = useRef(true); // canonicalize the initial entry without adding history
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
  /** Offline installs still running, by the tab whose open started them. */
  const installAbortsRef = useRef(new Map<string, AbortController>());
  /** Cache records an install is running for, so Home can say "Installing…". */
  const [installing, setInstalling] = useState<ReadonlySet<string>>(() => new Set());
  const unmountCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stop work and release blob URLs when the runtime itself is unmounted.
  // Closing an individual app does the same below; this covers navigation away
  // from the entire shell while tabs or downloads are still alive.
  useEffect(() => {
    const pendingDownloads = loadAbortsRef.current;
    const pendingInstalls = installAbortsRef.current;
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
        for (const controller of pendingInstalls.values()) controller.abort();
        pendingInstalls.clear();
        for (const tab of tabsRef.current) {
          tab.importResolver?.dispose();
          tab.assetResolver?.dispose();
        }
      }, 0);
    };
  }, []);

  // Keep validated entry context through rewrites and reloads. The one-shot
  // open/handoff parameters are removed, but Close must still know its way back.
  const entryUrl = useCallback(
    (path: string) => {
      const params = new URLSearchParams();
      if (embedded) params.set('embed', '1');
      if (backTo) params.set('back', backTo);
      const query = params.toString();
      return query ? `${path}?${query}` : path;
    },
    [embedded, backTo]
  );

  // Load cached apps on mount. An import of app data that the browser cut
  // short is finished first — the data it was replacing goes back — before
  // any app can open on top of the half it left.
  useEffect(() => {
    try {
      recoverInterruptedImports();
    } catch (err) {
      console.warn('[SoftN Web] Could not check for interrupted imports:', err);
    }
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
   * Fetch what an app needs to open without a network, after it has opened
   * with one.
   *
   * The record's `offline` says whether an earlier install still holds: it
   * must have succeeded, and against this shell build, because a deployment
   * renames every chunk — so a record installed before one is stale and is
   * installed again here. A record that holds is left alone. Nothing waits
   * on this: the app is on screen, and the outcome is a word on its card at
   * Home ("Offline ready", "Installing…", "Needs connection"). The tab owns
   * the run; closing it aborts, and an aborted run records nothing.
   */
  const beginOfflineInstall = useCallback(
    (
      tabId: string,
      record: CachedApp,
      source: string,
      execution: 'worker' | 'main' | undefined,
      capabilities: string[],
      pythonPackages?: readonly string[]
    ): void => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (isOfflineReady(record)) return;
      const controller = new AbortController();
      installAbortsRef.current.get(tabId)?.abort();
      installAbortsRef.current.set(tabId, controller);
      setInstalling((prev) => new Set(prev).add(record.id));
      // Background work, started once the browser is idle after the app
      // opens: the modules it imports (every loader a scene may ask for, the
      // QR decoder) are parsed and run after the app's own opening work
      // rather than between its steps.
      void whenIdle(controller.signal)
        .then(() =>
          controller.signal.aborted
            ? null
            : installAppOffline(
                { id: record.id, source, execution, capabilities, pythonPackages },
                { signal: controller.signal }
              )
        )
        .then(async (result) => {
          if (!result || controller.signal.aborted) return;
          const why = result.ready
            ? undefined
            : result.error ??
              `missing ${[...result.missing, ...(result.workerAssets === 'unavailable' ? ['worker assets'] : [])].join(', ')}`;
          await setOfflineState(record.id, {
            ready: result.ready,
            features: result.features,
            optionalOnline: result.optionalOnline,
            build: currentBuildId(),
            at: Date.now(),
            // Kept so Home can say why, not only that, it needs a connection.
            ...(why ? { reason: why } : {}),
          });
          if (why) {
            console.warn(`[SoftN Web] "${record.name}" is not installed offline: ${why}`);
          }
          if (controller.signal.aborted) return;
          setApps(await getCachedApps());
        })
        .catch((err) => {
          console.warn(`[SoftN Web] Offline install of "${record.name}" failed:`, err);
        })
        .finally(() => {
          if (installAbortsRef.current.get(tabId) === controller) installAbortsRef.current.delete(tabId);
          setInstalling((prev) => {
            if (!prev.has(record.id)) return prev;
            const next = new Set(prev);
            next.delete(record.id);
            return next;
          });
        });
    },
    []
  );

  /**
   * What an open of a bundle's bytes (lib/openBundle.ts) needs of this
   * component: the tabs, what is on screen, the error card, the "Opening…"
   * cover, Home's list and the offline install. Setters and refs are stable,
   * so this is made once.
   */
  const bundleHost = useMemo<OpenBundleHost>(
    () => ({
      tabs: () => openTabsRef.current,
      activeTabId: () => activeTabIdRef.current,
      setOpenTabs,
      setActiveTabId,
      setError,
      showOpening: (tabId, appName) => {
        setLoadingTabId(tabId);
        setLoadingFileName(appName);
      },
      hideOpening: (tabId) => setLoadingTabId((current) => (current === tabId ? null : current)),
      appsChanged: setApps,
      installOffline: beginOfflineInstall,
    }),
    [beginOfflineInstall]
  );

  /** Open a bundle's bytes as a tab. Resolves with the app's name, or null if it did not open. */
  const processBundleData = useCallback(
    (request: OpenBundleRequest): Promise<string | null> => openBundle(bundleHost, request),
    [bundleHost]
  );
  /** Handle file from picker or drag-drop */
  const handleOpenFile = useCallback(
    (data: Uint8Array, fileName: string) => {
      void processBundleData({ data, fileName, isForeground: claimNavigation() });
    },
    [processBundleData, claimNavigation]
  );

  /**
   * Open a bundle served from this site — the `?open=` entry point, and what a
   * demo card on the launcher clicks.
   */
  const openFromUrl = useCallback(
    (value: string, isForeground: () => boolean = () => true, initialPage?: string): Promise<string | null> => {
      // A bundle handed over by Builder or Studio on this origin, staged in
      // IndexedDB rather than fetched. Taking it removes it; a reload finds
      // nothing and says so, rather than reopening a bundle the editor has
      // since changed.
      if (value.startsWith('handoff')) {
        // The id rides in the value as `handoff:<id>`, put there by readEntry
        // before the address bar is rewritten; the record it names was staged
        // for the runtime and no other page, and is claimed exactly once.
        const id = value.includes(':') ? value.slice(value.indexOf(':') + 1) : null;
        return takeBundleHandoff(id, 'runtime').then((result) => {
          if (!result.ok) {
            if (isForeground()) {
              setError(new Error(describeHandoffFailure(result.reason, 'runtime')));
              setActiveTabId(null);
            }
            return null;
          }
          return processBundleData({ data: result.handoff.bytes, fileName: `${result.handoff.name || 'app'}.softn`, initialPage, isForeground });
        }).catch((err: unknown) => {
          // The hand-off read itself can fail (IndexedDB refused, the store
          // gone); it used to reject unobserved, and the launcher waited on a
          // load that would never report. It is the error card now, like a
          // bundle that will not open.
          if (isForeground()) {
            setError(err instanceof Error ? err : new Error(String(err)));
            setActiveTabId(null);
          }
          return null;
        });
      }

      let url: URL;
      try {
        url = resolveBundleUrl(value, window.location.origin);
      } catch (err) {
        // Nothing has been fetched and no tab exists yet, so a rejected value is
        // only ever the error card.
        if (isForeground()) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setActiveTabId(null);
        }
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
        if (isForeground()) setActiveTabId(loadedTab.id);
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
        const skeletonTabId = randomUUID();
        if (isForeground()) setError(null);
        setOpenTabs((prev) => [...prev, { id: skeletonTabId, name: displayName, source: '' }]);
        if (isForeground()) setActiveTabId(skeletonTabId);

        // The placeholder is the download's lease. Closing the tab aborts it —
        // a large bundle used to keep downloading after its tab was gone, and
        // then open anyway, so the app the user had just dismissed appeared in
        // a new tab a few seconds later.
        const controller = new AbortController();
        loadAbortsRef.current.set(skeletonTabId, controller);

        let data: Uint8Array;
        try {
          // Named for the loading screen's progress only when this tab is the
          // one on screen: a tab restored in the background is not.
          data = await fetchRemoteBundle(url, controller.signal, isForeground() ? displayName : undefined);
        } catch (err) {
          // An abort is the user closing the tab, not a failure to report.
          if (controller.signal.aborted) return null;
          console.error('[SoftN Web] Failed to fetch bundle:', err);
          if (isForeground()) setError(err instanceof Error ? err : new Error(String(err)));
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
          opened = await processBundleData({
            data,
            fileName: `${displayName}.softn`,
            initialPage,
            directorySlug,
            placeholderId: skeletonTabId,
            isForeground,
          });
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
          if (isForeground()) setError(err instanceof Error ? err : new Error(String(err)));
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

  /**
   * One line on Home: something that went right, or something to do first.
   * The error card is for what went wrong, and it takes Home's place, so a
   * line here is what a request Home can answer itself gets.
   */
  const [notice, setNotice] = useState<HomeNotice | null>(null);

  // Home keeps apps mounted. Restoring/deleting their storage while they are
  // running would leave stale in-memory records that can overwrite the change,
  // so the app is stopped first. Said on Home, beside the section it names,
  // with the way to stop it: this used to replace Home with an error card that
  // sent people looking for a "Running apps" section called "Running now".
  // Stopping and removing in one press is not offered: the stopped app's own
  // teardown can still be writing the records the removal deletes.
  const canChangeAppData = useCallback((app: CachedApp): boolean => {
    const running = findCachedAppTab(openTabsRef.current, app);
    if (!running) return true;
    setNotice({
      text: `“${app.name}” is still running. Stop it under Running now, then try again; its saved data is changed or removed only once it has stopped.`,
      warning: true,
      stop: { tabId: running.id, label: `Stop “${app.name}”` },
    });
    setActiveTabId(null);
    return false;
  }, []);

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
      if (!canChangeAppData(to)) return;
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
      debug(
        `[SoftN Web] Copied ${result.copied} of ${result.total} stored keys from "${from.name}" v${from.version} to v${to.version}${result.skipped ? ` (${result.skipped} already there)` : ''}.`
      );
      handleOpenCached(to);
    },
    // handleOpenCached is defined below; referenced lazily inside the callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canChangeAppData]
  );

  /** Handle opening a cached app */
  const handleOpenCached = useCallback(
    (app: CachedApp) => {
      // A tab is found below only once its load has finished, so a second
      // press while the first is loading (a double click, Enter held down)
      // opened the app again: two copies over one database. The first load
      // stands. The press is still the person's latest navigation, so the
      // load it joins takes it: Alpha, Beta, then Alpha again used to leave
      // Beta in front, because the second press on Alpha claimed nothing.
      const opening = openingCachedRef.current.get(app.id);
      if (opening) {
        opening.isForeground = claimNavigation();
        return;
      }
      const isForeground = claimNavigation();
      // By identity, not by label. Two cached apps can legitimately share a
      // name — that is precisely what content-addressed identity allows, and
      // the launcher lists both — so matching on name meant clicking the second
      // card just re-focused the first one's tab. The user pressed a card for
      // one app and was shown a different app, with nothing to say so. Name is
      // kept only as a fallback for records cached before origins existed.
      const existingTab = findCachedAppTab(openTabsRef.current, app);
      if (existingTab) {
        setActiveTabId(existingTab.id);
        return;
      }
      const load = { isForeground };
      openingCachedRef.current.set(app.id, load);
      void processBundleData({
        data: app.bundleData,
        fileName: `${app.name}.softn`,
        cachedAppId: app.id,
        directorySlug: app.directorySlug,
        isForeground: () => load.isForeground(),
      }).finally(() => openingCachedRef.current.delete(app.id));
    },
    [processBundleData, claimNavigation]
  );

  /**
   * A build's records as a file. What is written is exactly what the build
   * has stored, named for it, so it can be kept, moved to another browser or
   * put back after an update turns out wrong.
   */
  const handleExportData = useCallback((app: CachedApp) => {
    const snapshot = exportAppData(app);
    if (!snapshot) {
      setError(new Error('This build has no identity to export data for.'));
      setActiveTabId(null);
      return;
    }
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${app.name.replace(/[\\/:*?"<>|]+/g, '-')}-v${app.version}-data.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    const n = snapshotEntryCount(snapshot);
    setNotice({ text: `Exported ${n} stored ${n === 1 ? 'record' : 'records'} of "${app.name}" v${app.version}.` });
  }, []);

  /**
   * Records from a file, into a build. The file is checked before anything
   * is touched, a file from a different build is confirmed first, and an
   * import that fails part way leaves the build's data exactly as it was.
   * There is no path here by which a bad file becomes an empty app.
   */
  const handleImportData = useCallback(async (app: CachedApp, file: File) => {
    if (!canChangeAppData(app)) return;
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      setError(new Error(`Nothing was imported: the file could not be read. ${err instanceof Error ? err.message : String(err)}`));
      setActiveTabId(null);
      return;
    }
    const read = readAppDataSnapshot(text);
    if (!read.ok) {
      setError(new Error(`Nothing was imported and "${app.name}" v${app.version} is as it was. ${read.error}`));
      setActiveTabId(null);
      return;
    }
    // Reading a file can take time; the app may have opened in the meantime.
    if (!canChangeAppData(app)) return;
    const n = snapshotEntryCount(read.snapshot);
    let allowDifferentApp = false;
    if (read.snapshot.app.origin !== app.origin) {
      allowDifferentApp = window.confirm(
        `This file was exported from "${read.snapshot.app.name}" v${read.snapshot.app.version}, which is a different build from "${app.name}" v${app.version}. ` +
          `Import its ${n} ${n === 1 ? 'record' : 'records'} anyway? The data v${app.version} has now will be replaced.`
      );
      if (!allowDifferentApp) return;
    } else if (hasStoredData(app.origin)) {
      const replace = window.confirm(`Replace the data "${app.name}" v${app.version} has now with the ${n} ${n === 1 ? 'record' : 'records'} in ${file.name}?`);
      if (!replace) return;
    }
    const result = importAppData(read.snapshot, app, { allowDifferentApp });
    if (!result.ok) {
      setError(new Error(`Nothing was imported and "${app.name}" v${app.version} is as it was. ${result.error ?? ''}`));
      setActiveTabId(null);
      return;
    }
    setNotice({ text: `Imported ${result.copied} stored ${result.copied === 1 ? 'record' : 'records'} into "${app.name}" v${app.version} from ${file.name}.` });
    setApps(await getCachedApps());
  }, [canChangeAppData]);

  /** Handle removing a cached app */
  const handleRemove = useCallback(async (id: string) => {
    // Take the build's saved records with it. Leaving them behind meant every
    // removal orphaned data that nothing could reach or clear again.
    const going = await getCachedApp(id);
    if (!going || !canChangeAppData(going)) return;
    if (!window.confirm(`Remove “${going.name}” v${going.version} and its saved data from this browser? Export its data first if you want to keep a backup.`)) return;
    const dropped = removeAppData(going?.origin);
    await removeCachedApp(id);
    if (dropped > 0) {
      debug(`[SoftN Web] Removed "${going?.name}" v${going?.version} and its ${dropped} saved keys.`);
    }
    const updatedApps = await getCachedApps();
    setApps(updatedApps);
  }, [canChangeAppData]);

  /**
   * Hand the running app's bundle back as a file. What is downloaded is the
   * exact bytes that were opened — the cache keeps them — so what someone
   * takes away is what they were running, not a re-export of it.
   */
  const handleDownloadTab = useCallback(async (tabId: string) => {
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (!tab || !tab.appId) return;
    try {
      const bytes = tab.bundleData ?? (await getCachedAppByOrigin(tab.appId))?.bundleData;
      if (!bytes) throw new Error('The bundle is no longer available. Open the original file and try again.');
      const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(tab.directorySlug || tab.name).replace(/[\\/:*?"<>|]+/g, '-')}.softn`;
      document.body.appendChild(a);
      try { a.click(); } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000); }
    } catch (err) {
      setError(new Error(`Could not download the bundle: ${err instanceof Error ? err.message : String(err)}`));
    }
  }, []);

  /** Close a tab */
  const handleCloseTab = useCallback(
    (tabId: string, andGoHome = false) => {
      if (activeTabIdRef.current === tabId) claimNavigation();
      // Clean up page tracking
      delete tabPagesRef.current[tabId];

      // Stop a download this tab was waiting on. Without it the bytes kept
      // coming for a tab that no longer existed, and the app opened anyway.
      const pending = loadAbortsRef.current.get(tabId);
      if (pending) {
        pending.abort();
        loadAbortsRef.current.delete(tabId);
      }

      // An offline install this tab's open started stops with it. The next
      // open of the app starts its own, from whatever the cache holds by then.
      const installingFor = installAbortsRef.current.get(tabId);
      if (installingFor) {
        installingFor.abort();
        installAbortsRef.current.delete(tabId);
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
    [claimNavigation]
  );

  /** Select a tab */
  const handleSelectTab = useCallback((id: string | null) => {
    claimNavigation();
    setActiveTabId(id);
    setError(null);
  }, [claimNavigation]);

  /** File input change handler */
  const openLocalFile = useLocalBundleFile(handleOpenFile, setError);
  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await openLocalFile(file);
      } finally {
        // Always reset so same file can be re-selected
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [openLocalFile]
  );

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
   *
   * An iframe's `load` event only says the runtime shell arrived; parsing the
   * bundle and starting the engine takes another moment, and a page that
   * announces "running" during that gap is lying to its reader. There is
   * nothing sensitive in the message, so it is not worth narrowing the target
   * origin to a list the runtime would then have to maintain.
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
    const isForeground = claimNavigation();

    if (urlInit.openValue) {
      // ?open= is a one-shot instruction: once it has been acted on the URL
      // becomes the ordinary /app/<name> form, so a reload replays the bundle
      // out of the cache instead of downloading it a second time — and a value
      // that was rejected does not sit in the address bar reproducing the same
      // error on every refresh.
      // Canonicalize from committed selection state, not this older request's
      // result: the user may have returned Home or selected another tab by now.
      // Whatever the open does, the URL becomes one a reload can act on: a
      // rejection here used to leave `urlReady` unset for the session.
      openFromUrl(urlInit.openValue, isForeground)
        .catch((err: unknown) => {
          if (isForeground()) setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => setUrlReady(true));
      return;
    }

    if (urlInit.appName) {
      // Local imports reopen from their cached bytes. Directory apps still
      // refresh from the API, with the existing offline cache fallback.
      // Development checkouts can also resolve their bundled demo catalogue.
      if (urlTabId) discardPlaceholder(urlTabId);
      const wanted = urlInit.appName;
      const fromApi = (cached?: CachedApp | null): Promise<string | null> =>
        openFromUrl(`/api/apps/${encodeURIComponent(cached?.directorySlug || wanted)}/bundle.softn`, isForeground, urlInit.page || undefined);
      const fromCatalogue = async (): Promise<string | null> => {
        const demoUrl = await demoBundleUrlFor(wanted);
        return demoUrl ? openFromUrl(demoUrl, isForeground, urlInit.page || undefined) : null;
      };
      // A saved directory slug is authoritative. Display names can change,
      // contain spaces or collide with a bundled development example.
      const fromRemote = (cached?: CachedApp | null) => cached?.directorySlug || !import.meta.env.DEV
        ? fromApi(cached)
        : fromCatalogue().then((opened) => opened ?? fromApi());
      const attempt = reopenBundle(
        () => getCachedAppByName(wanted),
        (cached) =>
          processBundleData({
            data: cached.bundleData,
            fileName: `${cached.name}.softn`,
            cachedAppId: cached.id,
            initialPage: urlInit.page || undefined,
            isForeground,
          }),
        fromRemote,
      );
      attempt
        .then(async (appName) => {
          if (!appName) {
            // If server fetch failed (e.g. offline), fall back to cached version
            const cachedApp = await getCachedAppByName(urlInit.appName!);
            if (cachedApp) {
              await processBundleData({
                data: cachedApp.bundleData,
                fileName: `${cachedApp.name}.softn`,
                cachedAppId: cachedApp.id,
                initialPage: urlInit.page || undefined,
                directorySlug: cachedApp.directorySlug,
                isForeground,
              });
            }
          }
        })
        .catch((err: unknown) => {
          if (isForeground()) setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => setUrlReady(true));
    } else {
      setUrlReady(true);
    }
  }, [processBundleData, openFromUrl, entryUrl, urlInit, urlTabId, discardPlaceholder, claimNavigation]);

  // ── URL Routing: Sync activeTabId → URL ──────────────────────

  useEffect(() => {
    if (!urlReady) return;
    if (skipNextUrlPushRef.current && !replaceNextUrlRef.current) {
      skipNextUrlPushRef.current = false;
      return;
    }

    let url = buildAppUrl(null);
    if (activeTabId) {
      const tab = openTabs.find((t) => t.id === activeTabId);
      if (tab) {
        const page = tabPagesRef.current[activeTabId] ?? tab.initialPage;
        url = buildAppUrl(tab.name, page);
      }
    }

    const next = entryUrl(url);
    if (currentUrl() !== next) {
      if (replaceNextUrlRef.current) window.history.replaceState({}, '', next);
      else window.history.pushState({}, '', next);
    }
    replaceNextUrlRef.current = false;
    skipNextUrlPushRef.current = false;
  }, [activeTabId, openTabs, entryUrl, urlReady]);

  // ── URL Routing: Browser back/forward ────────────────────────

  useEffect(() => {
    const handlePopState = () => {
      claimNavigation();
      const { appName } = parseAppUrl();

      // The address carries a name; the tab being looked at wins a tie. An
      // app that is not open as a tab is Home.
      const tab = appName ? findTabForUrlName(openTabsRef.current, appName, activeTabIdRef.current) : undefined;
      const next = tab ? tab.id : null;

      // The address is already the browser's: the sync above is told not to
      // write it. Only when the selection changes, because only then does the
      // sync run: Back to a closed app while Home was showing left the flag
      // set, and the next app opened ran under the closed one's address.
      if (next === activeTabIdRef.current) return;
      skipNextUrlPushRef.current = true;
      setActiveTabId(next);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [claimNavigation]);

  // Refresh cached apps when returning to Home
  useEffect(() => {
    if (activeTabId === null) {
      getCachedApps().then(setApps).catch(console.error);
    }
  }, [activeTabId]);

  // Keep keyboard focus somewhere real across Home and the running apps.
  //
  // Home and every tab stay mounted and are switched with display:none, and
  // the frame bar and its corner tab replace each other. So whatever was
  // pressed to get here — a card on Home, Home in the frame bar, Hide bar —
  // is hidden or gone by the next frame, and focus fell to <body>: a keyboard
  // user was at the top of the document, behind the app they had just opened.
  // Focus is moved only when it has been lost that way, never taken from
  // somewhere the person put it, and never on the first render.
  const failed = Boolean(error);
  const lastViewRef = useRef<{ tab: string | null; hidden: boolean; failed: boolean } | null>(null);
  useEffect(() => {
    const previous = lastViewRef.current;
    lastViewRef.current = { tab: activeTabId, hidden: chromeHidden, failed };
    if (!previous || (previous.tab === activeTabId && previous.hidden === chromeHidden && previous.failed === failed)) return;
    // The error card takes focus itself; its going away (Back to home, with
    // Home already selected) is a change of view like any other.
    if (failed) return;
    const focused = document.activeElement;
    const lost =
      !focused ||
      focused === document.body ||
      !focused.isConnected ||
      (focused instanceof HTMLElement && focused.getClientRects().length === 0);
    if (!lost) return;
    const shell = shellRef.current;
    if (!shell) return;
    let target: HTMLElement | null = null;
    if (activeTabId === null) {
      target = shell.querySelector<HTMLElement>('.softn-launcher-title');
      // Home kept the scroll it had when an app was opened over it, and the
      // heading focused with preventScroll was then above the fold: focus
      // somewhere the person cannot see. Home opens at its top instead.
      if (homeRef.current) homeRef.current.scrollTop = 0;
    } else if (previous.tab === activeTabId && previous.hidden !== chromeHidden && previous.failed === failed) {
      // The bar was folded or brought back: to whichever replaced it.
      target = chromeHidden
        ? shell.querySelector<HTMLElement>('.softn-chrome-peek')
        : shell.querySelector<HTMLElement>('.softn-frame-bar .softn-frame-btn');
    } else {
      target = Array.from(shell.querySelectorAll<HTMLElement>('[data-softn-tab]')).find((el) => el.dataset.softnTab === activeTabId) ?? null;
    }
    target?.focus({ preventScroll: true });
  }, [activeTabId, chromeHidden, failed]);

  const isHome = activeTabId === null;
  const activeTab = isHome ? null : openTabs.find((t) => t.id === activeTabId) ?? null;

  /**
   * A skip link's press: focus where it points, made focusable for the
   * purpose if it is a heading, and scrolled into view. The address is left
   * alone; a fragment there would be read as a route.
   */
  const skipTo = (selector: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const target = shellRef.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
  };

  return (
    <DropZone onFile={openLocalFile} onError={setError}>
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
        {/* Before the product bar, so the first Tab offers them: reaching the
            first "Run" in Explore apps took 25 presses, through the bar and
            every card of the library. */}
        {!embedded && isHome && !loadingTabId && !error && (
          <div className="softn-skip-links">
            <a className="softn-skip-link" href="#softn-workspace" onClick={skipTo('#softn-workspace')}>
              Skip to your workspace
            </a>
            <a className="softn-skip-link" href="#softn-explore-title" onClick={skipTo('#softn-explore-title')}>
              Skip to Explore apps
            </a>
          </div>
        )}
        {!embedded && isHome && <ProductBar current="runtime" />}
        {!embedded && !isHome && activeTab && chromeHidden && (
          <button
            type="button"
            className="softn-chrome-peek"
            onClick={() => setChromeHidden(false)}
            title="Show the bar"
            aria-label={`${activeTab.name}: show the bar`}
          >
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
            closeTitle={backTo ? 'Stop the app and return to the page that opened it' : undefined}
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
            <ThemeProvider followHost followSystem>
              <div
                className="softn-shell-loading"
                role="status"
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
                <Text style={{ color: 'var(--dim)', fontSize: '0.875rem', letterSpacing: '-0.01em' }}>Opening {loadingFileName}…</Text>
              </div>
            </ThemeProvider>
          )}

          {/* Error state: what went wrong, and what to do about it. */}
          {error && !loadingTabId && (
            <ErrorCard
              error={error}
              onHome={() => {
                claimNavigation();
                setError(null);
                setActiveTabId(null);
              }}
              onOpenFile={() => fileInputRef.current?.click()}
            />
          )}

          {/* Home / Launcher */}
          <div
            ref={homeRef}
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'auto',
              display: isHome && !loadingTabId && !error ? 'block' : 'none',
            }}
          >
            {notice && (
              <div className={`softn-shell-notice${notice.warning ? ' softn-shell-notice--warning' : ''}`} role="status">
                <span className="softn-shell-notice-text">{notice.text}</span>
                {notice.stop && (
                  <button
                    type="button"
                    className="softn-shell-notice-action"
                    onClick={() => {
                      const stop = notice.stop!;
                      setNotice(null);
                      handleCloseTab(stop.tabId, true);
                    }}
                  >
                    {notice.stop.label}
                  </button>
                )}
                <button type="button" className="softn-shell-notice-dismiss" onClick={() => setNotice(null)} aria-label="Dismiss">
                  &times;
                </button>
              </div>
            )}
            <Launcher
              apps={apps}
              installing={installing}
              running={openTabs.map((t) => ({ id: t.id, name: displayNameFor(t, openTabs), icon: t.icon }))}
              onResume={(id) => handleSelectTab(id)}
              onStop={(id) => handleCloseTab(id, true)}
              onOpenFile={openLocalFile}
              onOpenCached={handleOpenCached}
              onOpenUrl={(url) => { void openFromUrl(url, claimNavigation()); }}
              onRemove={handleRemove}
              onAdoptData={handleAdoptData}
              onExportData={handleExportData}
              onImportData={(app, file) => void handleImportData(app, file)}
            />
          </div>

          {/* All open app tabs — stay mounted, toggled via display */}
          {openTabs.map((tab) => (
            <AppRunner
              key={tab.id}
              tabId={tab.id}
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
              python={tab.python}
              executionPreference={tab.execution}
              themeMode={tab.themeMode}
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
