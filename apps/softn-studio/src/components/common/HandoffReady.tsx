import React from 'react';
import { Icon } from './Icon';
import { destinationLabel, type ReadyHandoff } from '../../lib/handoff';

/**
 * A staged bundle's way out: a link to its receiver in a new tab, which is
 * the person's own click and so never popup-blocked, and the same address
 * for this tab for anyone who would rather leave the editor. Neither is
 * taken for them. `rel="noopener"` keeps the receiver from holding a
 * handle on the editor.
 */
export function HandoffReady({ ready, onDone, compact = false }: { ready: ReadyHandoff; onDone: () => void; compact?: boolean }): React.ReactElement {
  const label = destinationLabel(ready.to);
  return (
    <div role="status" aria-live="polite" style={{ ...styles.box, ...(compact ? styles.boxCompact : {}) }}>
      <span style={styles.text}>
        <strong>{ready.name}</strong> is ready for {label}.
      </span>
      <span style={styles.actions}>
        <a href={ready.url} target="_blank" rel="noopener noreferrer" style={styles.primary} onClick={() => setTimeout(onDone, 0)}>
          <Icon name={ready.to === 'runtime' ? 'play' : 'upload'} size={14} />
          <span>Open in a new tab</span>
        </a>
        <a href={ready.url} style={styles.secondary} title="Leave Studio and open it in this tab">
          Open here
        </a>
        <button type="button" onClick={onDone} style={styles.dismiss} aria-label="Dismiss">
          ×
        </button>
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  box: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    padding: '8px 12px',
    borderRadius: 10,
    border: '1px solid var(--studio-accent)',
    background: 'var(--studio-panel-strong)',
    color: 'var(--studio-text)',
    fontSize: 12,
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
  },
  boxCompact: {
    boxShadow: 'none',
    borderRadius: 8,
  },
  text: {
    minWidth: 0,
  },
  actions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    marginLeft: 'auto',
  },
  primary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 8,
    background: 'var(--studio-accent)',
    color: '#fff',
    fontWeight: 700,
    textDecoration: 'none',
    fontSize: 12,
  },
  secondary: {
    color: 'var(--studio-text)',
    textDecoration: 'underline',
    fontSize: 12,
  },
  dismiss: {
    border: '1px solid var(--studio-border)',
    background: 'transparent',
    color: 'var(--studio-text)',
    borderRadius: 6,
    width: 24,
    height: 24,
    cursor: 'pointer',
    fontFamily: 'inherit',
    lineHeight: 1,
  },
};
