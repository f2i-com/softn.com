import type { CSSProperties, ReactElement } from 'react';

/**
 * What coming back from the Builder brought into the project, said where
 * Run's link and its failures are said: the change is in the files and in
 * History, and neither is on the screen when the page opens. It stays until
 * it is dismissed. A return that could not be taken is an alert; one that
 * was is a status.
 */
export function BuilderReturnNotice({ text, failed, onDismiss }: { text: string; failed: boolean; onDismiss: () => void }): ReactElement {
  return (
    <div role={failed ? 'alert' : 'status'} data-builder-return={failed ? 'failed' : 'taken'} style={{ ...styles.box, borderColor: failed ? 'var(--studio-error)' : 'var(--studio-accent)' }}>
      <span style={styles.text}>{text}</span>
      <button type="button" aria-label="Dismiss the note about the Builder" onClick={onDismiss} style={styles.dismiss}>×</button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  box: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 6px 6px 12px',
    borderRadius: 8,
    border: '1px solid',
    background: 'var(--studio-panel-strong)',
    color: 'var(--studio-text)',
    fontSize: 12,
    lineHeight: 1.5,
  },
  text: {
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  dismiss: {
    flexShrink: 0,
    width: 28,
    height: 28,
    border: '1px solid var(--studio-border)',
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    fontSize: 16,
    lineHeight: 1,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
