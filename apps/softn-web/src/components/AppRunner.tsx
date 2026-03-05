import React, { Component, useMemo, type ErrorInfo } from 'react';
import { SoftNWithXDB } from '@softn/core';
import { ThemeProvider, Spinner, Box, Text, Card } from '@softn/components';

interface AppRunnerProps {
  source: string;
  appName: string;
  active: boolean;
  initialPage?: string;
  permissions?: import('@softn/core').AppPermissions;
  importResolver?: (path: string) => Promise<string | null>;
  logicBasePath?: string;
  onPageChange?: (page: string) => void;
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
`;

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

export function AppRunner({ source, appName, active, initialPage, permissions, importResolver, logicBasePath, onPageChange }: AppRunnerProps): React.ReactElement {
  // Build initial state: page from URL + saved sync room from localStorage
  const initialState = useMemo(() => {
    const state: Record<string, unknown> = {};
    if (initialPage) state.currentPage = initialPage;
    try {
      const savedRoom = localStorage.getItem('xdb-sync-active-room');
      if (savedRoom) {
        state.syncRoom = savedRoom;
        state.syncConnecting = true;
      }
    } catch {
      // localStorage may be unavailable (privacy mode / sandboxed context)
    }
    return Object.keys(state).length > 0 ? state : undefined;
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
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: appRunnerStyles }} />
      <RunnerErrorBoundary>
        <ThemeProvider followSystem>
          <SoftNWithXDB
            source={source}
            initialState={initialState}
            permissions={permissions}
            importResolver={importResolver}
            logicBasePath={logicBasePath}
            appId={appName}
            onPageChange={onPageChange}
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
