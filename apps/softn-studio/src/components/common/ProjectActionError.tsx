import type { CSSProperties } from 'react';

/** Action failures stay visible on phones, where the console is not available. */
export function ProjectActionError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="alert" style={styles.box}>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{message}</span>
      <button type="button" aria-label="Dismiss project action error" onClick={onDismiss} style={styles.dismiss}>×</button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  box: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10,
    border: '1px solid var(--studio-error)', background: 'var(--studio-panel-strong)',
    color: 'var(--studio-text)', fontSize: 13, lineHeight: 1.5,
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
  },
  dismiss: {
    flexShrink: 0, width: 40, height: 40, border: '1px solid var(--studio-border)',
    borderRadius: 8, background: 'transparent', color: 'inherit', fontSize: 20, cursor: 'pointer',
  },
};
