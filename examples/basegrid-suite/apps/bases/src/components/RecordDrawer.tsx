import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../../../shared/ui/api';
import { getPillTheme } from '../../../../shared/ui/format';
import {
  IconChat,
  IconClose,
  IconCopy,
  IconHistory,
  IconLink,
  IconSparkles,
  IconTrash,
} from '../../../../shared/ui/icons';
import { getRecordTitle, resolveFieldValue, type WorkspaceIndex } from '../formula';
import type { FieldMeta, RecordComment, RecordHistoryItem, RecordRow } from '../types';

interface RecordDrawerProps {
  record: RecordRow;
  fields: FieldMeta[];
  idx: WorkspaceIndex;
  onClose: () => void;
  onPatchCell: (recordId: number, fieldId: number, value: unknown) => Promise<void>;
  onDuplicate: (recordId: number) => Promise<void>;
  onDelete: (recordId: number) => Promise<void>;
  onRunAiField: (record: RecordRow, field: FieldMeta) => Promise<void>;
}

export const RecordDrawer: React.FC<RecordDrawerProps> = ({
  record,
  fields,
  idx,
  onClose,
  onPatchCell,
  onDuplicate,
  onDelete,
  onRunAiField,
}) => {
  const [tab, setTab] = useState<'fields' | 'comments' | 'history'>('fields');
  const [comments, setComments] = useState<RecordComment[]>([]);
  const [history, setHistory] = useState<RecordHistoryItem[]>([]);
  const [commentBody, setCommentBody] = useState('');

  useEffect(() => {
    let alive = true;
    void apiFetch<{ comments: RecordComment[]; history: RecordHistoryItem[] }>(
      `/api/records/${record.id}/activity`
    )
      .then((res) => {
        if (alive) {
          setComments(res.comments);
          setHistory(res.history);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [record.id, record.updated_at]);

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentBody.trim()) return;
    const res = await apiFetch<{ comment: RecordComment }>(`/api/records/${record.id}/comments`, {
      method: 'POST',
      body: { author: 'Maya Lin', body: commentBody.trim() },
    });
    setComments((prev) => [...prev, res.comment]);
    setCommentBody('');
  };

  const toggleLinkedId = (field: FieldMeta, targetRecId: number) => {
    const cur = Array.isArray(record.cells[String(field.id)])
      ? (record.cells[String(field.id)] as unknown[]).map(Number)
      : [];
    const next = cur.includes(targetRecId)
      ? cur.filter((x) => x !== targetRecId)
      : [...cur, targetRecId];
    void onPatchCell(record.id, field.id, next);
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Record #{record.id} · Updated {record.updated_at}
            </div>
            <h2 style={{ margin: '2px 0 0', fontSize: 18, letterSpacing: '-0.02em' }}>
              {getRecordTitle(record, idx)}
            </h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" className="btn btn-sm" onClick={() => void onDuplicate(record.id)}>
              <IconCopy size={13} /> Duplicate
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void onDelete(record.id)}>
              <IconTrash size={13} /> Delete
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
              <IconClose size={16} />
            </button>
          </div>
        </div>

        <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--border)', background: '#fafaf9' }}>
          <div className="bg-segmented">
            <button type="button" className={`bg-seg-btn ${tab === 'fields' ? 'active' : ''}`} onClick={() => setTab('fields')}>
              Fields ({fields.length})
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'comments' ? 'active' : ''}`} onClick={() => setTab('comments')}>
              <IconChat size={13} /> Comments ({comments.length})
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
              <IconHistory size={13} /> Revision History ({history.length})
            </button>
          </div>
        </div>

        <div className="modal-body" style={{ flex: 1 }}>
          {tab === 'fields' &&
            fields.map((field) => {
              const val = resolveFieldValue(record, field, idx);
              const raw = record.cells[String(field.id)];

              if (field.field_type === 'link') {
                const targetTableId = field.options.targetTableId ?? 0;
                const candidates = idx.recordsByTable.get(targetTableId) ?? [];
                const linkedIds = Array.isArray(raw) ? raw.map(Number) : [];
                return (
                  <div key={field.id} className="field-label">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <IconLink size={12} /> {field.name} (Linked Records)
                    </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: '#f8fafc' }}>
                      {candidates.map((cand) => {
                        const active = linkedIds.includes(cand.id);
                        return (
                          <button
                            key={cand.id}
                            type="button"
                            className={`btn btn-xs ${active ? 'btn-accent' : ''}`}
                            onClick={() => toggleLinkedId(field, cand.id)}
                          >
                            {active ? '✓ ' : '+ '}
                            {getRecordTitle(cand, idx)}
                          </button>
                        );
                      })}
                      {candidates.length === 0 && <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>No records in linked table.</span>}
                    </div>
                  </div>
                );
              }

              if (field.field_type === 'lookup' || field.field_type === 'rollup' || field.field_type === 'formula') {
                return (
                  <div key={field.id} className="field-label">
                    <span>
                      {field.name}{' '}
                      <span className="pill" style={{ background: '#ede9fe', color: '#6d28d9', fontSize: 10 }}>
                        {field.field_type.toUpperCase()}
                      </span>
                    </span>
                    <div className="input mono" style={{ background: '#fcfaff', color: '#4c1d95', fontWeight: 650 }}>
                      {Array.isArray(val) ? val.join(', ') || '—' : String(val ?? '—')}
                    </div>
                    {field.options.formula && (
                      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                        ={field.options.formula}
                      </span>
                    )}
                  </div>
                );
              }

              if (field.field_type === 'single_select') {
                const choices = field.options.choices ?? [];
                return (
                  <div key={field.id} className="field-label">
                    <span>{field.name}</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {choices.map((c) => {
                        const t = getPillTheme(c);
                        const selected = String(val ?? '') === c;
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => void onPatchCell(record.id, field.id, c)}
                            className="pill"
                            style={{
                              background: t.bg,
                              color: t.fg,
                              borderColor: selected ? t.dot : t.border,
                              outline: selected ? `2px solid ${t.dot}` : 'none',
                              cursor: 'pointer',
                              padding: '4px 11px',
                            }}
                          >
                            <span className="pill-dot" style={{ background: t.dot }} />
                            {c}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              if (field.field_type === 'checkbox') {
                return (
                  <label key={field.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(val)}
                      onChange={(e) => void onPatchCell(record.id, field.id, e.target.checked)}
                    />
                    {field.name}
                  </label>
                );
              }

              if (field.field_type === 'ai_agent') {
                return (
                  <div key={field.id} className="field-label">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#6d28d9', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <IconSparkles size={13} /> {field.name} (AI Field Agent)
                      </span>
                      <button
                        type="button"
                        className="btn btn-xs btn-soft"
                        onClick={() => void onRunAiField(record, field)}
                      >
                        <IconSparkles size={11} /> Re-run Agent
                      </button>
                    </div>
                    <textarea
                      className="textarea"
                      style={{ background: '#fdfbff', borderColor: '#ddd6fe' }}
                      defaultValue={String(val ?? '')}
                      key={`${record.id}-${field.id}-${String(val ?? '')}`}
                      onBlur={(e) => void onPatchCell(record.id, field.id, e.target.value)}
                    />
                  </div>
                );
              }

              if (field.field_type === 'long_text') {
                return (
                  <div key={field.id} className="field-label">
                    <span>{field.name}</span>
                    <textarea
                      className="textarea"
                      defaultValue={String(val ?? '')}
                      key={`${record.id}-${field.id}-${String(val ?? '')}`}
                      onBlur={(e) => void onPatchCell(record.id, field.id, e.target.value)}
                    />
                  </div>
                );
              }

              return (
                <div key={field.id} className="field-label">
                  <span>{field.name}</span>
                  <input
                    className="input"
                    type={field.field_type === 'date' ? 'date' : 'text'}
                    defaultValue={Array.isArray(val) ? val.join(', ') : String(val ?? '')}
                    key={`${record.id}-${field.id}-${String(val ?? '')}`}
                    onBlur={(e) => {
                      const str = e.target.value;
                      let parsed: unknown = str;
                      if (['number', 'currency', 'percent', 'rating'].includes(field.field_type)) {
                        parsed = Number(str.replace(/[$,%\s,]/g, '')) || 0;
                      } else if (field.field_type === 'multi_select') {
                        parsed = str.split(',').map((s) => s.trim()).filter(Boolean);
                      }
                      void onPatchCell(record.id, field.id, parsed);
                    }}
                  />
                </div>
              );
            })}

          {tab === 'comments' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <form onSubmit={(e) => void handleAddComment(e)} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <textarea
                  className="textarea"
                  placeholder="Leave a comment or @mention a teammate..."
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn btn-primary btn-sm">Post Comment</button>
                </div>
              </form>
              {comments.map((c) => (
                <div key={c.id} className="card card-pad" style={{ background: '#fafaf9' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <strong>{c.author}</strong>
                    <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>{c.created_at}</span>
                  </div>
                  <div style={{ fontSize: 13 }}>{c.body}</div>
                </div>
              ))}
              {comments.length === 0 && <div className="empty-state">No comments yet on this record.</div>}
            </div>
          )}

          {tab === 'history' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {history.map((h) => (
                <div key={h.id} className="card card-pad" style={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span><strong>{h.actor}</strong> changed <strong>{h.field_name}</strong></span>
                    <span style={{ color: 'var(--ink-muted)' }}>{h.created_at}</span>
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12.5 }}>
                    <span style={{ color: '#9ca3af', textDecoration: 'line-through' }}>{h.old_value || '(empty)'}</span>
                    {' → '}
                    <strong style={{ color: '#15803d' }}>{h.new_value}</strong>
                  </div>
                </div>
              ))}
              {history.length === 0 && <div className="empty-state">No edits recorded yet.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
