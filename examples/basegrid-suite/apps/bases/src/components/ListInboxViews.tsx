import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../../../shared/ui/api';
import { formatDateShort, formatMoney, getPillTheme } from '../../../../shared/ui/format';
import { IconChat, IconCheck, IconHistory, IconPlus } from '../../../../shared/ui/icons';
import { getRecordTitle, resolveFieldValue, type WorkspaceIndex } from '../formula';
import type { FieldMeta, RecordComment, RecordHistoryItem, RecordRow } from '../types';

interface ListViewProps {
  fields: FieldMeta[];
  records: RecordRow[];
  idx: WorkspaceIndex;
  groupField: FieldMeta | null;
  checkField: FieldMeta | null;
  onPatchCell: (recordId: number, fieldId: number, value: unknown) => Promise<void>;
  onOpenRecord: (record: RecordRow) => void;
  onAddRecord: () => Promise<void>;
}

export const ListView: React.FC<ListViewProps> = ({
  fields,
  records,
  idx,
  groupField,
  checkField,
  onPatchCell,
  onOpenRecord,
  onAddRecord,
}) => {
  const moneyField = fields.find((f) => f.field_type === 'currency') ?? null;
  const dateField = fields.find((f) => f.field_type === 'date') ?? null;
  const tagField = fields.find((f) => f.id !== groupField?.id && (f.field_type === 'single_select' || f.field_type === 'multi_select')) ?? null;

  const groups = new Map<string, RecordRow[]>();
  for (const r of records) {
    const label = groupField ? String(resolveFieldValue(r, groupField, idx) ?? 'Other') || 'Other' : 'All Records';
    const arr = groups.get(label) ?? [];
    arr.push(r);
    groups.set(label, arr);
  }

  return (
    <div className="bg-scroll-page">
      <div className="bg-scroll-inner" style={{ maxWidth: 1040, gap: 14 }}>
        {Array.from(groups.entries()).map(([label, rows]) => {
          const pill = getPillTheme(label);
          return (
            <div key={label} className="card">
              <div className="card-header" style={{ padding: '10px 16px', background: '#fafaf9' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="pill" style={{ background: pill.bg, color: pill.fg, borderColor: pill.border }}>
                    <span className="pill-dot" style={{ background: pill.dot }} />
                    {label}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--ink-muted)', fontWeight: 600 }}>
                    {rows.length} {rows.length === 1 ? 'item' : 'items'}
                  </span>
                </div>
                <button type="button" className="btn btn-xs btn-ghost" onClick={() => void onAddRecord()}>
                  <IconPlus size={12} /> Add item
                </button>
              </div>
              <div>
                {rows.map((rec) => {
                  const checked = checkField ? Boolean(resolveFieldValue(rec, checkField, idx)) : false;
                  const moneyVal = moneyField ? Number(resolveFieldValue(rec, moneyField, idx)) || 0 : 0;
                  const dateVal = dateField ? String(resolveFieldValue(rec, dateField, idx) ?? '') : '';
                  const tagVal = tagField ? resolveFieldValue(rec, tagField, idx) : null;
                  const tags = Array.isArray(tagVal) ? tagVal.map(String) : tagVal ? [String(tagVal)] : [];

                  return (
                    <div
                      key={rec.id}
                      onClick={() => onOpenRecord(rec)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '10px 16px',
                        borderBottom: '1px solid var(--border-subtle)',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        {checkField && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onPatchCell(rec.id, checkField.id, !checked);
                            }}
                            style={{
                              width: 19,
                              height: 19,
                              borderRadius: 5,
                              border: checked ? '1px solid #16a34a' : '1.5px solid #cbd5e1',
                              background: checked ? '#16a34a' : '#ffffff',
                              color: '#ffffff',
                              display: 'grid',
                              placeItems: 'center',
                              cursor: 'pointer',
                              flexShrink: 0,
                            }}
                          >
                            {checked && <IconCheck size={12} />}
                          </button>
                        )}
                        <strong style={{ fontSize: 13.5, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {getRecordTitle(rec, idx)}
                        </strong>
                        {tags.slice(0, 2).map((t) => {
                          const pt = getPillTheme(t);
                          return (
                            <span key={t} className="pill" style={{ background: pt.bg, color: pt.fg, fontSize: 11 }}>
                              {t}
                            </span>
                          );
                        })}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0, fontSize: 12.5, color: 'var(--ink-muted)' }}>
                        {moneyVal > 0 && (
                          <strong style={{ color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>
                            {formatMoney(moneyVal, moneyField?.options.symbol || '$')}
                          </strong>
                        )}
                        {dateVal && <span>{formatDateShort(dateVal)}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

interface InboxViewProps {
  fields: FieldMeta[];
  records: RecordRow[];
  idx: WorkspaceIndex;
  statusField: FieldMeta | null;
  onPatchCell: (recordId: number, fieldId: number, value: unknown) => Promise<void>;
}

export const InboxView: React.FC<InboxViewProps> = ({
  fields,
  records,
  idx,
  statusField,
  onPatchCell,
}) => {
  const [selectedId, setSelectedId] = useState<number | null>(() => records[0]?.id ?? null);
  const [comments, setComments] = useState<RecordComment[]>([]);
  const [history, setHistory] = useState<RecordHistoryItem[]>([]);
  const [commentDraft, setCommentDraft] = useState('');

  const activeRec = records.find((r) => r.id === selectedId) ?? records[0] ?? null;
  const activeRecId = activeRec?.id ?? null;

  useEffect(() => {
    if (activeRecId === null) return;
    let alive = true;
    void apiFetch<{ comments: RecordComment[]; history: RecordHistoryItem[] }>(
      `/api/records/${activeRecId}/activity`
    )
      .then((res) => {
        if (alive) {
          setComments(res.comments);
          setHistory(res.history);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [activeRecId]);

  const submitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRec || !commentDraft.trim()) return;
    const res = await apiFetch<{ comment: RecordComment }>(`/api/records/${activeRec.id}/comments`, {
      method: 'POST',
      body: { author: 'Maya Lin', body: commentDraft.trim() },
    });
    setComments((prev) => [...prev, res.comment]);
    setCommentDraft('');
  };

  if (records.length === 0) {
    return <div className="empty-state">No records match the current view filters.</div>;
  }

  return (
    <div className="inbox-split">
      <div className="inbox-list">
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700, color: 'var(--ink-muted)' }}>
          TRIAGE QUEUE ({records.length})
        </div>
        {records.map((rec) => {
          const status = statusField ? String(resolveFieldValue(rec, statusField, idx) ?? '') : '';
          const pt = getPillTheme(status);
          const isCurrent = activeRec?.id === rec.id;
          return (
            <button
              key={rec.id}
              type="button"
              className={`inbox-item ${isCurrent ? 'active' : ''}`}
              onClick={() => setSelectedId(rec.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <strong style={{ fontSize: 13.5, color: 'var(--ink)' }}>{getRecordTitle(rec, idx)}</strong>
                {status && (
                  <span className="pill" style={{ background: pt.bg, color: pt.fg, fontSize: 10.5 }}>
                    {status}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>
                Record #{rec.id} · Updated {rec.updated_at}
              </span>
            </button>
          );
        })}
      </div>

      {activeRec && (
        <div style={{ overflowY: 'auto', padding: '20px 24px', background: '#ffffff', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-muted)' }}>
              Record #{activeRec.id} · Created by {activeRec.created_by}
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 21, letterSpacing: '-0.025em' }}>
              {getRecordTitle(activeRec, idx)}
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {fields.filter((f) => !f.is_primary).map((f) => {
              const val = resolveFieldValue(activeRec, f, idx);
              const readonly = ['lookup', 'rollup', 'formula', 'link'].includes(f.field_type);
              return (
                <div key={f.id} className="field-label">
                  <span>{f.name}</span>
                  {f.field_type === 'single_select' ? (
                    <select
                      className="select"
                      value={String(val ?? '')}
                      onChange={(e) => void onPatchCell(activeRec.id, f.id, e.target.value)}
                    >
                      <option value="">(None)</option>
                      {(f.options.choices ?? []).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  ) : f.field_type === 'checkbox' ? (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--ink)' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(val)}
                        onChange={(e) => void onPatchCell(activeRec.id, f.id, e.target.checked)}
                      />
                      {val ? 'Checked' : 'Unchecked'}
                    </label>
                  ) : readonly ? (
                    <div className="input" style={{ background: '#f8fafc', color: '#475569' }}>
                      {Array.isArray(val) ? val.join(', ') : String(val ?? '—')}
                    </div>
                  ) : (
                    <input
                      className="input"
                      type={f.field_type === 'date' ? 'date' : 'text'}
                      defaultValue={Array.isArray(val) ? val.join(', ') : String(val ?? '')}
                      key={`${activeRec.id}-${f.id}-${String(val ?? '')}`}
                      onBlur={(e) => {
                        const raw = e.target.value;
                        const next = ['number', 'currency', 'percent'].includes(f.field_type)
                          ? Number(raw.replace(/[$,%\s,]/g, '')) || 0
                          : f.field_type === 'multi_select'
                            ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                            : raw;
                        if (String(next) !== String(val ?? '')) {
                          void onPatchCell(activeRec.id, f.id, next);
                        }
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
                <IconChat size={14} /> Comments ({comments.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 200, overflowY: 'auto' }}>
                {comments.map((c) => (
                  <div key={c.id} style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700 }}>{c.author} <span style={{ fontWeight: 400, color: 'var(--ink-muted)' }}>· {c.created_at}</span></div>
                    <div style={{ fontSize: 12.5, marginTop: 3 }}>{c.body}</div>
                  </div>
                ))}
                {comments.length === 0 && <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>No comments yet.</span>}
              </div>
              <form onSubmit={(e) => void submitComment(e)} style={{ display: 'flex', gap: 6 }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  placeholder="Write a triage comment..."
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                />
                <button type="submit" className="btn btn-primary btn-sm">Post</button>
              </form>
            </div>

            <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
                <IconHistory size={14} /> Revision History ({history.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, maxHeight: 230, overflowY: 'auto' }}>
                {history.map((h) => (
                  <div key={h.id} style={{ fontSize: 12, borderBottom: '1px solid #f1f5f9', paddingBottom: 6 }}>
                    <strong>{h.actor}</strong> updated <strong>{h.field_name}</strong>:{' '}
                    <span style={{ color: '#9ca3af', textDecoration: 'line-through' }}>{h.old_value || '(empty)'}</span> →{' '}
                    <span style={{ color: '#15803d', fontWeight: 600 }}>{h.new_value}</span>
                    <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{h.created_at}</div>
                  </div>
                ))}
                {history.length === 0 && <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>No revisions recorded yet.</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
