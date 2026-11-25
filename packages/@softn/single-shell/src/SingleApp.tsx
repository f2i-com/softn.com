import React, { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { inspectDeclaration } from '@softn/bundle-format/capabilities';
import type {
  ComposedBundleSource,
  PermissionConfig,
  PythonProject,
} from '@softn/core';
// The consent rule, bar and dialog the web runtime and the desktop loader
// use too, so a bundle is asked in the same words on a single-app page.
import { hasSavedGrant, saveGrant, withheldPermissions } from '@softn/runtime-shell/consent';
import { PermissionBar } from '@softn/runtime-shell/PermissionBar';
import { describeFailure } from '@softn/runtime-shell/failure';
import { LoadProgress } from '@softn/runtime-shell/LoadProgress';
import type { AssetResolver } from '@softn/runtime-shell/bundleProcessor';
import { loadApplication, type ConfigSource } from './load';
import { watchForStall } from './stall';
import type { DirectoryConfig, SingleConfig } from './config';
import { installFavicon } from './favicon';
import { loadHost, type HostBackendCall } from './host';
import { getLoadedUiSurface, preloadUiSurface, type LoadedUiSurface } from './uiSurfaceLoader';
// The slim bar the runtime draws over every app, for the pages a directory
// serves through this shell; drawn from the shared tokens, which come along.
import { FrameBar } from '@softn/runtime-shell/FrameBar';
import { WebContainerView } from '@softn/runtime-shell/WebContainerView';
import type { ContainerPageMeta, SoftNContainerHandle } from '@softn/container';
import {
  apply as applySiteTheme,
  readChoice as readThemeChoice,
  resolve as resolveSiteTheme,
  subscribeTheme,
} from '@softn/brand';
import '@softn/brand/tokens.css';
/**
 * What `Application` needs of a loaded app: the slice of `LoadedApplication`
 * it reads, so a host that produces its app some other way — the PHP-served
 * runtime in apps/softn-single-private fetches entries instead of an
 * archive — can render the same shell without pretending to have an archive.
 * Both hosts build it through `assembleApplication` (assemble.ts).
 */
export interface RunnableApplication {
  config: {
    /** The deployment's id; on a directory's play page, the app's slug there. */
    id?: string;
    title: string;
    theme: 'light' | 'dark';
    loadingText: string;
    permissionMode?: 'prompt' | 'preapproved';
    /** Set when a directory served the shell: where the run is counted and the app's storage lives. */
    directory?: DirectoryConfig;
    /** Optional same-origin URL of a remote ZIPP-sandboxed multi-user backend (`softn-server`). */
    backendUrl?: string;
    /** URL prefix for multi-page hosted routes (e.g. `"/play/harborline-studio"`). */
    basePath?: string;
    /** Initial virtual route inside the app (e.g. `"/"`, `"/about.html"`). */
    initialPath?: string;
  };
  /** The bundle's icon as a data URL, when it has one the shell accepted. */
  icon?: string;
  declared: PermissionConfig;
  grantKey: string;
  appId: string;
  textFiles: Map<string, string>;
  execution: 'worker' | 'main';
  /**
   * The bundle's own `config.theme.mode`: the side its project declares.
   * `config.theme` above is the deployment's, and is what a project that
   * declares no side is drawn in.
   */
  themeMode?: unknown;
  source: string;
  logicBasePath?: string;
  preIncludedLogicPaths: string[];
  /** The app's Python project, when its logic is Python. */
  python?: PythonProject;
  /** Where its page does not parse, from the composer. */
  parseProblem?: string;
  assets: AssetResolver;
  /**
   * Whether a link to another page of the bundle shows that page in the app
   * (the default). A page of a site run in page mode leaves its links to the
   * browser: each page of the site starts the app itself, at its own address.
   */
  followsLinks?: boolean;
  /** True when the bundle runs inside `@softn/container` (`<softn-app>`). */
  webContainer?: boolean;
  /** Raw `.softn` archive bytes when loaded from an archive. */
  bundleData?: Uint8Array;
  /** Pre-verified SHA-256 hex digest of `bundleData` (avoids redundant hashing in container). */
  bundleDigest?: string;
  /**
   * A web container's files, every one of them, for a host with no archive to hand over (the
   * PHP host serves an app's files one by one). Without the archive or this, the container
   * is mounted from the text files alone and the app's images, fonts and wasm are missing.
   */
  containerFiles?: Record<string, string | Uint8Array>;
  /** Background first-screen ZIP warmup handle, aborted on unmount or reload. */
  warmup?: { abort(): void };
}
export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="loading">
      <span className="wheel" aria-hidden="true" />
      <span role="status" aria-live="polite">{text}</span>
      {/* What is downloading, once the wait has gone on: the bundle, the
          engine, the components the first screen draws. */}
      <LoadProgress />
    </div>
  );
}
/**
 * What a visitor sees when the app cannot open. The sentence stays plain, but
 * the runtime's own reason is kept: logged to the console and shown behind a
 * details toggle. Every failure used to become the same sentence with nothing
 * in the console, so "uses the Python package torch, and the engine this page
 * loaded does not provide it" or a host module that failed to load could only
 * be found by attaching a debugger to the page.
 */
export function Failure({ error }: { error?: unknown }) {
  // The reason as the web runtime's error card reads it (runtime-shell's
  // describeFailure): the thrower's own words, or none.
  const reason = describeFailure(error).detail;
  return (
    <div className="loading" role="alert">
      <h1>Unable to open this application</h1>
      <p>Please try again. If the problem continues, contact the site owner.</p>
      {reason && (
        <details>
          <summary>Technical details</summary>
          <p>{reason}</p>
        </details>
      )}
      <button onClick={() => location.reload()}>Try again</button>
    </div>
  );
}
/** Record a failure where a site owner will look for it, once. */
function reportFailure(error: unknown): void {
  console.error('[SoftN] The application could not open:', error);
}
class Boundary extends Component<{ children: React.ReactNode }, { error: unknown; failed: boolean }> {
  state: { error: unknown; failed: boolean } = { error: undefined, failed: false };
  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }
  componentDidCatch(error: unknown) {
    reportFailure(error);
  }
  render() {
    return this.state.failed ? <Failure error={this.state.error} /> : this.props.children;
  }
}
/** The name of the one box an app is drawn in on this page: `.application-content`. */
const THEME_BOX = 'application';
/** The bar over a directory's play page folds away; remembered per browser, as the runtime remembers its own. */
const CHROME_KEY = 'softn.play.chromeHidden';
function savedChromeHidden() {
  try {
    return localStorage.getItem(CHROME_KEY) === '1';
  } catch {
    return false;
  }
}
/**
 * Tell the directory the app is up, once. Best effort and not awaited: a
 * directory that is down is not a reason the app is not running. The count
 * is made here, on readiness, so that it means "ran" and not "was fetched".
 */
function countRun(url: string) {
  void fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'open' }),
    keepalive: true,
  }).catch(() => {});
}
/** Map a container virtual URL (`'/'`, `'/index.html'`, `'/about.html'`) under `basePath` (`'/play/<slug>'`). */
function buildBrowserRouteUrl(basePath: string, virtualUrlPath: string): string | null {
  try {
    const parsed = new URL(virtualUrlPath || '/', 'https://app.softn.local/');
    if (parsed.origin !== 'https://app.softn.local') return null;
    const cleanBase = basePath.length > 1 ? basePath.replace(/\/+$/, '') : '';
    let pathname = parsed.pathname;
    if (pathname === '/' || /^\/index\.html?$/i.test(pathname)) {
      pathname = '';
    } else if (/^\/.+\/index\.html?$/i.test(pathname)) {
      pathname = pathname.replace(/index\.html?$/i, '');
    }
    const pathOut = `${cleanBase}${pathname}` || '/';
    let search = parsed.search;
    if (!search && typeof window !== 'undefined' && window.location.search) {
      const outer = new URLSearchParams(window.location.search);
      if (outer.get('mode') === 'local') search = '?mode=local';
    }
    return `${pathOut}${search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/** Extract the container virtual URL path from the current browser location relative to `basePath`. */
function parseVirtualPathFromBrowser(basePath: string): string | null {
  if (typeof window === 'undefined') return null;
  const cleanBase = basePath.length > 1 ? basePath.replace(/\/+$/, '') : '';
  const { pathname, search, hash } = window.location;
  let rel: string | null = null;
  if (cleanBase === '') {
    rel = pathname || '/';
  } else if (pathname === cleanBase || pathname === `${cleanBase}/`) {
    rel = '/';
  } else if (pathname.startsWith(`${cleanBase}/`)) {
    rel = pathname.slice(cleanBase.length);
  }
  if (rel === null) return null;
  let guestSearch = search;
  if (guestSearch) {
    const params = new URLSearchParams(guestSearch);
    if (params.get('mode') === 'local' && [...params.keys()].length === 1) {
      guestSearch = '';
    }
  }
  return `${rel}${guestSearch}${hash}`;
}

function normalizeRouteCompare(path: string): string {
  try {
    const u = new URL(path || '/', 'https://app.softn.local/');
    let p = u.pathname;
    if (/^\/index\.html?$/i.test(p)) p = '/';
    else if (/^\/.+\/index\.html?$/i.test(p)) p = p.replace(/index\.html?$/i, '');
    return `${p}${u.search}${u.hash}`;
  } catch {
    return path;
  }
}

function setMetaContent(attr: 'name' | 'property', key: string, value: string): void {
  if (typeof document === 'undefined' || !document.head) return;
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = value;
}

/** Sync `<head>` canonical, OG, Twitter, description, robots, and `lang` on client-side route transitions. */
function syncHostedHeadRoute(targetUrl: string, virtualPath: string, robots?: string): void {
  if (typeof document === 'undefined' || !document.head) return;
  const canonicalOrigin = (() => {
    const existing = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute('href');
    if (existing) {
      try {
        const origin = new URL(existing).origin;
        document.documentElement.dataset.softnCanonicalOrigin = origin;
        return origin;
      } catch {
        /* ignore */
      }
    }
    return document.documentElement.dataset.softnCanonicalOrigin || window.location.origin;
  })();
  const cleanUrl = `${canonicalOrigin}${targetUrl.split(/[?#]/)[0]}`;
  const isNoindex = typeof robots === 'string' && /(?:^|,)(?:noindex|none)(?:,|$)/i.test(robots);

  if (virtualPath === '/' || /^\/index\.html?$/i.test(virtualPath)) {
    document.head.querySelector('meta[name="softn:page"]')?.remove();
  } else {
    setMetaContent('name', 'softn:page', virtualPath.split(/[?#]/)[0]);
  }
  if (isNoindex) {
    document.head.querySelector('link[rel="canonical"]')?.remove();
    document.head.querySelector('meta[property="og:url"]')?.remove();
  } else {
    let canon = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canon) {
      canon = document.createElement('link');
      canon.rel = 'canonical';
      document.head.appendChild(canon);
    }
    canon.href = cleanUrl;
    setMetaContent('property', 'og:url', cleanUrl);
  }
  const ogType = document.head.querySelector<HTMLMetaElement>('meta[property="og:type"]');
  if (ogType) ogType.content = virtualPath === '/' ? 'website' : 'article';
}

function syncHostedPageMeta(meta: ContainerPageMeta, fallbackTitle: string): void {
  if (typeof document === 'undefined' || !document.head) return;
  const title = meta.title?.trim() || fallbackTitle;
  if (title) {
    document.title = title;
    setMetaContent('property', 'og:title', title);
    setMetaContent('name', 'twitter:title', title);
  }
  if (meta.description) {
    setMetaContent('name', 'description', meta.description);
    setMetaContent('property', 'og:description', meta.description);
    setMetaContent('name', 'twitter:description', meta.description);
  }
  setMetaContent('name', 'robots', meta.robots || 'index,follow,max-image-preview:large');
  if (meta.lang) {
    document.documentElement.lang = meta.lang;
  }
}

export type { HostBackendCall } from './host';
export function Application({ app, backendCall }: { app: RunnableApplication; backendCall?: HostBackendCall }) {
  const requested = inspectDeclaration(app.declared).requested;
  // Preapproved by the operator: granted from the start, with no bar and
  // nothing written to storage — the host's setting, not a consent.
  // "Not now" is the bar's own state (it folds to a strip with Review
  // permissions), so the shell only knows whether access was granted.
  const [answer, setAnswer] = useState<'pending' | 'allow'>(() =>
    app.config.permissionMode === 'preapproved' || !requested.length || hasSavedGrant(app.grantKey) ? 'allow' : 'pending'
  );
  const granted = answer === 'allow';
  // Whether the bar is up to be answered, or put away with "Not now": while
  // it is up, what the app asks for is kept for the answer, and done when the
  // person allows it (runtime-shell's withheldPermissions).
  const [asking, setAsking] = useState(true);
  const permissions = useMemo(
    () => (granted ? app.declared : withheldPermissions(app.declared, { asking })),
    [granted, asking, app]
  );
  // What the app is waiting on the bar for, and whether allowing starts it
  // again, as its renderer says: the bar says both before it is answered.
  const [consentStatus, setConsentStatus] = useState<{ waiting: string[]; restartOnAllow: boolean }>({ waiting: [], restartOnAllow: false });
  const functions = useMemo(
    () => ({ asset: (value: unknown) => app.assets(String(value ?? '')) }),
    [app]
  );
  // A directory's play page wears the same slim bar the runtime draws over
  // every app — the way back to the directory and to the app's page, the
  // menu, fullscreen, and a fold-away — so an app looks the same wherever it
  // was opened from. A standalone deployment stays unbranded, as documented.
  const slug = app.config.id;
  const framed = Boolean(app.config.directory && slug);
  // Framed, the page is the site's, and its chrome — the frame bar, the
  // permission bar, the corner tab — is drawn in the site's theme, as the web
  // runtime draws it: the reader's choice, else the device's, and following
  // either as it changes (@softn/brand's theme). It stayed dark in light mode.
  // The app is then weighed against that side too (`followHost` below), as in
  // the web runtime, so an app on the other side is drawn in its own box with
  // its own colours rather than inheriting the chrome's.
  // Before the first paint, so a light reader does not see the dark bar first.
  // The page's ground goes with it (style.css, `softn-play-framed`): the
  // boot screen's fixed dark stayed behind an app drawn on the light side.
  useLayoutEffect(() => {
    if (!framed) return;
    applySiteTheme(resolveSiteTheme(readThemeChoice()));
    const root = document.documentElement;
    root.classList.add('softn-play-framed');
    const unsubscribe = subscribeTheme(() => {});
    return () => {
      unsubscribe();
      root.classList.remove('softn-play-framed');
    };
  }, [framed]);
  const [chromeHidden, setChromeHiddenState] = useState(() => framed && savedChromeHidden());
  const setChromeHidden = (hidden: boolean) => {
    try {
      localStorage.setItem(CHROME_KEY, hidden ? '1' : '0');
    } catch {
      /* Remembered for this page only. */
    }
    setChromeHiddenState(hidden);
  };
  const layout = useRef<HTMLDivElement>(null);
  // Everything above the app — the frame bar and the permission bar — is
  // measured together, since the app root is sized under the whole of it.
  const chrome = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(0);
  useEffect(() => {
    if (!chrome.current) {
      setBarHeight(0);
      return;
    }
    const element = chrome.current;
    const measure = () => setBarHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [answer, chromeHidden, framed]);
  const [uiRuntime, setUiRuntime] = useState<LoadedUiSurface | null>(() =>
    app.webContainer ? null : getLoadedUiSurface()
  );
  useEffect(() => {
    if (app.webContainer || uiRuntime) return;
    let active = true;
    void preloadUiSurface().then((loaded) => {
      if (active) setUiRuntime(loaded);
    });
    return () => {
      active = false;
    };
  }, [app.webContainer, uiRuntime]);
  // Made again when access is granted, and not when the bar is put away or
  // brought back: nothing from the network is read either way until then.
  const imports = useMemo(
    () =>
      !app.webContainer && uiRuntime
        ? uiRuntime.createImportResolver(app.textFiles, granted ? app.declared : withheldPermissions(app.declared))
        : null,
    [app, granted, uiRuntime]
  );
  useEffect(() => () => imports?.dispose(), [imports]);
  const counted = useRef(false);
  const runsUrl = app.config.directory?.runs;
  const onLoad = useCallback(() => {
    // Remove the sibling View-Source SSR preview only once the live interactive app is ready,
    // keeping crawlable SSR HTML intact if bundle loading fails in a bot or restricted environment.
    if (typeof document !== 'undefined') {
      document.getElementById('softn-ssr-view')?.remove();
    }
    if (!runsUrl || counted.current) return;
    // Once per load of the page: a permission grant re-renders the
    // runtime in place, and that is the same run.
    counted.current = true;
    countRun(runsUrl);
  }, [runsUrl]);
  function allow() {
    // A failed write does not undo it: consent still applies for this session.
    saveGrant(app.grantKey);
    setAnswer('allow');
  }
  // Where focus goes back to after Allow; see PermissionBar's appRootRef.
  const content = useRef<HTMLDivElement>(null);

  // Another page of the bundle, shown in place of the main one after a link
  // to it (`<a href="about.html">`): the app composed with that page as its
  // main page, run afresh as a browser runs a page it goes to, with the
  // app's records as they were. The way back is the browser's: each page
  // shown is an entry in its history.
  const main = useMemo(
    () => (!app.webContainer && uiRuntime ? uiRuntime.mainPage(app.textFiles) : null),
    [app, uiRuntime]
  );
  // What a web container is mounted from, the same object for as long as the app is the same:
  // a new one each render (as a host served the app's files without its archive made) started
  // the container again whenever anything here re-rendered, Allow among them, and the app
  // lost what the person had done.
  const containerSource = useMemo(() => (app.webContainer ? (app.bundleData ?? app.containerFiles ?? Object.fromEntries(app.textFiles)) : null), [app]);
  // The same list for the same answer, so the container is told of a grant when it changes.
  const containerGrants = useMemo(() => (granted ? inspectDeclaration(app.declared).requested : []), [granted, app]);
  const routeBasePath = app.config.basePath;
  const containerHandleRef = useRef<SoftNContainerHandle | null>(null);
  const initialRouteSyncedRef = useRef(false);
  const lastRouteRef = useRef<{ targetUrl: string; virtualPath: string } | null>(null);
  const setContainerHandle = useCallback((handle: SoftNContainerHandle | null) => {
    containerHandleRef.current = handle;
    if (!handle) initialRouteSyncedRef.current = false;
  }, []);
  const handleContainerRouteChange = useCallback(
    (urlPath: string, pushHistory: boolean) => {
      if (!routeBasePath || typeof window === 'undefined') return;
      const targetUrl = buildBrowserRouteUrl(routeBasePath, urlPath);
      if (!targetUrl) return;
      lastRouteRef.current = { targetUrl, virtualPath: urlPath };
      const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const isInitialSync = !initialRouteSyncedRef.current;
      initialRouteSyncedRef.current = true;
      if (targetUrl !== currentUrl) {
        const currentPathname = window.location.pathname;
        const targetPathname = targetUrl.split(/[?#]/)[0];
        if (!isInitialSync && pushHistory) {
          history.pushState({ softnRoute: urlPath }, '', targetUrl);
        } else {
          history.replaceState({ softnRoute: urlPath }, '', targetUrl);
        }
        if (targetPathname !== currentPathname && !targetUrl.includes('#')) {
          content.current?.scrollTo?.(0, 0);
          window.scrollTo?.(0, 0);
        }
      }
      if (!isInitialSync) {
        syncHostedHeadRoute(targetUrl, urlPath);
      }
    },
    [routeBasePath]
  );
  const handleContainerPageMetaChange = useCallback(
    (meta: ContainerPageMeta) => {
      if (!routeBasePath) return;
      syncHostedPageMeta(meta, app.config.title);
      if (lastRouteRef.current) {
        syncHostedHeadRoute(lastRouteRef.current.targetUrl, lastRouteRef.current.virtualPath, meta.robots);
      }
    },
    [app.config.title, routeBasePath]
  );
  useEffect(() => {
    if (!app.webContainer || !routeBasePath || typeof window === 'undefined') return;
    const onPopState = () => {
      const handle = containerHandleRef.current;
      if (!handle) return;
      const target = parseVirtualPathFromBrowser(routeBasePath);
      if (!target) return;
      if (normalizeRouteCompare(target) === normalizeRouteCompare(handle.currentPath)) return;
      void handle.navigate(target, { pushHistory: false }).catch((err) => {
        console.warn('[SoftN] Back/Forward navigation failed:', err);
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [app.webContainer, routeBasePath]);
  const [page, setPage] = useState<{ path: string; composed: ComposedBundleSource } | null>(null);
  const show = useCallback(
    (path: string | null): boolean => {
      if (!uiRuntime) return false;
      if (path === null || path === main) {
        setPage(null);
        document.title = app.config.title;
        return true;
      }
      let composed: ComposedBundleSource;
      try {
        composed = uiRuntime.composePage(app.textFiles, path);
      } catch (error) {
        console.warn(`[SoftN] ${path} cannot be shown:`, error instanceof Error ? error.message : error);
        return false;
      }
      setPage({ path, composed });
      document.title = uiRuntime.pageTitle(app.textFiles, path) ?? app.config.title;
      return true;
    },
    [app, main, uiRuntime]
  );
  const initialUiAppliedRef = useRef(false);
  useEffect(() => {
    if (app.webContainer || !uiRuntime || main === null || initialUiAppliedRef.current) return;
    const initPath = app.config.initialPath;
    if (!initPath || initPath === '/') return;
    initialUiAppliedRef.current = true;
    const target = uiRuntime.bundlePageAt(app.textFiles, main, initPath.replace(/^\/+/, ''));
    if (target && target !== main) show(target);
  }, [app, main, show, uiRuntime]);
  const followLink = useCallback(
    (href: string): boolean => {
      if (!uiRuntime || app.followsLinks === false || main === null) return false;
      const from = page?.path ?? main;
      const path = uiRuntime.bundlePageAt(app.textFiles, from, href);
      if (path === null) return false;
      if (path === from) return true;
      if (!show(path)) return false;
      // The entry left is marked as the page it showed, so Back to it is
      // told apart from a fragment link, which leaves no page in history.
      const here = (history.state ?? {}) as Record<string, unknown>;
      if (typeof here.softnPage !== 'string') history.replaceState({ ...here, softnPage: from }, '');
      const nextUrl = routeBasePath
        ? buildBrowserRouteUrl(routeBasePath, path === main ? '/' : `/${path.replace(/^\/+/, '')}`)
        : null;
      if (nextUrl) history.pushState({ softnPage: path }, '', nextUrl);
      else history.pushState({ softnPage: path }, '');
      content.current?.scrollTo?.(0, 0);
      return true;
    },
    [app, main, page, routeBasePath, show, uiRuntime]
  );
  useEffect(() => {
    if (app.webContainer || app.followsLinks === false) return;
    const back = (event: PopStateEvent) => {
      const path = (event.state as { softnPage?: unknown } | null)?.softnPage;
      // A move to a fragment of the page showing says no page: it stays.
      if (typeof path === 'string') {
        show(path);
        return;
      }
      if (routeBasePath && uiRuntime && main !== null) {
        const target = parseVirtualPathFromBrowser(routeBasePath);
        if (target === '/' || target === null) {
          show(main);
        } else {
          const resolved = uiRuntime.bundlePageAt(app.textFiles, main, target.replace(/^\/+/, ''));
          if (resolved) show(resolved);
        }
      }
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [app, main, routeBasePath, show, uiRuntime]);
  const shown = page?.composed ?? app;
  // The page's code set document.title: the window is the app's.
  const showTitle = useCallback((title: string) => {
    document.title = title;
  }, []);
  const body = (
    <div
      ref={layout}
      className={answer === 'pending' ? 'application-layout consenting' : 'application-layout'}
      style={{ '--softn-tab-bar-height': `${barHeight}px` } as React.CSSProperties}
    >
      {framed && chromeHidden && (
        <button
          type="button"
          className="chrome-peek"
          onClick={() => setChromeHidden(false)}
          title="Show the bar"
        >
          {app.config.title}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}
      <div ref={chrome} className="application-chrome">
        {framed && !chromeHidden && (
          <FrameBar
            tab={{ id: slug!, name: app.config.title, icon: app.icon, directorySlug: slug }}
            // The site this directory is: its own host, which is softn.com
            // only on softn.com.
            homeLabel={window.location.host}
            homeTitle="Back to the directory. This leaves the app."
            closeTitle="Stop the app and go back to its page"
            onHome={() => window.location.assign('/apps')}
            onClose={() => window.location.assign(`/app/${encodeURIComponent(slug!)}`)}
            onHide={() => setChromeHidden(true)}
            fullscreenTarget={layout}
            onDownload={() =>
              window.location.assign(`/api/apps/${encodeURIComponent(slug!)}/bundle.softn?download=1`)
            }
          />
        )}
        {answer === 'pending' && (
          <PermissionBar
            className="permission-bar"
            appName={app.config.title}
            appIcon={app.icon}
            config={app.declared}
            capabilities={requested}
            appRootRef={content}
            onAllow={allow}
            onAsking={setAsking}
            waiting={consentStatus.waiting}
            restartOnAllow={consentStatus.restartOnAllow}
          />
        )}
        {/* Nothing here says it is saving, so a record that is not kept is
            the news: a browser that refuses site data, a full budget. In
            this bar, which is measured, and outside the app's reach. */}
        {!app.webContainer && uiRuntime && <uiRuntime.XDBStorageNotice appId={app.appId} problemsOnly />}
      </div>
      {/* What is still arriving once the app is drawn: on a first visit,
          the script engine its taps wait for; later, a page's 3D. */}
      <LoadProgress variant="bar" top="var(--softn-tab-bar-height)" />
      <div className="application-content" ref={content} tabIndex={-1} data-softn-theme-box={THEME_BOX}>
        <Boundary>
          {app.webContainer && containerSource ? (
            <WebContainerView
              source={containerSource}
              precomputedDigest={app.bundleDigest}
              appId={app.appId}
              initialPath={app.config.initialPath}
              backendUrl={app.config.backendUrl}
              declaredPermissions={app.declared}
              grantedCapabilities={containerGrants}
              theme={
                app.themeMode === 'dark' || app.themeMode === 'light'
                  ? app.themeMode
                  : app.config.theme
              }
              onReady={onLoad}
              onTitleChange={showTitle}
              onRouteChange={handleContainerRouteChange}
              onPageMetaChange={handleContainerPageMetaChange}
              onHandle={setContainerHandle}
              loading={<Loading text={app.config.loadingText} />}
              error={(error: Error) => {
                reportFailure(error);
                return <Failure error={error} />;
              }}
            />
          ) : uiRuntime && imports ? (
            <uiRuntime.SoftNWithXDB
              key={page?.path ?? ''}
              source={shown.source}
              onLink={followLink}
              onTitleChange={showTitle}
              backendCall={backendCall}
              appId={app.appId}
              functions={functions}
              importResolver={imports}
              assetResolver={app.assets}
              logicBasePath={shown.logicBasePath}
              preIncludedLogicPaths={shown.preIncludedLogicPaths}
              python={shown.python}
              parseProblem={shown.parseProblem}
              executionPreference={app.execution}
              permissionConfig={permissions}
              onConsentStatus={setConsentStatus}
              storageEndpoint={app.config.directory?.storage}
              onLoad={onLoad}
              loading={<Loading text={app.config.loadingText} />}
              error={(error: Error) => {
                reportFailure(error);
                return <Failure error={error} />;
              }}
            />
          ) : (
            <Loading text={app.config.loadingText} />
          )}
        </Boundary>
      </div>
    </div>
  );
  if (app.webContainer || !uiRuntime) {
    return body;
  }
  return (
    // The project's declared side over the deployment's `theme`, which stays
    // the default; the rule that weighs them is the provider's. The box named
    // here is where a side that is not the deployment's is written, with a
    // ground of its own: this page's is dark whatever the theme (style.css).
    <uiRuntime.ThemeProvider
      defaultDarkMode={app.config.theme === 'dark'}
      declaredMode={app.themeMode}
      box={THEME_BOX}
      followHost={framed}
      followSystem={framed}
    >
      {body}
    </uiRuntime.ThemeProvider>
  );
}
/**
 * What the shell runs: an app with the configuration it was deployed with.
 * A bundle's (load.ts), and a page of a site's (page.ts).
 */
export type LoadedPage = RunnableApplication & { config: SingleConfig };

/**
 * One app, from its configuration, or from what `load` gives, for an app that
 * comes from somewhere else: a page of a site (page.ts). A `backendCall`
 * passed here wins; without one, the configuration's `host` module supplies
 * it (see ./host).
 */
export function SingleApp({
  source,
  load,
  backendCall,
}: {
  source?: ConfigSource;
  load?: (signal: AbortSignal, progress: () => void) => Promise<LoadedPage>;
  backendCall?: HostBackendCall;
}) {
  const [app, setApp] = useState<LoadedPage | null>(null);
  const [hosted, setHosted] = useState<HostBackendCall | undefined>(undefined);
  // The reason the app could not load, or null while it has not failed.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  // Read when the app loads rather than listed as a dependency: a parent that
  // passes a fresh function on each render would otherwise reload the app.
  const passed = useRef(backendCall);
  passed.current = backendCall;
  useEffect(() => {
    const controller = new AbortController();
    let owned: LoadedPage | null = null;
    let restoreFavicon: (() => void) | undefined;
    let active = true;
    // A minute with nothing arriving, not a minute in all: see stall.ts.
    const stall = watchForStall(controller);
    const loading: Promise<LoadedPage> = load
      ? load(controller.signal, stall.touch)
      : source
        ? loadApplication(source, controller.signal, stall.touch)
        : Promise.reject(Error('Nothing to load: give the shell a configuration or a page'));
    void loading
      .then(async (result) => {
        owned = result;
        if (!active) {
          result.warmup?.abort();
          result.assets.dispose();
          return;
        }
        // Before the app mounts, so its first action has somewhere to go. A
        // host that is named and fails to load is a failure of the whole
        // page, not an app left running without its backend.
        const host = passed.current ? undefined : await loadHost(result.config);
        if (!active) {
          result.warmup?.abort();
          result.assets.dispose();
          return;
        }
        if (!result.config.initialPath || result.config.initialPath === '/') {
          if (!document.title || document.title === 'Application') {
            document.title = result.config.title;
          }
        }
        restoreFavicon = installFavicon(result.icon);
        setHosted(() => host);
        setApp(result);
      })
      .catch((error: unknown) => {
        if (!active) return;
        reportFailure(error);
        setFailure({ error });
      })
      .finally(() => stall.stop());
    return () => {
      active = false;
      controller.abort();
      stall.stop();
      owned?.warmup?.abort();
      owned?.assets.dispose();
      restoreFavicon?.();
    };
  }, [source, load]);
  // The page layout lets the document scroll, which means the root elements
  // above this one have to stop being viewport-high too; see style.css.
  const page = app?.config.layout === 'page';
  useEffect(() => {
    if (!page) return;
    document.documentElement.classList.add('softn-layout-page');
    return () => document.documentElement.classList.remove('softn-layout-page');
  }, [page]);
  return (
    <main className={page ? 'single-app layout-page' : 'single-app'}>
      {failure ? (
        <Failure error={failure.error} />
      ) : app ? (
        <Application app={app} backendCall={backendCall ?? hosted} />
      ) : (
        <Loading />
      )}
    </main>
  );
}
