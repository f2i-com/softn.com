import React, { useMemo, useState } from 'react';
import { useAIStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import type { VFSEvent } from '../../types/studio';

/**
 * One row of the timeline: an undo unit. A single edit is a unit of one
 * event; an AI turn is a unit of many, under one
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

/**
 * What a unit was: "AI turn", "Added", "Edit", or the one edit it holds. Opening a project (an
 * example, an import, a saved one) is not a unit: it is where the history starts.
 */
export function describeUnit(unit: HistoryUnit): { title: string; detail: string } {
  const paths = [...new Set(unit.events.map((e) => e.path))];
  // What the person did in the Files panel says what it was: "Renamed logo.png to brand.png",
  // not "Edit · 2 files" for the delete and the create a rename is made of.
  const label = unit.events[0].label;
  if (label) {
    const named = paths.slice(0, 3).join(', ');
    return { title: label, detail: `${named}${paths.length > 3 ? `, +${paths.length - 3} more` : ''}` };
  }
  if (unit.events.length === 1) {
    return { title: `${unit.source === 'ai' ? 'AI · ' : ''}${SINGLE[unit.events[0].type] ?? unit.events[0].type}`, detail: paths[0] };
  }
  const allCreates = unit.events.every((e) => e.type === 'create');
  const title = unit.source === 'ai' ? 'AI turn' : allCreates ? 'Added' : 'Edit';
  const shown = paths.slice(0, 3).join(', ');
  const more = paths.length > 3 ? `, +${paths.length - 3} more` : '';
  return { title: `${title} · ${paths.length} file${paths.length === 1 ? '' : 's'}`, detail: `${shown}${more}` };
}

/**
 * The project's changes as undo units, newest first. Undo last takes back
 * the newest unit whole; Revert puts back one unit, when nothing later
 * touched its files; Revert AI changes takes back the AI turns made since
 * the person's newest change, and is offered while there are any.
 *
 * Nothing here changes a file while a run is working, as nothing else done by
 * hand does (lib/fileOps.ts): Undo last, pressed to take back the person's own
 * edit, took the step the AI had made a moment before.
 */
export const HistoryPanel: React.FC = () => {
  const { history, undoStack, revertAIChanges, undoLast, redoLast, revertTransaction } = useVFSStore();
  const busy = useAIStore((s) => s.agentState === 'building');
  const [notice, setNotice] = useState<string | null>(null);

  const units = useMemo(() => groupHistory(history), [history]);
  const newestByAI = units.at(-1)?.source === 'ai';

  const revert = (unit: HistoryUnit) => {
    if (!unit.transactionId || busy) return;
    const result = revertTransaction(unit.transactionId);
    setNotice(result.ok ? `Reverted ${result.paths.length} file${result.paths.length === 1 ? '' : 's'}.` : result.reason);
  };

  // What Undo last and Revert AI changes took can be put back until the next change is made.
  // The store always could; nothing here asked it to, so one press too many was final, and
  // when the press took the last unit the panel had only "No changes yet" to say.
  const redo = undoStack.length > 0 && (
    <button type="button" className="st-btn st-btn-sm" disabled={busy} onClick={() => { setNotice(null); redoLast(); }} title="Put back the unit that was undone last">
      <Icon name="redo" size={14} />
      Redo
    </button>
  );
  const waiting = busy && <p className="st-history-notice" role="note">The AI is working, and may be reading or writing these files. Undo and revert wait until the run stops.</p>;

  if (history.length === 0) {
    return (
      <div className="st-history">
        {redo && <div className="st-history-actions">{redo}</div>}
        {waiting}
        <div className="st-panel-empty">
          <Icon name="clock" size={22} />
          <strong>{redo ? 'Everything here was undone' : 'No changes yet'}</strong>
          {/* Opening a project is not a change to it, so a project just opened has nothing to undo. */}
          <span>{redo ? 'Redo puts it back, one unit at a time, until the next change is made.' : 'Each edit and each AI turn from here on is kept here, so any of them can be undone.'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="st-history">
      <div className="st-history-actions">
        <button type="button" className="st-btn st-btn-sm" disabled={busy} onClick={() => { setNotice(null); undoLast(); }} title="Undo the most recent unit: an edit or a whole AI turn">
          <Icon name="undo" size={14} />
          Undo last
        </button>
        {redo}
        {newestByAI && (
          <button type="button" className="st-btn st-btn-sm st-btn-ghost" disabled={busy} onClick={() => { setNotice(null); revertAIChanges(); }} title="Take back the AI’s changes made since your newest change">
            Revert AI changes
          </button>
        )}
      </div>
      {waiting}

      <div aria-live="polite" role="status" className={notice ? 'st-history-notice' : undefined}>
        {notice}
      </div>

      {/* Timeline: one row per unit, newest first */}
      <ul className="st-history-list" aria-label="History">
        {[...units].reverse().slice(0, 50).map((unit) => {
          const { title, detail } = describeUnit(unit);
          const canRevert = unit.transactionId !== undefined;
          const time = new Date(unit.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return (
            <li key={unit.key} data-history-unit={unit.key} data-source={unit.source} className="st-history-item">
              <span className="st-history-dot" aria-hidden="true" />
              <span className="st-history-text">
                <span className="st-history-title">{title}</span>
                <span className="st-history-detail" title={detail}>{detail}</span>
              </span>
              <span className="st-history-time">
                {time}
              </span>
              {canRevert && (
                <button
                  type="button"
                  className="st-btn st-btn-sm st-history-revert"
                  onClick={() => revert(unit)}
                  disabled={!unit.revertible || busy}
                  // What and when: every single edit's button was "Revert Edited".
                  aria-label={`Revert ${title}: ${detail}, ${time}`}
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
