import React, { useMemo, useState } from 'react';
import { useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import type { VFSEvent } from '../../types/studio';

/**
 * One row of the timeline: an undo unit. A single edit is a unit of one
 * event; an AI turn or an import is a unit of many, under one
 * transactionId. The panel used to list events, so an AI turn that touched
 * three files was three rows, and "Undo Last" — which already undid the
 * whole unit — looked as if it would undo one of them.
 */
export interface HistoryUnit {
  /** The transaction id, or a synthetic key for an event recorded without one. */
  key: string;
  transactionId: string | undefined;
  events: VFSEvent[];
  source: 'user' | 'ai';
  timestamp: number;
  /** Whether revertTransaction would put this unit back: nothing later touched its files. */
  revertible: boolean;
}

/** The history as units, oldest first, with each unit's revertibility worked out from what follows it. */
export function groupHistory(history: VFSEvent[]): HistoryUnit[] {
  const units: HistoryUnit[] = [];
  let i = 0;
  while (i < history.length) {
    const id = history[i].transactionId;
    let end = i + 1;
    if (id !== undefined) while (end < history.length && history[end].transactionId === id) end++;
    const events = history.slice(i, end);
    const paths = new Set(events.map((e) => e.path));
    let revertible = id !== undefined;
    for (let k = end; revertible && k < history.length; k++) if (paths.has(history[k].path)) revertible = false;
    units.push({
      key: id ?? `event-${i}-${history[i].path}-${history[i].timestamp}`,
      transactionId: id,
      events,
      source: events[0].source,
      timestamp: events[0].timestamp,
      revertible,
    });
    i = end;
  }
  return units;
}

/** What a unit was: "AI turn", "Import", or the one edit it holds. */
export function describeUnit(unit: HistoryUnit): { title: string; detail: string } {
  const paths = [...new Set(unit.events.map((e) => e.path))];
  if (unit.events.length === 1) {
    return { title: unit.events[0].type, detail: paths[0] };
  }
  const allCreates = unit.events.every((e) => e.type === 'create');
  const title = unit.source === 'ai' ? 'AI turn' : allCreates ? 'Import' : 'Edit';
  const shown = paths.slice(0, 3).join(', ');
  const more = paths.length > 3 ? `, +${paths.length - 3} more` : '';
  return { title: `${title} · ${paths.length} file${paths.length === 1 ? '' : 's'}`, detail: `${shown}${more}` };
}

export const HistoryPanel: React.FC = () => {
  const { history, revertAIChanges, undoLast, revertTransaction } = useVFSStore();
  const [notice, setNotice] = useState<string | null>(null);

  const units = useMemo(() => groupHistory(history), [history]);
  const aiUnits = units.filter((u) => u.source === 'ai');

  const revert = (unit: HistoryUnit) => {
    if (!unit.transactionId) return;
    const result = revertTransaction(unit.transactionId);
    setNotice(result.ok ? `Reverted ${result.paths.length} file${result.paths.length === 1 ? '' : 's'}.` : result.reason);
  };

  return (
    <div style={styles.container}>
      {history.length === 0 ? (
        <div style={styles.empty}>
          <Icon name="clock" size={24} color="var(--studio-text-dim)" />
          <p style={styles.emptyText}>No history</p>
          <p style={styles.emptyHint}>
            File changes will be recorded here for undo/redo.
          </p>
        </div>
      ) : (
        <>
          {/* Actions */}
          <div style={styles.actions}>
            <button onClick={() => { setNotice(null); undoLast(); }} style={styles.actionBtn} title="Undo the most recent unit: an edit, an import or a whole AI turn">
              <Icon name="undo" size={14} />
              Undo Last
            </button>
            {aiUnits.length > 0 && (
              <button onClick={() => { setNotice(null); revertAIChanges(); }} style={{ ...styles.actionBtn, color: 'var(--studio-error)' }}>
                <Icon name="undo" size={14} color="var(--studio-error)" />
                Revert AI Changes
              </button>
            )}
          </div>

          <div aria-live="polite" role="status" style={notice ? styles.notice : undefined}>
            {notice}
          </div>

          {/* Timeline: one row per unit, newest first */}
          <ul style={styles.timeline} aria-label="History">
            {[...units].reverse().slice(0, 50).map((unit) => {
              const { title, detail } = describeUnit(unit);
              const canRevert = unit.transactionId !== undefined;
              return (
                <li key={unit.key} data-history-unit={unit.key} style={styles.timelineItem}>
                  <div style={{
                    ...styles.dot,
                    background: unit.source === 'ai' ? 'var(--studio-accent)' : 'var(--studio-text-dim)',
                  }} />
                  <div style={styles.eventInfo}>
                    <span style={styles.eventType}>{title}</span>
                    <span style={styles.eventPath} title={detail}>{detail}</span>
                  </div>
                  <span style={styles.eventTime}>
                    {new Date(unit.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {canRevert && (
                    <button
                      type="button"
                      onClick={() => revert(unit)}
                      disabled={!unit.revertible}
                      aria-label={`Revert ${title}`}
                      title={unit.revertible ? 'Put back what this unit changed' : 'A later change touched one of these files. Undo that first, or revert by hand.'}
                      style={{ ...styles.revertBtn, opacity: unit.revertible ? 1 : 0.4, cursor: unit.revertible ? 'pointer' : 'default' }}
                    >
                      Revert
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  empty: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    padding: 24, textAlign: 'center', gap: 4,
  },
  emptyText: { fontSize: 13, color: 'var(--studio-text-dim)', margin: '8px 0 0' },
  emptyHint: { fontSize: 11, color: 'var(--studio-text-dim)', lineHeight: 1.4, margin: '4px 0 12px' },
  actions: {
    display: 'flex', gap: 6, padding: '8px 12px',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  actionBtn: {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '6px 10px', border: '1px solid var(--studio-border)',
    borderRadius: 6, background: 'transparent',
    color: 'var(--studio-text-muted)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
  },
  notice: {
    padding: '6px 12px', fontSize: 11, color: 'var(--studio-text-muted)',
    borderBottom: '1px solid var(--studio-border-subtle)',
  },
  timeline: {
    flex: 1, overflow: 'auto', minHeight: 0, padding: '8px 12px',
    listStyle: 'none', margin: 0,
  },
  timelineItem: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 0', borderBottom: '1px solid var(--studio-border-subtle)',
  },
  dot: {
    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
  },
  eventInfo: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0,
  },
  eventType: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 11, fontWeight: 600, color: 'var(--studio-text-muted)', textTransform: 'capitalize' as const,
  },
  eventPath: {
    fontSize: 10, color: 'var(--studio-text-dim)', fontFamily: 'var(--studio-mono)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  eventTime: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 10, color: 'var(--studio-text-dim)', flexShrink: 0,
  },
  revertBtn: {
    padding: '3px 8px', border: '1px solid var(--studio-border)',
    borderRadius: 5, background: 'transparent',
    color: 'var(--studio-text-muted)', fontSize: 10, fontFamily: 'inherit', flexShrink: 0,
  },
};
