import React, { Component, useCallback, useId, useMemo, useRef, useState, type ErrorInfo } from 'react';
import { SoftNWithXDB, type AppAssetResolver, type PythonProject } from '@softn/core';
// From the minimal and theme entries, not the root barrel: the barrel is the
// eager path, and keeping Scene3D out of the shell would then rest on the
// bundler tree-shaking it away (docs/engineering/COMPONENT_LOADING.md).
import { Spinner, Box, Text } from '@softn/components/essentials';
import { ThemeProvider } from '@softn/components/theme';
import { PermissionBar, type ConsentRequest } from '@softn/runtime-shell/PermissionBar';
import { LoadProgress } from '@softn/runtime-shell/LoadProgress';
import { buildRunnerInitialState, savedSyncRoomKey } from '../lib/runnerState';
import './AppRunner.css';

interface AppRunnerProps {
  /** The shell's id for this tab, so the shell can move focus into it. */
  tabId?: string;
  source: string;
  /** Shown to the user. Chosen by the bundle, so never used to identify it. */
  appName: string;
  /**
   * The app's identity — a digest of its bundle — which is what its database
   * and its permission grants belong to. This used to be appName, so any
   * bundle could name itself after another and be handed that app's data.
   */
  appId?: string;
  active: boolean;
  initialPage?: string;
  permissions?: import('@softn/core').AppPermissions;
  importResolver?: (path: string) => Promise<string | null>;
  /** Provides the `asset()` the templates call; without it every image is missing. */
  assetResolver?: AppAssetResolver;
  logicBasePath?: string;
  preIncludedLogicPaths?: string[];
  /** The app's Python project, when its logic is Python; without it a Python app runs no logic. */
  python?: PythonProject;
  /** The manifest's `config.execution`, forwarded to the renderer. */
  executionPreference?: 'worker' | 'main';
  /**
   * The manifest's `config.theme.mode`, as the bundle has it. "light" and
   * "dark" win over softn.com's own theme and the visitor's device; the rule
   * is @softn/components' (theme/app-theme.ts).
   */
  themeMode?: unknown;
  permissionConfig?: import('@softn/core').PermissionConfig;
  /**
   * The bundle declared capabilities the user has not answered yet, so
   * `permissionConfig` above is the withheld one and this raises the bar that
   * offers the real one. Absent once a grant exists.
   */
  consent?: ConsentRequest;
  onPageChange?: (page: string) => void;
  /** Fires once the document has parsed and the app is on screen rather than its spinner. */
  onReady?: () => void;
  serverUrl?: string;
  serverToken?: string;
  serverCollections?: string[];
  /** The app's storage endpoint in the directory it was opened from, if any. */
  storageEndpoint?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * The box an app renders into: everything below the permission bar. See the
 * comment where it is used for why it contains the app's paint.
 */
const APP_BOX_STYLE: React.CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  contain: 'paint',
  isolation: 'isolate',
};

/** The loading screens' download panel, in their quieter text colour. */
const LOAD_PROGRESS_STYLE: React.CSSProperties = { color: 'var(--dim)', width: 'min(320px, 80%)' };

const ERROR_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

/** What a running app's failure looks like, from either the boundary or the renderer. */
function RunnerErrorCard({ title, hint, detail, action }: { title: string; hint: string; detail?: string; action?: React.ReactNode }): React.ReactElement {
  return (
    <div className="softn-runner-error-card">
      <div className="softn-runner-error-head">
        <div className="softn-runner-error-icon">{ERROR_ICON}</div>
        <h2 className="softn-runner-error-title">{title}</h2>
      </div>
      <p className="softn-runner-error-hint">{hint}</p>
      {detail && <p className="softn-runner-error-detail">{detail}</p>}
      {action}
    </div>
  );
}

/** Error boundary for the SoftN renderer */
class RunnerErrorBoundary extends Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[SoftN Web] Render error:', error, info);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <>
          <div className="softn-runner-error-wrap" role="alert">
            <RunnerErrorCard
              title="This app stopped working"
              hint="Something in the app failed while it was running. Try again; if it keeps happening, close it from the bar above and open it again, or tell its author."
              detail={this.state.error.message}
              action={
                <button type="button" className="softn-runner-retry-btn" onClick={() => this.setState({ error: null })}>
                  Try again
                </button>
              }
            />
          </div>
        </>
      );
    }
    return this.props.children;
  }
}

export function AppRunner({ tabId, source, appName, appId, active, initialPage, permissions, importResolver, assetResolver, logicBasePath, preIncludedLogicPaths, python, executionPreference, themeMode, permissionConfig, consent, onPageChange, onReady, serverUrl, serverToken, serverCollections, storageEndpoint }: AppRunnerProps): React.ReactElement {
  const [barHeight, setBarHeight] = useState(0);
  // The name of the box this app is drawn in, for the provider to write a
  // declared side on. Every open app stays mounted in the one document, and
  // a provider with no box writes on the document, where the last app opened
  // would decide the tokens of all of them. The tab's id where the shell
  // gave one; an id of its own for a runner mounted outside the shell.
  const ownBox = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const themeBox = tabId && /^[A-Za-z0-9_-]{1,64}$/.test(tabId) ? tabId : `app-${ownBox}`;
  const hostRef = useRef<HTMLDivElement>(null);
  // Stable, or the bar's ResizeObserver effect tears down and re-observes on
  // every render of this tab.
  const handleBarHeight = useCallback((px: number) => setBarHeight(px), []);
  // After Allow the bar puts focus back into the app — where it was, or on
  // this host — rather than leaving a keyboard user on <body>; see
  // PermissionBar's appRootRef.
  // Measured height is only meaningful while the bar exists. PermissionBar's
  // ResizeObserver effect reports 0 when it collapses but not when it
  // unmounts, so on Allow the last measurement stuck and the app kept a 46px
  // strip of nothing reserved above it for the rest of the session.
  const consentBarHeight = consent ? barHeight : 0;

  // The identity the renderer runs this app under: its database, its grants,
  // and the key its sync room is saved under all belong to it.
  const runtimeAppId = appId ?? appName;

  // The state the app *starts* from: the page it was opened at and the room
  // it was last in. Only that — see runnerState.ts for why the room is seeded
  // without a connection flag: nothing here reconnects it, so a flag would
  // describe a connection nothing is attempting, and nothing would clear it.
  //
  // Deliberately not rebuilt on the consent grant: the renderer keeps its own
  // componentState across the reload, and a fresh object here would re-seed
  // currentPage and throw the user back to the page they arrived on.
  const initialState = useMemo(() => {
    let savedRoom: string | null = null;
    try {
      savedRoom = localStorage.getItem(savedSyncRoomKey(runtimeAppId));
    } catch {
      // localStorage may be unavailable (privacy mode / sandboxed context)
    }
    return buildRunnerInitialState({ initialPage, savedRoom });
  }, [initialPage, runtimeAppId]);

  // Skeleton tab (source not yet loaded) — show loading inside the tab
  if (!source) {
    return (
      <div
        data-softn-tab={tabId}
        tabIndex={-1}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          display: active ? 'flex' : 'none',
          flexDirection: 'column',
          outline: 'none',
        }}
      >
        <ThemeProvider followHost followSystem>
          <Box
            className="softn-runner-loading"
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
              flexDirection: 'column',
              gap: '1rem',
              background: 'var(--ink)',
            }}
          >
            <Spinner size="lg" />
            <Text style={{ color: 'var(--dim)', fontSize: '0.875rem', letterSpacing: '-0.01em' }}>
              <span role="status">Opening {appName}…</span>
            </Text>
            {/* What is downloading once the wait has gone on: the bundle,
                then the engine and the first screen's components. */}
            <div style={LOAD_PROGRESS_STYLE}>
              <LoadProgress />
            </div>
          </Box>
        </ThemeProvider>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      data-softn-tab={tabId}
      // Allow unmounts the bar mid-click, so there has to be somewhere for
      // focus to land other than <body>.
      tabIndex={-1}
      className={consentBarHeight > 0 ? 'softn-runner-host softn-runner-host--consenting' : undefined}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
        outline: 'none',
        ...(consentBarHeight > 0
          ? ({ '--softn-consent-bar-height': `${consentBarHeight}px` } as React.CSSProperties)
          : null),
      }}
    >
      {/* Outside ThemeProvider, and above the error boundary, so it cannot be
          mistaken for the app's own UI: the bundle picks its theme and would
          otherwise paint this bar in it. */}
      {consent && (
        // `previous` included: the comparison with the build opened before
        // this one was worked out by App and then dropped here, so an update
        // that added a capability read exactly like the request before it.
        <PermissionBar {...consent} onHeightChange={handleBarHeight} appRootRef={hostRef} />
      )}
      {/* The app's own box, below the bar and never over it. Without
          containment a bundle's `position: fixed` element was positioned
          against the viewport: a full-screen overlay painted over the consent
          bar and could put its own "Allow" where the real one was, or hide the
          bar and the capabilities it lists. `contain: paint` makes this box
          the containing block for fixed descendants and clips everything the
          app draws to it, and the stacking context it creates keeps any
          z-index the app picks inside it — the bar, a sibling painted outside,
          stays whole. A full-screen app still fills the whole of its tab: the
          box is the area it was always meant to occupy. (Markup that would
          reach the browser's top layer, which no containment clips, is refused
          by the renderer.) */}
      <div className="softn-runner-app" style={APP_BOX_STYLE} data-softn-theme-box={themeBox}>
        <RunnerErrorBoundary>
          <ThemeProvider followHost followSystem declaredMode={themeMode} box={themeBox}>
            <SoftNWithXDB
              source={source}
              initialState={initialState}
              permissions={permissions}
              importResolver={importResolver}
              functions={
                assetResolver
                  ? { asset: (...args: unknown[]) => assetResolver(String(args[0] ?? '')) }
                  : undefined
              }
              logicBasePath={logicBasePath}
              preIncludedLogicPaths={preIncludedLogicPaths}
              python={python}
              executionPreference={executionPreference}
              permissionConfig={permissionConfig}
              appId={runtimeAppId}
              // Every tab stays mounted; only this says which one is on screen.
              active={active}
              assetResolver={assetResolver}
              onPageChange={onPageChange}
              onLoad={onReady}
              serverUrl={serverUrl}
              serverToken={serverToken}
              serverCollections={serverCollections}
              storageEndpoint={storageEndpoint}
              loading={
                <Box
                  className="softn-runner-loading"
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    height: '100%',
                    minHeight: '300px',
                    flexDirection: 'column',
                    gap: '1rem',
                    background: 'var(--ink)',
                  }}
                >
                  <Spinner size="lg" />
                  <Text style={{ color: 'var(--dim)', fontSize: '0.875rem', letterSpacing: '-0.01em' }}>
                    <span role="status">Starting {appName}…</span>
                  </Text>
                  <div style={LOAD_PROGRESS_STYLE}>
                    <LoadProgress />
                  </div>
                </Box>
              }
              error={(err) => (
                <div className="softn-runner-error-wrap" role="alert">
                  <RunnerErrorCard
                    title="This app couldn’t start"
                    hint="The runtime could not run this app’s markup or logic. If you made it, the reason below says where; otherwise tell whoever shared it."
                    detail={err.message}
                  />
                </div>
              )}
            />
          </ThemeProvider>
        </RunnerErrorBoundary>
      </div>
      {/* What is still arriving once the app is drawn (on a first visit, the
          script engine its taps wait for; later, a page's 3D): a thin line
          over the top of the app, under the permission bar. Drawn after the
          app's box, whose own stacking keeps everything the app draws below. */}
      <LoadProgress variant="bar" top={consentBarHeight > 0 ? `${consentBarHeight}px` : undefined} />
    </div>
  );
}
