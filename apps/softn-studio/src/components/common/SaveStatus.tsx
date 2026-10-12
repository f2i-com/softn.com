import { isHostedEditor, requestHostedSave } from '@softn/editor-shared/hostedEditor';
import React, { useId, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from './Icon';
import { closeDeletedProject, getSaveStatus, keepDeletedProject, keepThisTabsVersion, subscribeSaveStatus, type SaveStatus } from '../../lib/projectSession';
import { beginReplacingProject } from '../../lib/replaceProject';
import { useWorkspaceStore } from '../../stores';
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
function useSaveStatus(): SaveStatus {
  return useSyncExternalStore(subscribeSaveStatus, getSaveStatus, getSaveStatus);
}

function describeSaveStatus(status: SaveStatus): { label: string; detail: string | null; tone: 'idle' | 'live' | 'ok' | 'error' } {
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

/**
 * Hosted in FormLogic (audit SN-04): the button reports what actually
 * happened — sent and acknowledged, refused, or not connected — instead of
 * silently returning after a click that reached nobody.
 */
function HostedDraftButton(): React.ReactElement {
  const [state, setState] = useState<{ label: string; error?: string; busy: boolean }>({ label: 'FormLogic draft', busy: false });
  const send = async () => {
    if (state.busy) return;
    const hosted = requestHostedSave();
    if (!hosted.handled) {
      setState({ label: 'FormLogic draft', error: hosted.reason === 'disconnected' ? 'FormLogic is not connected. Your project stays in Studio; try again in a moment.' : 'Not hosted in FormLogic.', busy: false });
      return;
    }
    setState({ label: 'Sending to FormLogic…', busy: true });
    const result = await hosted.completion;
    setState(result.ok
      ? { label: 'Returned to FormLogic draft', busy: false }
      : { label: 'FormLogic draft', error: result.error ?? 'FormLogic could not take the draft. Your project is still here.', busy: false });
  };
  return (
    <span role={state.error ? 'alert' : 'status'} aria-live={state.error ? 'assertive' : 'polite'} style={styles.box} title={state.error ?? 'Return your changes to FormLogic'}>
      <button type="button" onClick={() => void send()} disabled={state.busy} style={{ ...styles.exportBtn, cursor: state.busy ? 'progress' : 'pointer' }}>{state.label}</button>
      {state.error && <span style={styles.detail}> — {state.error}</span>}
    </span>
  );
}

export function SaveStatusIndicator({ compact = false }: { compact?: boolean }): React.ReactElement {
  const status = useSaveStatus();
  const { label, detail, tone } = describeSaveStatus(status);
  if (isHostedEditor()) return <HostedDraftButton />;
  const failed = status.state === 'failed';
  const deleted = status.state === 'failed' && status.reason === 'deleted';
  return (
    <div
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      data-save-state={status.state}
      title={detail ?? undefined}
      style={{ ...styles.box, ...(compact ? styles.boxCompact : {}) }}
    >
      <span aria-hidden="true" style={{ ...styles.dot, background: dotColour(tone) }} />
      {/* On a phone the bar has room for neither the reason nor two buttons beside it: the
          reason is the button, and Keep it and Close it are under it. */}
      {deleted && compact ? (
        <DeletedChoice message={status.message} />
      ) : (
        /* "Not saved" keeps its room in the desktop bar, where the reason after it gives way
           first. On a phone the dot says it, and the bar keeps its room for the button beside it. */
        <span style={failed && !compact ? { ...styles.label, minWidth: '4.25rem' } : styles.label}>
          {label}
          {failed && !compact && <span style={styles.detail}> — {detail}</span>}
        </span>
      )}
      {failed && status.parts && (
        <button type="button" onClick={() => void keepThisTabsVersion()} style={styles.exportBtn} title={`Save this tab’s version of ${status.parts} over the one saved in the other tab`}>
          <span>Keep this tab’s version</span>
        </button>
      )}
      {/* Deleted in another tab: kept (saved here again) or closed, as the person says. Until
          then nothing is saved over the deletion, and nothing here is lost. */}
      {deleted && !compact && (
        <>
          <button type="button" onClick={() => void keepDeletedProject()} style={styles.exportBtn} title="Save this project to this browser again, as it is in this tab">
            <span>Keep it</span>
          </button>
          <button type="button" onClick={closeDeleted} style={styles.exportBtn} title="Close this project without saving it again">
            <span>Close it</span>
          </button>
        </>
      )}
      {/* With Keep this tab's version there is room for one of the two, and the bar it sits in
          has Export bundle beside it (the desktop bar's button, the phone's project menu). */}
      {failed && !status.parts && status.reason !== 'deleted' && (
        <button type="button" onClick={() => void exportCurrentProject()} style={styles.exportBtn} title="Export the project in memory as a .softn file">
          <Icon name="export" size={12} />
          <span>Export bundle</span>
        </button>
      )}
    </div>
  );
}

/** The phone's bar for a project deleted in another tab: what happened, and the two ways on under it. */
function DeletedChoice({ message }: { message: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  return (
    <span
      style={styles.choice}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
        toggle.current?.focus();
      }}
    >
      <button ref={toggle} type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)} style={{ ...styles.exportBtn, flexShrink: 1, minWidth: 0, maxWidth: '100%' }}>
        <span style={styles.choiceLabel}>Deleted in another tab</span>
      </button>
      {open && (
        <span id={panelId} role="group" aria-label="Deleted in another tab" style={styles.choicePanel}>
          <span>{message}</span>
          <span style={styles.choiceActions}>
            <button type="button" onClick={() => void keepDeletedProject()} style={styles.exportBtn}>
              <span>Keep it</span>
            </button>
            <button type="button" onClick={closeDeleted} style={styles.exportBtn}>
              <span>Close it</span>
            </button>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * Close a project another tab deleted. This tab holds its only copy, so the
 * person is asked once more; a draft being edited by hand is asked about, and
 * a run working on the project is stopped, as for any project that goes.
 */
function closeDeleted(): void {
  const name = useWorkspaceStore.getState().projectName.trim() || 'This project';
  if (!window.confirm(`Close ${name}? It was deleted in another tab, so what is in this tab is its only copy. Use Export bundle first to keep one.`)) return;
  if (beginReplacingProject() === null) return;
  closeDeletedProject();
}

function dotColour(tone: 'idle' | 'live' | 'ok' | 'error'): string {
  switch (tone) {
    case 'idle':
      return 'var(--studio-text-dim)';
    case 'live':
      return 'var(--studio-live)';
    case 'ok':
      // Saved is a state of storage, not something running: no mint.
      return 'var(--studio-text-dim)';
    case 'error':
      return 'var(--studio-error)';
  }
}

const styles: Record<string, React.CSSProperties> = {
  box: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    minWidth: 0,
    padding: '4px 8px',
    borderRadius: 6,
    color: 'var(--studio-text-muted)',
    fontSize: 12.5,
    // A length, not a share of the bar: a percentage of a row sized by its content does not
    // limit how wide the box asks to be, so a long failure asked for the whole bar and the
    // project's name beside it was squeezed to a letter (the name shrinks in proportion).
    maxWidth: 420,
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
    color: 'var(--studio-text-muted)',
    fontWeight: 500,
  },
  detail: {
    fontWeight: 400,
    color: 'var(--studio-text-muted)',
  },
  choice: {
    position: 'relative',
    display: 'inline-flex',
    flex: '0 1 auto',
    minWidth: 0,
  },
  choiceLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  choicePanel: {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    right: 0,
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    width: 'min(18rem, calc(100vw - 32px))',
    padding: 12,
    borderRadius: 8,
    border: '1px solid var(--studio-border-strong)',
    background: 'var(--studio-bg-elevated)',
    color: 'var(--studio-text)',
    fontSize: 13,
    lineHeight: 1.45,
    whiteSpace: 'normal',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
  },
  choiceActions: {
    display: 'flex',
    gap: 8,
  },
  exportBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    borderRadius: 999,
    border: '1px solid var(--studio-border-strong)',
    background: 'var(--studio-bg-elevated)',
    color: 'var(--studio-text)',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
};
