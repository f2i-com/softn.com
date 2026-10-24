import React from 'react';
import { useProjectStore } from '../stores/projectStore';
import { flushCanvasToActiveFile } from '../utils/buildProjectBundle';
import { writeRecoveryCopy } from '../utils/recoveryCopy';

interface AppBoundaryState {
  error: Error | null;
  /** Whether the unsaved work was kept for recovery as the Builder stopped. */
  kept: boolean | null;
}

/**
 * The Builder, drawn where a throw stops it with words rather than a blank
 * page. A throw anywhere in its drawing took the whole page down, and with it
 * the hook that keeps unsaved work when the page is left. The work is in the
 * stores still, so it is kept for recovery here, the moment it stops, and the
 * next open offers it back as it offers any copy of unsaved work.
 */
export class AppBoundary extends React.Component<{ children: React.ReactNode }, AppBoundaryState> {
  state: AppBoundaryState = { error: null, kept: null };

  static getDerivedStateFromError(error: unknown): Partial<AppBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown): void {
    console.error('[Builder] Stopped by an error it could not draw past:', error);
    if (!useProjectStore.getState().isDirty) return;
    const outcome = writeRecoveryCopy({
      view: 'design',
      // What failed may be the canvas itself; the copy is taken from the files as they stand then.
      flush: () => {
        try {
          flushCanvasToActiveFile();
        } catch {
          // Kept without the canvas's last change.
        }
      },
    });
    this.setState({ kept: outcome.kind === 'written' });
  }

  render(): React.ReactNode {
    const { error, kept } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" data-builder-stopped="true" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--ink)', color: 'var(--paper)', fontFamily: 'inherit' }}>
        <div style={{ maxWidth: 520, display: 'grid', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 20 }}>The Builder stopped</h1>
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            Something in it could not be drawn: {error.message || 'an error with no message'}.
          </p>
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            {kept === true
              ? 'Your unsaved work has been kept in this browser. Reload, and the Builder offers it back.'
              : kept === false
                ? 'Your unsaved work could not be kept in this browser. Reload to carry on from what was last kept or saved.'
                : 'Reload to carry on.'}
          </p>
          <div>
            <button type="button" className="bl-btn bl-btn-primary" onClick={() => window.location.reload()}>
              Reload the Builder
            </button>
          </div>
        </div>
      </div>
    );
  }
}
