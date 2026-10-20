import React, { Suspense } from 'react';

/**
 * A screen fetched the first time it opens (the brief, the blueprint review,
 * settings), and what shows if that fetch fails: a dropped connection, or a
 * new deployment that has replaced the file. Without a boundary React took
 * all of Studio down with the one screen.
 */
export function Deferred({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <LoadBoundary>
      <Suspense fallback={null}>{children}</Suspense>
    </LoadBoundary>
  );
}

class LoadBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" style={styles.notice}>
        <span>This part of Studio did not load. Check your connection, then reload the page.</span>
        <button type="button" style={styles.button} onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

const styles: Record<string, React.CSSProperties> = {
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    margin: 16,
    padding: '12px 16px',
    border: '1px solid var(--studio-border)',
    borderRadius: 'var(--studio-radius)',
    background: 'var(--studio-bg-elevated)',
    color: 'var(--studio-text)',
    fontSize: 13,
  },
  button: {
    flexShrink: 0,
    padding: '6px 12px',
    border: '1px solid var(--studio-border-strong)',
    borderRadius: 'var(--studio-radius)',
    background: 'var(--studio-bg)',
    color: 'var(--studio-text)',
    font: 'inherit',
    cursor: 'pointer',
  },
};
