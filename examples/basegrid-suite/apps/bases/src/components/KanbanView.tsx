import React, { useState } from 'react';
import { formatDateShort, formatMoney, getPillTheme } from '../../../../shared/ui/format';
import { IconPlus } from '../../../../shared/ui/icons';
import { getRecordTitle, resolveFieldValue, type WorkspaceIndex } from '../formula';
import type { FieldMeta, RecordRow } from '../types';

interface KanbanViewProps {
  fields: FieldMeta[];
  records: RecordRow[];
  idx: WorkspaceIndex;
  groupField: FieldMeta | null;
  onMoveRecord: (recordId: number, fieldId: number, newStage: string) => Promise<void>;
  onOpenRecord: (record: RecordRow) => void;
  onAddRecordWithStage: (fieldId: number, stage: string) => Promise<void>;
}

export const KanbanView: React.FC<KanbanViewProps> = ({
  fields,
  records,
  idx,
  groupField,
  onMoveRecord,
  onOpenRecord,
  onAddRecordWithStage,
}) => {
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);

  if (!groupField) {
    return (
      <div className="empty-state">
        <strong>No Single Select field available for Kanban grouping.</strong>
        <span>Add a Single Select field (like Status or Stage) to organize cards in columns.</span>
      </div>
    );
  }

  const choices = groupField.options.choices ?? [];
  const dynamicValues = Array.from(
    new Set(
      records
        .map((r) => String(resolveFieldValue(r, groupField, idx) ?? '').trim())
        .filter(Boolean)
    )
  );
  const columns = Array.from(new Set([...choices, ...dynamicValues]));
  if (columns.length === 0) columns.push('Uncategorized');

  const currencyField = fields.find((f) => f.field_type === 'currency') ?? null;
  const dateField = fields.find((f) => f.field_type === 'date') ?? null;
  const ratingField = fields.find((f) => f.field_type === 'rating') ?? null;
  const badgeFields = fields
    .filter((f) => f.id !== groupField.id && (f.field_type === 'single_select' || f.field_type === 'multi_select'))
    .slice(0, 2);

  return (
    <div className="kanban-board">
      {columns.map((stage, colIdx) => {
        const colRecords = records.filter(
          (r) => String(resolveFieldValue(r, groupField, idx) ?? '') === stage
        );
        const colSum = currencyField
          ? colRecords.reduce((acc, r) => acc + (Number(resolveFieldValue(r, currencyField, idx)) || 0), 0)
          : 0;
        const theme = getPillTheme(stage);

        return (
          <div
            key={stage}
            className="kanban-col"
            style={{
              outline: dropCol === stage ? '2px dashed #2563eb' : 'none',
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDropCol(stage);
            }}
            onDragLeave={() => setDropCol(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropCol(null);
              if (draggingId !== null) {
                void onMoveRecord(draggingId, groupField.id, stage);
                setDraggingId(null);
              }
            }}
          >
            <div className="kanban-col-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span className="pill" style={{ background: theme.bg, color: theme.fg, borderColor: theme.border }}>
                  <span className="pill-dot" style={{ background: theme.dot }} />
                  {stage}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-muted)' }}>
                  {colRecords.length}
                </span>
              </div>
              {currencyField && colSum > 0 && (
                <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                  {formatMoney(colSum, currencyField.options.symbol || '$')}
                </span>
              )}
            </div>

            <div className="kanban-cards">
              {colRecords.map((rec) => {
                const title = getRecordTitle(rec, idx);
                const moneyVal = currencyField ? Number(resolveFieldValue(rec, currencyField, idx)) || 0 : 0;
                const dateVal = dateField ? String(resolveFieldValue(rec, dateField, idx) ?? '') : '';
                const ratingVal = ratingField ? Number(resolveFieldValue(rec, ratingField, idx)) || 0 : 0;

                return (
                  <div
                    key={rec.id}
                    className="kanban-card"
                    draggable
                    onDragStart={() => setDraggingId(rec.id)}
                    onDragEnd={() => { setDraggingId(null); setDropCol(null); }}
                    onClick={() => onOpenRecord(rec)}
                  >
                    <div style={{ fontWeight: 650, fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.35 }}>
                      {title}
                    </div>

                    {badgeFields.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {badgeFields.map((bf) => {
                          const raw = resolveFieldValue(rec, bf, idx);
                          const arr = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
                          return arr.slice(0, 3).map((item) => {
                            const t = getPillTheme(item);
                            return (
                              <span key={`${bf.id}-${item}`} className="pill" style={{ background: t.bg, color: t.fg, borderColor: t.border, fontSize: 11 }}>
                                {item}
                              </span>
                            );
                          });
                        })}
                      </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-muted)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {moneyVal > 0 && (
                          <strong style={{ color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>
                            {formatMoney(moneyVal, currencyField?.options.symbol || '$')}
                          </strong>
                        )}
                        {dateVal && <span>{formatDateShort(dateVal)}</span>}
                      </div>
                      {ratingVal > 0 && (
                        <span style={{ color: '#f59e0b', letterSpacing: 1 }}>
                          {'★'.repeat(Math.min(5, ratingVal))}
                        </span>
                      )}
                    </div>

                    <div
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 6, borderTop: '1px solid #f1f5f9' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        disabled={colIdx === 0}
                        onClick={() => void onMoveRecord(rec.id, groupField.id, columns[colIdx - 1])}
                      >
                        ← Prev
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        disabled={colIdx === columns.length - 1}
                        onClick={() => void onMoveRecord(rec.id, groupField.id, columns[colIdx + 1])}
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ justifyContent: 'flex-start', color: 'var(--ink-secondary)' }}
              onClick={() => void onAddRecordWithStage(groupField.id, stage)}
            >
              <IconPlus size={13} /> Add card
            </button>
          </div>
        );
      })}
    </div>
  );
};
