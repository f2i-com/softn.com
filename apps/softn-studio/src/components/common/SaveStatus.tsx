import React, { useSyncExternalStore } from 'react';
import { Icon } from './Icon';
import { getSaveStatus, subscribeSaveStatus, type SaveStatus } from '../../lib/projectSession';
import { exportCurrentProject } from './ProjectActions';

/**
 * Whether the project in memory has reached this browser's storage.
 *
 * Autosave used to be silent: the write's result was discarded, so a full
 * disk or a browser that had revoked storage looked exactly like a saved
 * project until the next start found nothing. This element tells the truth
 * at every moment — saved, saving, or not saved and why — and puts Export
 * bundle next to a failure, because the project is still in memory and a
 * file on disk is the way to keep it. It is a live region, so a change is
 * read out without stealing focus; a failure is announced assertively
 * because it is the one state that needs an action.
 *
 * Browser storage is not a backup, saved or not. The wording never says
 * "safe"; it says where the project is.
 */
export function useSaveStatus(): SaveStatus {
  return useSyncExternalStore(subscribeSaveStatus, getSaveStatus, getSaveStatus);
}

export function describeSaveStatus(status: SaveStatus): { label: string; detail: string | null; tone: 'idle' | 'live' | 'ok' | 'error' } {
  switch (status.state) {
    case 'idle':
      return { label: 'Not saved yet', detail: 'Saves to this browser after the first change.', tone: 'idle' };
    case 'saving':
      return { label: 'Saving…', detail: null, tone: 'live' };
    case 'saved':
      return { label: 'Saved', detail: `Saved to this browser at ${new Date(status.at).toLocaleTimeString()}. Export a bundle to keep a copy elsewhere.`, tone: 'ok' };
    case 'failed':
      return { label: 'Not saved', detail: status.message, tone: 'error' };
  }
}

export function SaveStatusIndicator({ compact = false }: { compact?: boolean }): React.ReactElement {
  const status = useSaveStatus();
  const { label, detail, tone } = describeSaveStatus(status);
  const failed = status.state === 'failed';
  return (
    <div
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      data-save-state={status.state}
      title={detail ?? undefined}
      style={{ ...styles.box, ...(compact ? styles.boxCompact : {}) }}
    >
      <span aria-hidden="true" style={{ ...styles.dot, background: dotColour(tone) }} />
      <span style={styles.label}>
        {label}
        {failed && !compact && <span style={styles.detail}> — {detail}</span>}
      </span>
      {failed && (
        <button type="button" onClick={() => void exportCurrentProject()} style={styles.exportBtn} title="Export the project in memory as a .softn file">
          <Icon name="export" size={12} />
          <span>Export bundle</span>
        </button>
      )}
    </div>
  );
}

function dotColour(tone: 'idle' | 'live' | 'ok' | 'error'): string {
  switch (tone) {
    case 'idle':
      return 'var(--studio-text-dim)';
    case 'live':
      return 'var(--studio-live)';
    case 'ok':
      return 'var(--studio-success)';
    case 'error':
      return 'var(--studio-error)';
  }
}

const styles: Record<string, React.CSSProperties> = {
  box: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    padding: '4px 10px',
    borderRadius: 999,
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-panel)',
    color: 'var(--studio-text-muted)',
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    maxWidth: 'min(420px, 100%)',
  },
  boxCompact: {
    padding: '2px 8px',
    maxWidth: '100%',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
  },
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--studio-text)',
    fontWeight: 600,
  },
  detail: {
    fontWeight: 400,
    color: 'var(--studio-text-muted)',
  },
  exportBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    borderRadius: 999,
    border: '1px solid var(--studio-accent)',
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-text)',
    fontFamily: 'inherit',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    flexShrink: 0,
  },
};
