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
interface HistoryUnit {
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

const SINGLE: Record<VFSEvent['type'], string> = { create: 'Created', update: 'Edited', patch: 'Edited', delete: 'Deleted' };

/** What a unit was: "AI turn", "Import", or the one edit it holds. */
export function describeUnit(unit: HistoryUnit): { title: string; detail: string } {
  const paths = [...new Set(unit.events.map((e) => e.path))];
  if (unit.events.length === 1) {
    return { title: `${unit.source === 'ai' ? 'AI · ' : ''}${SINGLE[unit.events[0].type] ?? unit.events[0].type}`, detail: paths[0] };
  }
  const allCreates = unit.events.every((e) => e.type === 'create');
  const title = unit.source === 'ai' ? 'AI turn' : allCreates ? 'Import' : 'Edit';
  const shown = paths.slice(0, 3).join(', ');
  const more = paths.length > 3 ? `, +${paths.length - 3} more` : '';
  return { title: `${title} · ${paths.length} file${paths.length === 1 ? '' : 's'}`, detail: `${shown}${more}` };
}

/**
 * The project's changes as undo units, newest first. Undo last takes back
 * the newest unit whole; Revert puts back one unit, when nothing later
 * touched its files; Revert AI changes takes back every AI turn.
 */
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

  if (history.length === 0) {
    return (
      <div className="st-history">
        <div className="st-panel-empty">
          <Icon name="clock" size={22} />
          <strong>No changes yet</strong>
          <span>Every edit, import and AI turn is kept here, so any of them can be undone.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="st-history">
      <div className="st-history-actions">
        <button type="button" className="st-btn st-btn-sm" onClick={() => { setNotice(null); undoLast(); }} title="Undo the most recent unit: an edit, an import or a whole AI turn">
          <Icon name="undo" size={14} />
          Undo last
        </button>
        {aiUnits.length > 0 && (
          <button type="button" className="st-btn st-btn-sm st-btn-ghost" onClick={() => { setNotice(null); revertAIChanges(); }} title="Take back every change the AI made">
            Revert AI changes
          </button>
        )}
      </div>

      <div aria-live="polite" role="status" className={notice ? 'st-history-notice' : undefined}>
        {notice}
      </div>

      {/* Timeline: one row per unit, newest first */}
      <ul className="st-history-list" aria-label="History">
        {[...units].reverse().slice(0, 50).map((unit) => {
          const { title, detail } = describeUnit(unit);
          const canRevert = unit.transactionId !== undefined;
          return (
            <li key={unit.key} data-history-unit={unit.key} data-source={unit.source} className="st-history-item">
              <span className="st-history-dot" aria-hidden="true" />
              <span className="st-history-text">
                <span className="st-history-title">{title}</span>
                <span className="st-history-detail" title={detail}>{detail}</span>
              </span>
              <span className="st-history-time">
                {new Date(unit.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              {canRevert && (
                <button
                  type="button"
                  className="st-btn st-btn-sm st-history-revert"
                  onClick={() => revert(unit)}
                  disabled={!unit.revertible}
                  aria-label={`Revert ${title}`}
                  title={unit.revertible ? 'Put back what this unit changed' : 'A later change touched one of these files. Undo that first, or revert by hand.'}
                >
                  Revert
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
