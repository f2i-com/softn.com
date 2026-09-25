import React, { Component, useEffect, useMemo, useRef, useState } from 'react';
import { SoftNWithXDB, inspectDeclaration, type PermissionConfig, type PythonProject } from '@softn/core';
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
import { loadApplication, type ConfigSource, type LoadedApplication } from './load';
import type { DirectoryConfig } from './config';
import { installFavicon } from './favicon';
import { loadHost, type HostBackendCall } from './host';
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
  source: string;
  logicBasePath?: string;
  preIncludedLogicPaths: string[];
  /** The app's Python project, when its logic is Python. */
  python?: PythonProject;
  assets: AssetResolver;
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
  return (
    <ThemeProvider defaultDarkMode={app.config.theme === 'dark'}>
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
        <div className="application-content" ref={content} tabIndex={-1}>
          <Boundary>
            <SoftNWithXDB
              source={app.source}
              backendCall={backendCall}
              appId={app.appId}
              functions={functions}
              importResolver={imports}
              assetResolver={app.assets}
              logicBasePath={app.logicBasePath}
              preIncludedLogicPaths={app.preIncludedLogicPaths}
              python={app.python}
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
 * One app, from its configuration. A `backendCall` passed here wins; without
 * one, the configuration's `host` module supplies it (see ./host).
 */
export function SingleApp({ source, backendCall }: { source: ConfigSource; backendCall?: HostBackendCall }) {
  const [app, setApp] = useState<LoadedApplication | null>(null);
  const [hosted, setHosted] = useState<HostBackendCall | undefined>(undefined);
  // The reason the app could not load, or null while it has not failed.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  // Read when the app loads rather than listed as a dependency: a parent that
  // passes a fresh function on each render would otherwise reload the app.
  const passed = useRef(backendCall);
  passed.current = backendCall;
  useEffect(() => {
    const controller = new AbortController();
    let owned: LoadedApplication | null = null;
    let restoreFavicon: (() => void) | undefined;
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 60000);
    void loadApplication(source, controller.signal)
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
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      owned?.assets.dispose();
      restoreFavicon?.();
    };
  }, [source]);
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
