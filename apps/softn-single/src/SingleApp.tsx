import React, { Component, useEffect, useMemo, useRef, useState } from 'react';
import { SoftNWithXDB, inspectDeclaration, type Capability, type PermissionConfig } from '@softn/core';
// The theme entry, not the root barrel: the barrel is the eager path, and
// keeping Scene3D out of this shell would then rest on the bundler
// tree-shaking it away (docs/COMPONENT_LOADING.md).
import { ThemeProvider } from '@softn/components/theme';
import { createImportResolver, withheldPermissions } from '../../softn-web/src/lib/bundleProcessor';
import type { AssetResolver } from '../../softn-web/src/lib/bundleProcessor';
import { loadApplication, type ConfigSource, type LoadedApplication } from './load';
import type { DirectoryConfig } from './config';
import { installFavicon } from './favicon';
/**
 * What `Application` needs of a loaded app: the slice of `LoadedApplication`
 * it reads, so a host that produces its app some other way — the PHP-served
 * runtime in apps/softn-single-php-serve fetches entries instead of an
 * archive — can render the same shell without pretending to have an archive.
 */
export interface RunnableApplication {
  config: {
    title: string;
    theme: 'light' | 'dark';
    loadingText: string;
    permissionMode?: 'prompt' | 'preapproved';
    /** Set when a directory served the shell: where the run is counted and the app's storage lives. */
    directory?: DirectoryConfig;
  };
  declared: PermissionConfig;
  grantKey: string;
  appId: string;
  textFiles: Map<string, string>;
  execution: 'worker' | 'main';
  source: string;
  logicBasePath?: string;
  preIncludedLogicPaths: string[];
  assets: AssetResolver;
}
const labels: Record<Capability, string> = {
  net: 'Internet access',
  camera: 'Camera',
  mic: 'Microphone',
  files: 'Files you choose',
  qr: 'QR scanning',
  ai: 'Local AI model downloads',
  gpu: 'Graphics hardware',
  sync: 'Device synchronization',
  storage: 'Server storage',
  accel: 'Accelerated code execution',
};
export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="wheel" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
export function Failure() {
  return (
    <div className="loading" role="alert">
      <h1>Unable to open this application</h1>
      <p>Please try again. If the problem continues, contact the site owner.</p>
      <button onClick={() => location.reload()}>Try again</button>
    </div>
  );
}
class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <Failure /> : this.props.children;
  }
}
function savedGrant(key: string) {
  try {
    return localStorage.getItem(key) === 'allowed';
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
export function Application({ app }: { app: RunnableApplication }) {
  const requested = inspectDeclaration(app.declared).requested;
  // Preapproved by the operator: granted from the start, with no bar and
  // nothing written to storage — the host's setting, not a consent.
  const [answer, setAnswer] = useState<'pending' | 'allow' | 'deny'>(() =>
    app.config.permissionMode === 'preapproved' || !requested.length || savedGrant(app.grantKey) ? 'allow' : 'pending'
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
  const bar = useRef<HTMLElement>(null);
  const [barHeight, setBarHeight] = useState(0);
  useEffect(() => {
    if (!bar.current) {
      setBarHeight(0);
      return;
    }
    const element = bar.current;
    const measure = () => setBarHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [answer]);
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
    try {
      localStorage.setItem(app.grantKey, 'allowed');
    } catch {
      /* Consent still applies for this session. */
    }
    setAnswer('allow');
  }
  return (
    <ThemeProvider defaultDarkMode={app.config.theme === 'dark'}>
      <div
        className="application-layout"
        style={{ '--softn-tab-bar-height': `${barHeight}px` } as React.CSSProperties}
      >
        {answer === 'pending' && (
          <section ref={bar} className="permission-bar" aria-labelledby="permission-title">
            <div className="permission-message">
              <strong id="permission-title">{app.config.title} requests access</strong>
              <span>{requested.map((c) => labels[c]).join(' · ')}</span>
              <details>
                <summary>Permission details</summary>
                <p>
                  Access is disabled until you allow it. Your browser may ask separately for camera
                  or microphone access.
                </p>
                <pre>{JSON.stringify(app.declared.permissions, null, 2)}</pre>
              </details>
            </div>
            <div className="actions">
              <button onClick={() => setAnswer('deny')}>Not now</button>
              <button onClick={allow}>Allow</button>
            </div>
          </section>
        )}
        <div className="application-content">
          <Boundary>
            <SoftNWithXDB
              source={app.source}
              appId={app.appId}
              functions={functions}
              importResolver={imports}
              assetResolver={app.assets}
              logicBasePath={app.logicBasePath}
              preIncludedLogicPaths={app.preIncludedLogicPaths}
              executionPreference={app.execution}
              permissionConfig={permissions}
              storageEndpoint={app.config.directory?.storage}
              onLoad={onLoad}
              loading={<Loading text={app.config.loadingText} />}
              error={() => <Failure />}
            />
          </Boundary>
          {answer === 'deny' && requested.length > 0 && (
            <button className="review" onClick={() => setAnswer('pending')}>
              Review permissions
            </button>
          )}
        </div>
      </div>
    </ThemeProvider>
  );
}
export function SingleApp({ source }: { source: ConfigSource }) {
  const [app, setApp] = useState<LoadedApplication | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let owned: LoadedApplication | null = null;
    let restoreFavicon: (() => void) | undefined;
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 60000);
    void loadApplication(source, controller.signal)
      .then((result) => {
        owned = result;
        if (!active) {
          result.assets.dispose();
          return;
        }
        document.title = result.config.title;
        restoreFavicon = installFavicon(result.icon);
        setApp(result);
      })
      .catch(() => {
        if (active) setFailed(true);
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
  return (
    <main className="single-app">
      {failed ? <Failure /> : app ? <Application app={app} /> : <Loading />}
    </main>
  );
}
