import React, { useState } from 'react';
import { formatDateShort, getPillTheme } from '../../../../shared/ui/format';
import { getRecordTitle, resolveFieldValue, type WorkspaceIndex } from '../formula';
import type { FieldMeta, RecordRow } from '../types';

interface TimelineViewProps {
  records: RecordRow[];
  idx: WorkspaceIndex;
  startField: FieldMeta | null;
  endField: FieldMeta | null;
  statusField: FieldMeta | null;
  onOpenRecord: (record: RecordRow) => void;
}

function parseIsoDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

export const TimelineView: React.FC<TimelineViewProps> = ({
  records,
  idx,
  startField,
  endField,
  statusField,
  onOpenRecord,
}) => {
  const [zoom, setZoom] = useState<'quarter' | 'half'>('quarter');

  const activeStart = startField ?? endField;
  const activeEnd = endField ?? startField;

  if (!activeStart || !activeEnd) {
    return (
      <div className="empty-state">
        <strong>Timeline / Gantt requires at least one Date field.</strong>
        <span>Add Start Date and Launch Date fields to plot Gantt schedule bars.</span>
      </div>
    );
  }

  const plotted = records.map((rec) => {
    const sRaw = String(resolveFieldValue(rec, activeStart, idx) ?? '');
    const eRaw = String(resolveFieldValue(rec, activeEnd, idx) ?? '');
    const sDay = parseIsoDay(sRaw || eRaw);
    const eDay = parseIsoDay(eRaw || sRaw);
    return {
      rec,
      sRaw,
      eRaw,
      sDay: Number.isFinite(sDay) ? sDay : parseIsoDay('2026-11-01'),
      eDay: Number.isFinite(eDay) ? Math.max(eDay, (Number.isFinite(sDay) ? sDay : parseIsoDay('2026-11-01')) + 4) : parseIsoDay('2026-11-20'),
    };
  });

  const minDay = Math.min(...plotted.map((p) => p.sDay), parseIsoDay('2026-10-01')) - 5;
  const spanDays = zoom === 'quarter' ? 110 : 175;
  const todayDay = parseIsoDay('2026-11-22');
  const todayPct = ((todayDay - minDay) / spanDays) * 100;

  const monthTicks: Array<{ label: string; pct: number }> = [];
  const startDate = new Date(minDay * 86400000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + i, 1));
    const dayVal = d.getTime() / 86400000;
    const pct = ((dayVal - minDay) / spanDays) * 100;
    if (pct >= -4 && pct <= 98) {
      monthTicks.push({ label: `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`, pct: Math.max(0, pct) });
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#ffffff' }}>
      <div className="view-toolbar">
        <div className="view-toolbar-group">
          <strong style={{ fontSize: 13 }}>Gantt Schedule</strong>
          <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
            {activeStart.name} → {activeEnd.name}
          </span>
        </div>
        <div className="bg-segmented">
          <button type="button" className={`bg-seg-btn ${zoom === 'quarter' ? 'active' : ''}`} onClick={() => setZoom('quarter')}>
            Quarter Zoom
          </button>
          <button type="button" className={`bg-seg-btn ${zoom === 'half' ? 'active' : ''}`} onClick={() => setZoom('half')}>
            Half-Year Zoom
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ minWidth: 860 }}>
          {/* Timeline Header */}
          <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', borderBottom: '1px solid var(--border)', background: '#f9fafb', position: 'sticky', top: 0, zIndex: 4 }}>
            <div style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: 'var(--ink-secondary)', borderRight: '1px solid var(--border)' }}>
              Record &amp; Milestone Dates
            </div>
            <div style={{ position: 'relative', height: 38 }}>
              {monthTicks.map((t) => (
                <div
                  key={t.label}
                  style={{
                    position: 'absolute',
                    left: `${t.pct}%`,
                    top: 0,
                    bottom: 0,
                    borderLeft: '1px solid #e5e7eb',
                    padding: '10px 8px',
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: 'var(--ink-muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t.label}
                </div>
              ))}
            </div>
          </div>

          {/* Rows */}
          {plotted.map(({ rec, sRaw, eRaw, sDay, eDay }) => {
            const leftPct = Math.max(0, Math.min(94, ((sDay - minDay) / spanDays) * 100));
            const widthPct = Math.max(5, Math.min(100 - leftPct, ((eDay - sDay) / spanDays) * 100));
            const status = statusField ? String(resolveFieldValue(rec, statusField, idx) ?? '') : '';
            const pill = getPillTheme(status || getRecordTitle(rec, idx));
            const durationDays = Math.max(1, Math.round(eDay - sDay));

            return (
              <div
                key={rec.id}
                onClick={() => onOpenRecord(rec)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '260px 1fr',
                  borderBottom: '1px solid var(--border-subtle)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ padding: '11px 14px', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <strong style={{ fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getRecordTitle(rec, idx)}
                  </strong>
                  <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>
                    {formatDateShort(sRaw)} → {formatDateShort(eRaw)} ({durationDays}d)
                  </span>
                </div>
                <div style={{ position: 'relative', minHeight: 54, background: 'repeating-linear-gradient(90deg, transparent, transparent 14.2%, rgba(226,232,240,0.35) 14.2%, rgba(226,232,240,0.35) calc(14.2% + 1px))' }}>
                  {todayPct >= 0 && todayPct <= 100 && (
                    <div
                      style={{
                        position: 'absolute',
                        left: `${todayPct}%`,
                        top: 0,
                        bottom: 0,
                        width: 2,
                        background: 'rgba(239, 68, 68, 0.45)',
                        zIndex: 1,
                      }}
                    />
                  )}
                  <div
                    style={{
                      position: 'absolute',
                      top: 11,
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      height: 30,
                      borderRadius: 7,
                      background: pill.bg,
                      border: `1.5px solid ${pill.dot}`,
                      color: pill.fg,
                      padding: '0 10px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                      fontSize: 12,
                      fontWeight: 700,
                      zIndex: 2,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      boxShadow: '0 2px 6px rgba(15,23,42,0.06)',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {getRecordTitle(rec, idx)}
                    </span>
                    {status && <span style={{ fontSize: 10.5, opacity: 0.85 }}>{status}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
