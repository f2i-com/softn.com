import React, { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo } from 'react';
import { SoftNWithXDB } from '@softn/core';
import { ThemeProvider, Spinner, Box, Text, Card } from '@softn/components';
import { PermissionBar, type ConsentRequest } from './PermissionBar';

interface AppRunnerProps {
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
  assetResolver?: (assetPath: string) => string;
  logicBasePath?: string;
  preIncludedLogicPaths?: string[];
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
}

interface ErrorBoundaryState {
  error: Error | null;
}

const appRunnerStyles = `
  @keyframes softn-runner-fade-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .softn-runner-error-wrap {
    animation: softn-runner-fade-in 350ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-runner-error-card {
    transition: box-shadow 250ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-runner-error-card:hover {
    box-shadow: 0 8px 32px rgba(239, 68, 68, 0.08), 0 0 0 1px rgba(239, 68, 68, 0.2);
  }
  .softn-runner-retry-btn {
    transition: all 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-runner-retry-btn:hover {
    background: #3a3a44 !important;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }
  .softn-runner-retry-btn:active {
    transform: translateY(0) scale(0.98);
  }
  .softn-runner-loading {
    animation: softn-runner-fade-in 300ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  /* @softn/components sizes an app root at calc(100vh - var(--softn-tab-bar-height)),
     off the viewport rather than off this flex box, so a bar inserted above it
     does not shrink it — it pushes the bundle's own footer that far below the
     fold. Anything the runtime puts above the app has to be added into that
     variable instead, and per tab: a bar in one tab must not resize another.

     Neither fallback in the calc() is a guess at the bar's height.
     --softn-chrome-base falls back to the 38px .softn-shell sets it to, for an
     AppRunner mounted outside that shell; --softn-consent-bar-height falls back
     to 0px, the height of a bar that is not there. The real height arrives
     inline on the element under the identical condition that adds this class,
     and an inline custom property beats a stylesheet one, so a per-breakpoint
     guess here could never be read anyway — and there is no frame for one to
     cover, because before the bar is measured the class is not applied. */
  .softn-runner-host--consenting {
    --softn-tab-bar-height: calc(var(--softn-chrome-base, 38px) + var(--softn-consent-bar-height, 0px));
  }
`;

/**
 * Only the text-shaped input types carry a selection. `selectionStart` on a
 * checkbox or a colour picker throws rather than answering null, so the type is
 * narrowed before it is read.
 */
function isTextEntry(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return /^(?:text|search|url|tel|password|email|)$/i.test(el.type);
}

/**
 * Put focus and caret back where the app had them.
 *
 * Only the element is remembered, never the offsets: a browser keeps an
 * input's selection across a blur, so reading it here — after the user has
 * finished typing and pressed Allow — is the position they actually left,
 * while a number captured when the field was first focused would be stale by
 * every character since. Reading before `focus()` matters too, because
 * focusing a text field can collapse the selection to its end.
 *
 * Returns false when there is nothing to restore or the element has gone. The
 * grant reloads the script against the granted config, so a field the bundle
 * renders conditionally may not survive it — that is the app-root fallback's
 * case, not a failure.
 */
function restoreFocus(element: HTMLElement | null): boolean {
  if (!element || !element.isConnected) return false;
  const selection = isTextEntry(element)
    ? { start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection ?? 'none' as const }
    : null;
  element.focus();
  if (selection && selection.start !== null && selection.end !== null && isTextEntry(element)) {
    try {
      element.setSelectionRange(selection.start, selection.end, selection.direction);
    } catch {
      // Still in the document but no longer takes a selection. Focus landed,
      // which is the part that stops the next keystroke going nowhere.
    }
  }
  return document.activeElement === element;
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
          <style dangerouslySetInnerHTML={{ __html: appRunnerStyles }} />
          <div className="softn-runner-error-wrap" style={{
            padding: '2rem',
            background: '#0c0c0e',
            minHeight: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <div
              className="softn-runner-error-card"
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
                  Application Error
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
                {this.state.error.message}
              </div>
              <button
                className="softn-runner-retry-btn"
                onClick={() => this.setState({ error: null })}
                style={{
                  marginTop: '1.25rem',
                  padding: '0.5rem 1.25rem',
                  background: '#1e1e23',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '8px',
                  color: '#ececf0',
                  cursor: 'pointer',
                  fontSize: '0.8125rem',
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                }}
              >
                Retry
              </button>
            </div>
          </div>
        </>
      );
    }
    return this.props.children;
  }
}

export function AppRunner({ source, appName, appId, active, initialPage, permissions, importResolver, assetResolver, logicBasePath, preIncludedLogicPaths, permissionConfig, consent, onPageChange, onReady, serverUrl, serverToken, serverCollections }: AppRunnerProps): React.ReactElement {
  const [barHeight, setBarHeight] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  // Stable, or the bar's ResizeObserver effect tears down and re-observes on
  // every render of this tab.
  const handleBarHeight = useCallback((px: number) => setBarHeight(px), []);
  // The bar unmounts when the grant lands, taking the focused Allow button
  // with it. Without somewhere for focus to go a keyboard user is dropped on
  // <body>, at the top of the document, having just pressed a button.
  //
  // The app root is the fallback, not the answer. Allow is pressed by someone
  // who was already using the app, so the field they were typing in is usually
  // still there afterwards — the grant upgrades the tab in place rather than
  // remounting it. Measured before this: typing into WarbleWire's textarea at
  // selectionStart 33 and pressing Allow left activeElement on the app root
  // DIV, and everything typed next went nowhere. The text survived; the caret
  // did not.
  const hadConsentRef = useRef(Boolean(consent));
  // The last thing inside the app itself to take focus, tracked as it happens
  // rather than read at Allow: by the time the click handler runs, focus is
  // already on the Allow button, and a keyboard user tabbed away from the
  // field before that.
  const lastAppFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !consent) return;
    const remember = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === host) return;
      // The bar, its collapsed chip and its detail dialog are runtime chrome
      // that disappears on Allow; restoring focus into them would be restoring
      // it to nothing.
      if (target.closest('.softn-consent-bar, .softn-consent-chip-strip, [role="dialog"]')) return;
      lastAppFocusRef.current = target;
    };
    host.addEventListener('focusin', remember);
    return () => host.removeEventListener('focusin', remember);
  }, [consent]);
  useEffect(() => {
    if (hadConsentRef.current && !consent) {
      const remembered = lastAppFocusRef.current;
      lastAppFocusRef.current = null;
      if (!restoreFocus(remembered)) hostRef.current?.focus();
    }
    hadConsentRef.current = Boolean(consent);
  }, [consent]);

  // Measured height is only meaningful while the bar exists. PermissionBar's
  // ResizeObserver effect reports 0 when it collapses but not when it
  // unmounts, so on Allow the last measurement stuck and the app kept a 46px
  // strip of nothing reserved above it for the rest of the session.
  const consentBarHeight = consent ? barHeight : 0;

  // Build initial state: page from URL + saved sync room from localStorage
  const initialState = useMemo(() => {
    const state: Record<string, unknown> = {};
    if (initialPage) state.currentPage = initialPage;
    try {
      const savedRoom = localStorage.getItem('xdb-sync-active-room');
      if (savedRoom) {
        state.syncRoom = savedRoom;
        // Not while the bar is unanswered. startSync is refused in that state
        // and nothing clears the flag, so an app with a saved room came up
        // saying "connecting" forever, with nothing on screen connecting it to
        // the bar that would have.
        //
        // Allow does not reconnect it either. The renderer only resumes a saved
        // room when it is handed resumeSavedSyncRoom, and softn-web never
        // passes it — the room is seeded into state so the app's own sync
        // control comes up filled in, and reconnecting is the user's press.
        // Setting the flag here would therefore be claiming a connection that
        // nothing is making, which is what it was doing.
        if (!consent) state.syncConnecting = true;
      }
    } catch {
      // localStorage may be unavailable (privacy mode / sandboxed context)
    }
    return Object.keys(state).length > 0 ? state : undefined;
    // `consent` is read for the flag above but deliberately absent from the
    // deps: this is the state the app *starts* from, and rebuilding it on the
    // grant would re-seed currentPage and throw the user back to the page they
    // arrived on. The renderer keeps its own componentState across the reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPage]);

  // Skeleton tab (source not yet loaded) — show loading inside the tab
  if (!source) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          display: active ? 'flex' : 'none',
          flexDirection: 'column',
        }}
      >
        <style dangerouslySetInnerHTML={{ __html: appRunnerStyles }} />
        <ThemeProvider followSystem>
          <Box
            className="softn-runner-loading"
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
              flexDirection: 'column',
              gap: '1rem',
              background: '#0c0c0e',
            }}
          >
            <Spinner size="lg" />
            <Text style={{ color: '#5a5a66', fontSize: '0.875rem', letterSpacing: '-0.01em' }}>Loading {appName}...</Text>
          </Box>
        </ThemeProvider>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
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
      <style dangerouslySetInnerHTML={{ __html: appRunnerStyles }} />
      {/* Outside ThemeProvider, and above the error boundary, so it cannot be
          mistaken for the app's own UI: the bundle picks its theme and would
          otherwise paint this bar in it. */}
      {consent && (
        <PermissionBar
          appName={consent.appName}
          appIcon={consent.appIcon}
          config={consent.config}
          capabilities={consent.capabilities}
          onHeightChange={handleBarHeight}
          onAllow={consent.onAllow}
        />
      )}
      <RunnerErrorBoundary>
        <ThemeProvider followSystem>
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
            permissionConfig={permissionConfig}
            appId={appId ?? appName}
            onPageChange={onPageChange}
            onLoad={onReady}
            serverUrl={serverUrl}
            serverToken={serverToken}
            serverCollections={serverCollections}
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
                  background: '#0c0c0e',
                }}
              >
                <Spinner size="lg" />
                <Text style={{ color: '#5a5a66', fontSize: '0.875rem', letterSpacing: '-0.01em' }}>Loading {appName}...</Text>
              </Box>
            }
            error={(err) => (
              <Box className="softn-runner-error-wrap" style={{
                padding: '2rem',
                display: 'flex',
                justifyContent: 'center',
              }}>
                <Card
                  className="softn-runner-error-card"
                  style={{
                    padding: '1.5rem',
                    background: '#16161a',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    maxWidth: '480px',
                    width: '100%',
                    borderRadius: '14px',
                    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                      </svg>
                    </div>
                    <Text style={{
                      color: '#7a7a86',
                      fontSize: '0.8125rem',
                      fontFamily: 'monospace',
                      wordBreak: 'break-word',
                    }}>
                      {err.message}
                    </Text>
                  </div>
                </Card>
              </Box>
            )}
          />
        </ThemeProvider>
      </RunnerErrorBoundary>
    </div>
  );
}
