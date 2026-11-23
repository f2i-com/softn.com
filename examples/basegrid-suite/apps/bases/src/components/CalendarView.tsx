import React, { useState } from 'react';
import { getPillTheme } from '../../../../shared/ui/format';
import { IconPlus } from '../../../../shared/ui/icons';
import { getRecordTitle, resolveFieldValue, type WorkspaceIndex } from '../formula';
import type { FieldMeta, RecordRow } from '../types';

interface CalendarViewProps {
  fields: FieldMeta[];
  records: RecordRow[];
  idx: WorkspaceIndex;
  dateField: FieldMeta | null;
  statusField: FieldMeta | null;
  onOpenRecord: (record: RecordRow) => void;
  onAddRecordOnDate: (dateFieldId: number, isoDate: string) => Promise<void>;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  records,
  idx,
  dateField,
  statusField,
  onOpenRecord,
  onAddRecordOnDate,
}) => {
  // Default to November 2026 where seeded dates live (or current date if records are elsewhere)
  const [cursor, setCursor] = useState<{ year: number; month: number }>(() => {
    if (dateField) {
      for (const r of records) {
        const s = String(resolveFieldValue(r, dateField, idx) ?? '');
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
          return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) - 1 };
        }
      }
    }
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  if (!dateField) {
    return (
      <div className="empty-state">
        <strong>No Date field in this table.</strong>
        <span>Add a Date field to visualize records on the Calendar.</span>
      </div>
    );
  }

  const firstDayOfMonth = new Date(cursor.year, cursor.month, 1);
  const startOffset = firstDayOfMonth.getDay();
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  const eventsByDate = new Map<string, RecordRow[]>();
  for (const r of records) {
    const raw = String(resolveFieldValue(r, dateField, idx) ?? '').slice(0, 10);
    if (!raw) continue;
    const list = eventsByDate.get(raw) ?? [];
    list.push(r);
    eventsByDate.set(raw, list);
  }

  const todayIso = new Date().toISOString().slice(0, 10);

  const shiftMonth = (delta: number) => {
    const d = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() });
  };

  return (
    <div className="calendar-wrap">
      <div className="view-toolbar" style={{ borderBottom: 'none' }}>
        <div className="view-toolbar-group">
          <button type="button" className="btn btn-sm" onClick={() => shiftMonth(-1)}>← Prev</button>
          <strong style={{ fontSize: 15, minWidth: 145, textAlign: 'center' }}>
            {MONTH_NAMES[cursor.month]} {cursor.year}
          </strong>
          <button type="button" className="btn btn-sm" onClick={() => shiftMonth(1)}>Next →</button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setCursor({ year: 2026, month: 10 })}
          >
            Jump to Launch Month
          </button>
        </div>
        <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
          Plotted by <strong>{dateField.name}</strong> · Click any day&apos;s + to schedule a record
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', background: '#f9fafb', borderTop: '1px solid var(--border)' }}>
        {DAY_NAMES.map((d) => (
          <div key={d} style={{ padding: '7px 10px', fontSize: 11.5, fontWeight: 700, color: 'var(--ink-muted)', textTransform: 'uppercase' }}>
            {d}
          </div>
        ))}
      </div>

      <div className="calendar-grid">
        {Array.from({ length: totalCells }).map((_, cellIdx) => {
          const dayNum = cellIdx - startOffset + 1;
          const cellDate = new Date(cursor.year, cursor.month, dayNum);
          const inMonth = cellDate.getMonth() === cursor.month;
          const iso = `${cellDate.getFullYear()}-${pad2(cellDate.getMonth() + 1)}-${pad2(cellDate.getDate())}`;
          const items = eventsByDate.get(iso) ?? [];

          return (
            <div key={iso} className={`calendar-day ${inMonth ? '' : 'other-month'} ${iso === todayIso ? 'today' : ''}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: iso === todayIso ? 800 : 600 }}>
                  {cellDate.getDate()}
                </span>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  style={{ padding: '1px 4px', opacity: 0.55 }}
                  title={`Add record on ${iso}`}
                  onClick={() => void onAddRecordOnDate(dateField.id, iso)}
                >
                  <IconPlus size={11} />
                </button>
              </div>
              {items.map((rec) => {
                const status = statusField ? String(resolveFieldValue(rec, statusField, idx) ?? '') : '';
                const pill = getPillTheme(status || getRecordTitle(rec, idx));
                return (
                  <button
                    key={rec.id}
                    type="button"
                    className="calendar-event"
                    style={{ background: pill.bg, color: pill.fg, borderLeft: `3px solid ${pill.dot}` }}
                    onClick={() => onOpenRecord(rec)}
                  >
                    {getRecordTitle(rec, idx)}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};
