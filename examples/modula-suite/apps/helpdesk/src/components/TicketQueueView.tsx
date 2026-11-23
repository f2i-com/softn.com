import React, { useState } from 'react';
import type { CannedMacro, KbArticle, Ticket, TicketMessage } from '../types';

function stageBadge(stage: string): string {
  if (stage === 'Solved') return 'badge-success';
  if (stage === 'In Progress') return 'badge-info';
  if (stage === 'Waiting') return 'badge-warning';
  return 'badge-accent';
}

function prioBadge(p: string): string {
  if (p === 'Urgent') return 'badge-danger';
  if (p === 'High') return 'badge-warning';
  return 'badge-neutral';
}

interface TicketQueueViewProps {
  tickets: Ticket[];
  selectedId: number | null;
  messages: TicketMessage[];
  macros: CannedMacro[];
  articles: KbArticle[];
  onSelectTicket: (id: number) => void;
  onUpdateTicket: (id: number, patch: { stage?: string; priority?: string; csat_rating?: number }) => Promise<void>;
  onSendMessage: (ticketId: number, body: string, isInternal: boolean) => Promise<void>;
}

export const TicketQueueView: React.FC<TicketQueueViewProps> = ({
  tickets,
  selectedId,
  messages,
  macros,
  articles,
  onSelectTicket,
  onUpdateTicket,
  onSendMessage,
}) => {
  const [stageFilter, setStageFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [replyInternal, setReplyInternal] = useState(false);

  const visible = tickets.filter((t) => {
    if (stageFilter !== 'All' && t.stage !== stageFilter) return false;
    const q = search.trim().toLowerCase();
    return !q || t.subject.toLowerCase().includes(q) || t.customer_name.toLowerCase().includes(q) || t.ticket_number.toLowerCase().includes(q);
  });

  const selectedTicket = tickets.find((t) => t.id === selectedId) ?? visible[0] ?? null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTicket || !replyBody.trim()) return;
    await onSendMessage(selectedTicket.id, replyBody.trim(), replyInternal);
    setReplyBody('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div className="toolbar">
        <div className="toolbar-left">
          {['All', 'New', 'In Progress', 'Waiting', 'Solved'].map((s) => (
            <button key={s} type="button" className={`btn btn-sm ${stageFilter === s ? 'btn-primary' : ''}`} onClick={() => setStageFilter(s)}>
              {s}
            </button>
          ))}
        </div>
        <input className="input" type="search" placeholder="Search tickets..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="split-2">
        <div className="panel">
          <div className="panel-header"><h2>Support Queue ({visible.length})</h2></div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {visible.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelectTicket(t.id)}
                style={{
                  textAlign: 'left',
                  border: 'none',
                  borderBottom: '1px solid var(--border)',
                  background: selectedTicket && t.id === selectedTicket.id ? 'var(--accent-soft)' : 'transparent',
                  padding: '12px 14px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '5px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontWeight: 700, fontSize: '13.5px' }}>{t.ticket_number} · {t.subject}</span>
                  <span className={`badge ${prioBadge(t.priority)}`}>{t.priority}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
                  <span className="muted">{t.customer_name} · {t.assignee}</span>
                  <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                    {t.csat_rating > 0 && <span style={{ color: '#d97706' }}>{'★'.repeat(t.csat_rating)}</span>}
                    <span className={`badge ${stageBadge(t.stage)}`}>{t.stage}</span>
                  </div>
                </div>
              </button>
            ))}
            {visible.length === 0 && <div className="empty-state">No tickets match filter</div>}
          </div>
        </div>

        <div className="panel">
          {selectedTicket ? (
            <>
              <div className="panel-header" style={{ flexWrap: 'wrap' }}>
                <div>
                  <h2>{selectedTicket.ticket_number}: {selectedTicket.subject}</h2>
                  <div className="muted" style={{ fontSize: '12px' }}>
                    {selectedTicket.customer_name} ({selectedTicket.customer_email}) · SLA: <strong>{selectedTicket.sla_status}</strong> · Tags: {selectedTicket.tags}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <select className="select" value={selectedTicket.stage} onChange={(e) => void onUpdateTicket(selectedTicket.id, { stage: e.target.value })}>
                    {['New', 'In Progress', 'Waiting', 'Solved'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className="select" value={selectedTicket.priority} onChange={(e) => void onUpdateTicket(selectedTicket.id, { priority: e.target.value })}>
                    {['Low', 'Normal', 'High', 'Urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>

              <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {selectedTicket.stage === 'Solved' && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#ecfdf5', borderRadius: '8px', border: '1px solid #a7f3d0' }}>
                    <span style={{ fontSize: '12.5px', fontWeight: 600, color: '#065f46' }}>Customer Satisfaction (CSAT):</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          className="btn btn-sm"
                          style={{
                            padding: '2px 7px',
                            background: selectedTicket.csat_rating >= star ? '#f59e0b' : '#ffffff',
                            color: selectedTicket.csat_rating >= star ? '#ffffff' : '#6b7280',
                            borderColor: '#fcd34d',
                          }}
                          onClick={() => void onUpdateTicket(selectedTicket.id, { csat_rating: star })}
                        >
                          ★
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '280px', overflowY: 'auto' }}>
                  {messages.map((m) => (
                    <div key={m.id} className={`chatter-item ${m.is_internal ? 'internal' : ''}`}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                        <span>
                          <strong>{m.author}</strong>{' '}
                          {m.is_internal ? <span className="badge badge-warning">Internal Note</span> : <span className="badge badge-neutral">Public</span>}
                        </span>
                        <span className="muted">{m.created_at}</span>
                      </div>
                      <div style={{ fontSize: '13px', whiteSpace: 'pre-wrap' }}>{m.body}</div>
                    </div>
                  ))}
                </div>

                {/* 1-click Canned Macros & KB Link insertion */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: '11.5px', fontWeight: 600 }}>Insert Macro:</span>
                  {macros.map((mac) => (
                    <button
                      key={mac.id}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setReplyBody((prev) => (prev ? `${prev}\n\n${mac.body}` : mac.body))}
                    >
                      {mac.shortcut}
                    </button>
                  ))}
                  {articles.length > 0 && (
                    <select
                      className="select"
                      style={{ padding: '3px 7px', fontSize: '12px' }}
                      value=""
                      onChange={(e) => {
                        const found = articles.find((a) => String(a.id) === e.target.value);
                        if (found) {
                          const ref = `Reference SOP: "${found.title}" (${found.category}) — ${found.body}`;
                          setReplyBody((prev) => (prev ? `${prev}\n\n${ref}` : ref));
                        }
                      }}
                    >
                      <option value="">+ Cite KB Article...</option>
                      {articles.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                    </select>
                  )}
                </div>

                <form onSubmit={(e) => void handleSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <textarea
                    className="textarea"
                    placeholder={replyInternal ? 'Write an internal note visible only to your team...' : 'Write a reply to the customer...'}
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px' }}>
                      <input type="checkbox" checked={replyInternal} onChange={(e) => setReplyInternal(e.target.checked)} />
                      Log as internal note
                    </label>
                    <button type="submit" className="btn btn-primary">{replyInternal ? 'Save Note' : 'Send Reply'}</button>
                  </div>
                </form>
              </div>
            </>
          ) : (
            <div className="empty-state">Select a ticket to inspect conversation</div>
          )}
        </div>
      </div>
    </div>
  );
};
