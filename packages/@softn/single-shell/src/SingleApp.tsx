import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SoftNWithXDB,
  inspectDeclaration,
  type ComposedBundleSource,
  type PermissionConfig,
  type PythonProject,
} from '@softn/core';
// The theme entry, not the root barrel: the barrel is the eager path, and
// keeping Scene3D out of this shell would then rest on the bundler
// tree-shaking it away (docs/engineering/COMPONENT_LOADING.md).
import { ThemeProvider } from '@softn/components/theme';
import { createImportResolver } from '@softn/runtime-shell/bundleProcessor';
// The consent rule, bar and dialog the web runtime and the desktop loader
// use too, so a bundle is asked in the same words on a single-app page.
import { hasSavedGrant, saveGrant, withheldPermissions } from '@softn/runtime-shell/consent';
import { PermissionBar } from '@softn/runtime-shell/PermissionBar';
import type { AssetResolver } from '@softn/runtime-shell/bundleProcessor';
import { loadApplication, type ConfigSource } from './load';
import { watchForStall } from './stall';
import type { DirectoryConfig, SingleConfig } from './config';
import { installFavicon } from './favicon';
import { loadHost, type HostBackendCall } from './host';
import { bundlePageAt, composePage, mainPage, pageTitle } from './pages';
// The slim bar the runtime draws over every app, for the pages a directory
// serves through this shell; drawn from the shared tokens, which come along.
import { FrameBar } from '@softn/runtime-shell/FrameBar';
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
  assets: AssetResolver;
  /**
   * Whether a link to another page of the bundle shows that page in the app
   * (the default). A page of a site run in page mode leaves its links to the
   * browser: each page of the site starts the app itself, at its own address.
   */
  followsLinks?: boolean;
}
export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="wheel" aria-hidden="true" />
      <span>{text}</span>
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
  const reason = describeFailure(error);
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
/** The message a failure carries, if it carries one worth showing. */
export function describeFailure(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return null;
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
  const permissions = useMemo(
    () => (granted ? app.declared : withheldPermissions(app.declared)),
    [granted, app]
  );
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
  const imports = useMemo(
    () => createImportResolver(app.textFiles, permissions),
    [app, permissions]
  );
  useEffect(() => () => imports.dispose(), [imports]);
  const counted = useRef(false);
  const runsUrl = app.config.directory?.runs;
  const onLoad = useMemo(
    () =>
      runsUrl
        ? () => {
            // Once per load of the page: a permission grant re-renders the
            // runtime in place, and that is the same run.
            if (counted.current) return;
            counted.current = true;
            countRun(runsUrl);
          }
        : undefined,
    [runsUrl]
  );
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
  const main = useMemo(() => mainPage(app.textFiles), [app]);
  const [page, setPage] = useState<{ path: string; composed: ComposedBundleSource } | null>(null);
  const show = useCallback(
    (path: string | null): boolean => {
      if (path === null || path === main) {
        setPage(null);
        document.title = app.config.title;
        return true;
      }
      let composed: ComposedBundleSource;
      try {
        composed = composePage(app.textFiles, path);
      } catch (error) {
        console.warn(`[SoftN] ${path} cannot be shown:`, error instanceof Error ? error.message : error);
        return false;
      }
      setPage({ path, composed });
      document.title = pageTitle(app.textFiles, path) ?? app.config.title;
      return true;
    },
    [app, main]
  );
  const followLink = useCallback(
    (href: string): boolean => {
      if (app.followsLinks === false || main === null) return false;
      const from = page?.path ?? main;
      const path = bundlePageAt(app.textFiles, from, href);
      if (path === null) return false;
      if (path === from) return true;
      if (!show(path)) return false;
      history.pushState({ softnPage: path }, '');
      content.current?.scrollTo?.(0, 0);
      return true;
    },
    [app, main, page, show]
  );
  useEffect(() => {
    if (app.followsLinks === false) return;
    const back = (event: PopStateEvent) => {
      const path = (event.state as { softnPage?: unknown } | null)?.softnPage;
      show(typeof path === 'string' ? path : null);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [app, show]);
  const shown = page?.composed ?? app;
  // The page's code set document.title: the window is the app's.
  const showTitle = useCallback((title: string) => {
    document.title = title;
  }, []);
  return (
    // The project's declared side over the deployment's `theme`, which stays
    // the default; the rule that weighs them is the provider's. The box named
    // here is where a side that is not the deployment's is written, with a
    // ground of its own: this page's is dark whatever the theme (style.css).
    <ThemeProvider defaultDarkMode={app.config.theme === 'dark'} declaredMode={app.themeMode} box={THEME_BOX}>
      <div
        ref={layout}
        className="application-layout"
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
              homeLabel="softn.com"
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
            />
          )}
        </div>
        <div className="application-content" ref={content} tabIndex={-1} data-softn-theme-box={THEME_BOX}>
          <Boundary>
            <SoftNWithXDB
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
              executionPreference={app.execution}
              permissionConfig={permissions}
              storageEndpoint={app.config.directory?.storage}
              onLoad={onLoad}
              loading={<Loading text={app.config.loadingText} />}
              error={(error: Error) => {
                reportFailure(error);
                return <Failure error={error} />;
              }}
            />
          </Boundary>
        </div>
      </div>
    </ThemeProvider>
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
        // Before the app mounts, so its first action has somewhere to go. A
        // host that is named and fails to load is a failure of the whole
        // page, not an app left running without its backend.
        const host = passed.current ? undefined : await loadHost(result.config);
        if (!active) {
          result.assets.dispose();
          return;
        }
        document.title = result.config.title;
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
