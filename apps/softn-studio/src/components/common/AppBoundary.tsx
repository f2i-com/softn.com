import React from 'react';

/**
 * Studio, drawn where a throw stops it with words rather than a blank page: a
 * throw anywhere in its drawing took the whole page down, and with no message
 * anywhere but the console.
 */
export class AppBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown): void {
    console.error('[Studio] Stopped by an error it could not draw past:', error);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" data-studio-stopped="true" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--ink)', color: 'var(--paper)', fontFamily: 'inherit' }}>
        <div style={{ maxWidth: 520, display: 'grid', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 20 }}>Studio stopped</h1>
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            Something in it could not be drawn: {error.message || 'an error with no message'}.
          </p>
          <p style={{ margin: 0, lineHeight: 1.5 }}>Reload to carry on from what was last saved.</p>
          <div>
            <button type="button" className="st-btn st-btn-primary" onClick={() => window.location.reload()}>
              Reload Studio
            </button>
          </div>
        </div>
      </div>
    );
  }
}
