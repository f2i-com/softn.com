import React, { useState } from 'react';
import {
  formatDateShort,
  formatMoney,
  formatNumber,
  formatPercent,
  getPillTheme,
} from '../../../../shared/ui/format';
import {
  IconCheck,
  IconLink,
  IconPlus,
  IconSparkles,
  IconTrash,
} from '../../../../shared/ui/icons';
import { getRecordTitle, resolveFieldValue, type WorkspaceIndex } from '../formula';
import type { FieldMeta, RecordRow, ViewConfig } from '../types';

interface GridViewProps {
  fields: FieldMeta[];
  records: RecordRow[];
  idx: WorkspaceIndex;
  config: ViewConfig;
  selectedIds: number[];
  onToggleSelect: (id: number) => void;
  onToggleSelectAll: () => void;
  onPatchCell: (recordId: number, fieldId: number, value: unknown) => Promise<void>;
  onOpenRecord: (record: RecordRow) => void;
  onAddRecord: () => Promise<void>;
  onOpenAddField: () => void;
  onRunAiField?: (record: RecordRow, field: FieldMeta) => Promise<void>;
  onChangeSummaryAgg: (fieldId: number, agg: 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT' | 'FILLED') => void;
  onDeleteField: (field: FieldMeta) => void;
}

const FIELD_TYPE_BADGE: Record<string, string> = {
  text: 'Aa',
  long_text: '¶',
  number: '#',
  currency: '$',
  percent: '%',
  checkbox: '✓',
  single_select: '◉',
  multi_select: '☰',
  date: '◷',
  rating: '★',
  email: '@',
  url: '↗',
  attachment: '◫',
  link: '⇄',
  lookup: '⇪',
  rollup: 'Σ',
  formula: 'fx',
  ai_agent: '✦',
};

function isNumericField(f: FieldMeta): boolean {
  return ['number', 'currency', 'percent', 'rating', 'rollup', 'formula'].includes(f.field_type);
}

export const GridView: React.FC<GridViewProps> = ({
  fields,
  records,
  idx,
  config,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onPatchCell,
  onOpenRecord,
  onAddRecord,
  onOpenAddField,
  onRunAiField,
  onChangeSummaryAgg,
  onDeleteField,
}) => {
  const [editing, setEditing] = useState<{ recId: number; fieldId: number } | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const hiddenSet = new Set(config.hiddenFieldIds ?? []);
  const visibleFields = fields.filter((f) => f.is_primary || !hiddenSet.has(f.id));
  const rowHeightClass =
    config.rowHeight === 'compact'
      ? 'row-compact'
      : config.rowHeight === 'tall'
        ? 'row-tall'
        : 'row-medium';

  const groupField = config.groupBy ? fields.find((f) => f.id === config.groupBy) ?? null : null;

  const grouped: Array<{ label: string; rows: RecordRow[] }> = [];
  if (groupField) {
    const map = new Map<string, RecordRow[]>();
    for (const r of records) {
      const v = resolveFieldValue(r, groupField, idx);
      const label = v === null || v === undefined || String(v).trim() === '' ? '(Empty)' : Array.isArray(v) ? v.join(', ') : String(v);
      const list = map.get(label) ?? [];
      list.push(r);
      map.set(label, list);
    }
    for (const [label, rows] of map.entries()) {
      grouped.push({ label, rows });
    }
  } else {
    grouped.push({ label: '', rows: records });
  }

  const startEdit = (rec: RecordRow, field: FieldMeta) => {
    if (['lookup', 'rollup', 'formula', 'link', 'checkbox', 'rating'].includes(field.field_type)) {
      if (field.field_type === 'link') onOpenRecord(rec);
      return;
    }
    const raw = rec.cells[String(field.id)];
    setEditing({ recId: rec.id, fieldId: field.id });
    if (Array.isArray(raw)) setDraft(raw.join(', '));
    else setDraft(raw === null || raw === undefined ? '' : String(raw));
  };

  const commitEdit = async (rec: RecordRow, field: FieldMeta) => {
    setEditing(null);
    let parsed: unknown = draft;
    if (['number', 'currency', 'percent'].includes(field.field_type)) {
      const n = Number(draft.replace(/[$,%\s,]/g, ''));
      parsed = Number.isFinite(n) ? n : 0;
    } else if (field.field_type === 'multi_select') {
      parsed = draft
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    await onPatchCell(rec.id, field.id, parsed);
  };

  const computeSummary = (field: FieldMeta): string => {
    const agg = config.summaryAgg?.[String(field.id)] ?? (isNumericField(field) ? 'SUM' : 'COUNT');
    if (agg === 'COUNT') return `Count ${records.length}`;
    if (agg === 'FILLED') {
      const filled = records.filter((r) => {
        const v = resolveFieldValue(r, field, idx);
        return v !== null && v !== undefined && String(v).trim() !== '' && (!Array.isArray(v) || v.length > 0);
      }).length;
      return `Filled ${records.length ? Math.round((filled / records.length) * 100) : 0}%`;
    }
    const nums = records
      .map((r) => Number(resolveFieldValue(r, field, idx)))
      .filter((n) => Number.isFinite(n));
    if (nums.length === 0) return '—';
    const val =
      agg === 'SUM'
        ? nums.reduce((a, b) => a + b, 0)
        : agg === 'AVG'
          ? nums.reduce((a, b) => a + b, 0) / nums.length
          : agg === 'MIN'
            ? Math.min(...nums)
            : Math.max(...nums);
    if (field.field_type === 'currency') return `${agg} ${formatMoney(val, field.options.symbol || '$')}`;
    if (field.field_type === 'percent') return `${agg} ${formatPercent(val)}`;
    return `${agg} ${formatNumber(val, agg === 'AVG' ? 1 : 0)}`;
  };

  const renderCell = (rec: RecordRow, field: FieldMeta) => {
    const isEditing = editing?.recId === rec.id && editing?.fieldId === field.id;
    const val = resolveFieldValue(rec, field, idx);

    if (isEditing) {
      if (field.field_type === 'single_select') {
        const choices = field.options.choices ?? [];
        return (
          <div style={{ padding: '3px 6px' }}>
            <select
              className="bg-cell-input"
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setEditing(null);
                void onPatchCell(rec.id, field.id, e.target.value);
              }}
              onBlur={() => setEditing(null)}
            >
              <option value="">(None)</option>
              {choices.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        );
      }
      return (
        <div style={{ padding: '3px 6px' }}>
          <input
            className="bg-cell-input"
            autoFocus
            type={field.field_type === 'date' ? 'date' : 'text'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitEdit(rec, field)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitEdit(rec, field);
              if (e.key === 'Escape') setEditing(null);
            }}
          />
        </div>
      );
    }

    if (field.field_type === 'checkbox') {
      const checked = Boolean(val);
      return (
        <div className="bg-grid-cell" style={{ justifyContent: 'center', cursor: 'pointer' }} onClick={() => void onPatchCell(rec.id, field.id, !checked)}>
          <span
            style={{
              width: 19,
              height: 19,
              borderRadius: 5,
              border: checked ? '1px solid #16a34a' : '1.5px solid #cbd5e1',
              background: checked ? '#16a34a' : '#ffffff',
              color: '#ffffff',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            {checked && <IconCheck size={12} />}
          </span>
        </div>
      );
    }

    if (field.field_type === 'rating') {
      const max = field.options.max ?? 5;
      const cur = Math.max(0, Math.min(max, Number(val) || 0));
      return (
        <div className="bg-grid-cell" style={{ gap: 2, cursor: 'pointer' }}>
          {Array.from({ length: max }).map((_, i) => (
            <span
              key={i}
              onClick={() => void onPatchCell(rec.id, field.id, i + 1 === cur ? 0 : i + 1)}
              style={{
                color: i < cur ? '#f59e0b' : '#d1d5db',
                fontSize: 15,
                lineHeight: 1,
              }}
            >
              ★
            </span>
          ))}
        </div>
      );
    }

    if (field.field_type === 'single_select') {
      const s = val ? String(val) : '';
      const t = getPillTheme(s);
      return (
        <div className="bg-grid-cell" onClick={() => startEdit(rec, field)}>
          {s ? (
            <span className="pill" style={{ background: t.bg, color: t.fg, borderColor: t.border }}>
              <span className="pill-dot" style={{ background: t.dot }} />
              {s}
            </span>
          ) : (
            <span style={{ color: '#cbd5e1', fontSize: 12 }}>—</span>
          )}
        </div>
      );
    }

    if (field.field_type === 'multi_select') {
      const items = Array.isArray(val) ? val.map(String) : [];
      return (
        <div className="bg-grid-cell" style={{ flexWrap: 'wrap', gap: 4 }} onClick={() => startEdit(rec, field)}>
          {items.map((item) => {
            const t = getPillTheme(item);
            return (
              <span key={item} className="pill" style={{ background: t.bg, color: t.fg, borderColor: t.border, fontSize: 11 }}>
                {item}
              </span>
            );
          })}
        </div>
      );
    }

    if (field.field_type === 'link') {
      const ids = Array.isArray(val) ? val.map(Number) : [];
      return (
        <div className="bg-grid-cell" style={{ flexWrap: 'wrap', gap: 4, cursor: 'pointer' }} onClick={() => onOpenRecord(rec)}>
          {ids.length === 0 ? (
            <span style={{ color: '#cbd5e1', fontSize: 11.5 }}>+ Link</span>
          ) : (
            ids.map((id) => {
              const target = idx.recordsById.get(id);
              const title = target ? getRecordTitle(target, idx) : `#${id}`;
              return (
                <span
                  key={id}
                  className="pill"
                  style={{ background: '#eff6ff', color: '#1d4ed8', borderColor: '#bfdbfe', fontSize: 11.5 }}
                >
                  <IconLink size={10} />
                  {title}
                </span>
              );
            })
          )}
        </div>
      );
    }

    if (field.field_type === 'lookup') {
      const items = Array.isArray(val) ? val.map(String) : [];
      return (
        <div className="bg-grid-cell" style={{ gap: 4, color: 'var(--ink-secondary)', background: '#fafaf9' }}>
          {items.length ? (
            items.map((it, i) => (
              <span key={i} className="pill" style={{ background: '#f1f5f9', color: '#334155', borderColor: '#e2e8f0' }}>
                {it}
              </span>
            ))
          ) : (
            <span style={{ color: '#cbd5e1' }}>—</span>
          )}
        </div>
      );
    }

    if (field.field_type === 'rollup' || field.field_type === 'formula') {
      const num = Number(val);
      const display =
        typeof val === 'number' && Number.isFinite(val)
          ? Math.abs(val) >= 1000 && /arr|budget|pipeline|remaining|value/i.test(field.name)
            ? formatMoney(val)
            : formatNumber(val, val % 1 === 0 ? 0 : 1)
          : Number.isFinite(num) && String(val) !== '' && typeof val !== 'string'
            ? formatNumber(num, 1)
            : String(val ?? '');
      return (
        <div
          className="bg-grid-cell mono"
          style={{
            justifyContent: 'flex-end',
            fontWeight: 650,
            color: field.field_type === 'formula' ? '#6d28d9' : '#0f766e',
            background: '#fcfaff',
            fontSize: 12.5,
          }}
          title={field.options.formula ? `Formula: ${field.options.formula}` : `Rollup: ${field.options.agg || 'SUM'}`}
        >
          {display}
        </div>
      );
    }

    if (field.field_type === 'currency') {
      const n = Number(val) || 0;
      return (
        <div className="bg-grid-cell" style={{ justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }} onClick={() => startEdit(rec, field)}>
          {formatMoney(n, field.options.symbol || '$')}
        </div>
      );
    }

    if (field.field_type === 'percent') {
      const n = Number(val) || 0;
      return (
        <div className="bg-grid-cell" style={{ justifyContent: 'space-between', gap: 8 }} onClick={() => startEdit(rec, field)}>
          <div style={{ flex: 1, height: 6, borderRadius: 99, background: '#e5e7eb', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(0, Math.min(100, n))}%`, height: '100%', background: n >= 80 ? '#16a34a' : n >= 50 ? '#2563eb' : '#f59e0b' }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{formatPercent(n)}</span>
        </div>
      );
    }

    if (field.field_type === 'number') {
      return (
        <div className="bg-grid-cell" style={{ justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums' }} onClick={() => startEdit(rec, field)}>
          {val !== null && val !== undefined && val !== '' ? formatNumber(Number(val)) : ''}
        </div>
      );
    }

    if (field.field_type === 'date') {
      return (
        <div className="bg-grid-cell" style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink-secondary)' }} onClick={() => startEdit(rec, field)}>
          {val ? formatDateShort(String(val)) : ''}
        </div>
      );
    }

    if (field.field_type === 'url') {
      const s = val ? String(val) : '';
      return (
        <div className="bg-grid-cell" onClick={() => startEdit(rec, field)}>
          {s ? (
            <span style={{ color: '#2563eb', textDecoration: 'underline', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.replace(/^https?:\/\//, '')}
            </span>
          ) : null}
        </div>
      );
    }

    if (field.field_type === 'attachment') {
      const bg = val ? String(val) : 'linear-gradient(135deg,#2563eb,#7c3aed)';
      return (
        <div className="bg-grid-cell" onClick={() => startEdit(rec, field)}>
          <div style={{ width: 42, height: 24, borderRadius: 5, background: bg, border: '1px solid rgba(0,0,0,0.08)' }} />
          <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>Cover asset</span>
        </div>
      );
    }

    if (field.field_type === 'ai_agent') {
      const text = val ? String(val) : '';
      return (
        <div
          className="bg-grid-cell"
          style={{ background: '#fdfbff', justifyContent: 'space-between', gap: 6 }}
          onClick={() => startEdit(rec, field)}
        >
          <span style={{ fontSize: 12, color: '#4c1d95', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: config.rowHeight === 'tall' ? 'normal' : 'nowrap' }}>
            {text || 'Click sparkle to synthesize'}
          </span>
          {onRunAiField && (
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              title="Re-run AI Field Agent on this record"
              onClick={(e) => {
                e.stopPropagation();
                void onRunAiField(rec, field);
              }}
              style={{ color: '#7c3aed', padding: '2px 4px' }}
            >
              <IconSparkles size={12} />
            </button>
          )}
        </div>
      );
    }

    // Default text / long_text / primary
    return (
      <div
        className="bg-grid-cell"
        style={{
          fontWeight: field.is_primary ? 650 : 400,
          justifyContent: 'space-between',
        }}
        onClick={() => startEdit(rec, field)}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: config.rowHeight === 'tall' ? 'normal' : 'nowrap' }}>
          {val === null || val === undefined ? '' : String(val)}
        </span>
        {field.is_primary && (
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            title="Expand record details, comments & history"
            onClick={(e) => {
              e.stopPropagation();
              onOpenRecord(rec);
            }}
            style={{ fontSize: 11, color: '#6b7280', padding: '1px 5px' }}
          >
            ⤢
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={`grid-scroll ${rowHeightClass}`}>
      <table className="bg-grid-table">
        <thead>
          <tr>
            <th className="sticky-col" style={{ width: 52, textAlign: 'center' }}>
              <input
                type="checkbox"
                checked={records.length > 0 && selectedIds.length === records.length}
                onChange={onToggleSelectAll}
                aria-label="Select all records"
              />
            </th>
            {visibleFields.map((field, fIdx) => (
              <th
                key={field.id}
                className={fIdx === 0 ? 'sticky-col' : ''}
                style={{
                  minWidth: field.width || 160,
                  left: fIdx === 0 ? 52 : undefined,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        color: field.field_type === 'ai_agent' ? '#7c3aed' : field.field_type === 'formula' ? '#6d28d9' : '#64748b',
                        width: 18,
                        textAlign: 'center',
                      }}
                    >
                      {FIELD_TYPE_BADGE[field.field_type] || '•'}
                    </span>
                    <span>{field.name}</span>
                  </span>
                  {!field.is_primary && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      title={`Delete field "${field.name}"`}
                      onClick={() => onDeleteField(field)}
                      style={{ padding: '1px 3px', opacity: 0.45 }}
                    >
                      <IconTrash size={11} />
                    </button>
                  )}
                </div>
              </th>
            ))}
            <th style={{ width: 46, textAlign: 'center' }}>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={onOpenAddField}
                title="Add new field column"
              >
                <IconPlus size={14} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {grouped.map((g) => {
            const isCollapsed = Boolean(g.label && collapsedGroups[g.label]);
            const pill = g.label ? getPillTheme(g.label) : null;
            return (
              <React.Fragment key={g.label || '__all'}>
                {g.label && (
                  <tr className="bg-group-row">
                    <td colSpan={visibleFields.length + 2}>
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        onClick={() =>
                          setCollapsedGroups((prev) => ({ ...prev, [g.label]: !prev[g.label] }))
                        }
                        style={{ padding: '2px 6px' }}
                      >
                        {isCollapsed ? '▸' : '▾'}
                      </button>{' '}
                      <span
                        className="pill"
                        style={{
                          background: pill!.bg,
                          color: pill!.fg,
                          borderColor: pill!.border,
                          marginLeft: 4,
                        }}
                      >
                        {g.label}
                      </span>
                      <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ink-muted)', fontWeight: 600 }}>
                        {g.rows.length} {g.rows.length === 1 ? 'record' : 'records'}
                      </span>
                    </td>
                  </tr>
                )}
                {!isCollapsed &&
                  g.rows.map((rec, rowIdx) => {
                    const isSelected = selectedIds.includes(rec.id);
                    return (
                      <tr key={rec.id} className={isSelected ? 'row-selected' : ''}>
                        <td className="sticky-col" style={{ textAlign: 'center', width: 52, padding: '0 6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => onToggleSelect(rec.id)}
                            />
                            <span style={{ fontSize: 11, color: '#9ca3af', fontVariantNumeric: 'tabular-nums' }}>
                              {rowIdx + 1}
                            </span>
                          </div>
                        </td>
                        {visibleFields.map((field, fIdx) => (
                          <td
                            key={field.id}
                            className={fIdx === 0 ? 'sticky-col' : ''}
                            style={{ left: fIdx === 0 ? 52 : undefined }}
                          >
                            {renderCell(rec, field)}
                          </td>
                        ))}
                        <td />
                      </tr>
                    );
                  })}
              </React.Fragment>
            );
          })}
          <tr>
            <td colSpan={visibleFields.length + 2} style={{ padding: '7px 12px', background: '#fafaf9' }}>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void onAddRecord()}>
                <IconPlus size={14} /> Add record
              </button>
            </td>
          </tr>
        </tbody>
        <tfoot className="bg-grid-footer">
          <tr>
            <td className="sticky-col" style={{ textAlign: 'center' }}>{records.length}</td>
            {visibleFields.map((field, fIdx) => (
              <td key={field.id} className={fIdx === 0 ? 'sticky-col' : ''} style={{ left: fIdx === 0 ? 52 : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <span>{computeSummary(field)}</span>
                  <select
                    aria-label={`Summary aggregation for ${field.name}`}
                    value={config.summaryAgg?.[String(field.id)] ?? (isNumericField(field) ? 'SUM' : 'COUNT')}
                    onChange={(e) =>
                      onChangeSummaryAgg(
                        field.id,
                        e.target.value as 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT' | 'FILLED'
                      )
                    }
                    style={{ border: 'none', background: 'transparent', fontSize: 10.5, color: '#64748b', cursor: 'pointer' }}
                  >
                    <option value="COUNT">Count</option>
                    <option value="FILLED">Filled %</option>
                    {isNumericField(field) && (
                      <>
                        <option value="SUM">Sum</option>
                        <option value="AVG">Avg</option>
                        <option value="MIN">Min</option>
                        <option value="MAX">Max</option>
                      </>
                    )}
                  </select>
                </div>
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
};
