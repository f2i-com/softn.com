import React, { useState } from 'react';
import { formatCompactMoney, formatMoney } from '../../../../shared/ui/format';
import { PIPELINE_STAGES, type Activity, type Deal } from '../types';

function nextStageOf(stage: string): string | null {
  const idx = PIPELINE_STAGES.indexOf(stage as (typeof PIPELINE_STAGES)[number]);
  return idx >= 0 && idx < PIPELINE_STAGES.length - 1 ? PIPELINE_STAGES[idx + 1] : null;
}

function stageBadge(stage: string): string {
  switch (stage) {
    case 'Won': return 'badge-success';
    case 'Lost': return 'badge-danger';
    case 'Negotiation': return 'badge-accent';
    case 'Proposition': return 'badge-info';
    case 'Qualified': return 'badge-warning';
    default: return 'badge-neutral';
  }
}

interface PipelineViewProps {
  deals: Deal[];
  selectedDeal: Deal | null;
  activities: Activity[];
  onOpenDeal: (deal: Deal) => Promise<void>;
  onCloseDeal: () => void;
  onStageChange: (dealId: number, stage: string, lostReason?: string) => Promise<void>;
  onAddActivity: (dealId: number, kind: string, summary: string, dueDate: string) => Promise<void>;
  onToggleActivity: (actId: number) => Promise<void>;
}

export const PipelineView: React.FC<PipelineViewProps> = ({
  deals,
  selectedDeal,
  activities,
  onOpenDeal,
  onCloseDeal,
  onStageChange,
  onAddActivity,
  onToggleActivity,
}) => {
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');
  const [actKind, setActKind] = useState('Call');
  const [actSummary, setActSummary] = useState('');
  const [actDue, setActDue] = useState('');
  const [lostModalDeal, setLostModalDeal] = useState<Deal | null>(null);
  const [lostReason, setLostReason] = useState('Pricing / Budget');

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <strong style={{ fontSize: '13.5px' }}>Sales Pipeline</strong>
          <span className="muted" style={{ fontSize: '12.5px' }}>Click any card for Activity Chatter, follow-up reminders &amp; Mark Lost</span>
        </div>
        <div className="toolbar-right">
          <button type="button" className={`btn btn-sm ${viewMode === 'kanban' ? 'btn-primary' : ''}`} onClick={() => setViewMode('kanban')}>Kanban</button>
          <button type="button" className={`btn btn-sm ${viewMode === 'list' ? 'btn-primary' : ''}`} onClick={() => setViewMode('list')}>List</button>
        </div>
      </div>

      {viewMode === 'kanban' ? (
        <div className="kanban">
          {PIPELINE_STAGES.map((stage) => {
            const colDeals = deals.filter((d) => d.stage === stage);
            const colTotal = colDeals.reduce((sum, d) => sum + Number(d.expected_revenue), 0);
            return (
              <div key={stage} className="kanban-col">
                <div className="kanban-col-head">
                  <span className="kanban-col-title">{stage} <span className="badge badge-neutral">{colDeals.length}</span></span>
                  <span className="kanban-col-meta">{formatCompactMoney(colTotal)}</span>
                </div>
                {colDeals.map((deal) => {
                  const nxt = nextStageOf(deal.stage);
                  return (
                    <div key={deal.id} className="kanban-card" onClick={() => void onOpenDeal(deal)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px', alignItems: 'start' }}>
                        <span className="kanban-card-title">{deal.title}</span>
                        <span style={{ color: '#d97706', fontSize: '12px', letterSpacing: '1px', flexShrink: 0 }}>{'★'.repeat(deal.priority)}</span>
                      </div>
                      <div className="kanban-card-sub">{deal.company || 'Independent'} · {deal.contact_name || 'No contact'}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(Number(deal.expected_revenue))}</strong>
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          {Number(deal.pending_tasks) > 0 && <span className="badge badge-warning">{deal.pending_tasks} due</span>}
                          <span className="badge badge-accent">{deal.probability}%</span>
                        </div>
                      </div>
                      <div className="kanban-card-foot" onClick={(e) => e.stopPropagation()}>
                        <span className="muted" style={{ fontSize: '11.5px', whiteSpace: 'nowrap' }}>{deal.close_date || 'TBD'}</span>
                        {nxt && (
                          <button type="button" className="btn btn-sm" onClick={() => void onStageChange(deal.id, nxt)}>{nxt} →</button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {colDeals.length === 0 && <div className="empty-state" style={{ padding: '16px 8px' }}>No deals</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Opportunity</th><th>Company</th><th>Stage</th><th className="num">Expected Revenue</th><th className="num">Probability</th><th>Owner</th><th>Action</th></tr>
              </thead>
              <tbody>
                {deals.map((deal) => (
                  <tr key={deal.id}>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0, fontWeight: 700 }} onClick={() => void onOpenDeal(deal)}>{deal.title}</button>
                      {deal.lost_reason && <div className="muted" style={{ fontSize: '11.5px' }}>Lost: {deal.lost_reason}</div>}
                    </td>
                    <td>{deal.company}</td>
                    <td><span className={`badge ${stageBadge(deal.stage)}`}>{deal.stage}</span></td>
                    <td className="num">{formatMoney(Number(deal.expected_revenue))}</td>
                    <td className="num">{deal.probability}%</td>
                    <td>{deal.owner_name}</td>
                    <td>
                      <select
                        className="select"
                        style={{ padding: '3px 7px', fontSize: '12px' }}
                        value={deal.stage}
                        onChange={(e) => {
                          if (e.target.value === 'Lost') setLostModalDeal(deal);
                          else void onStageChange(deal.id, e.target.value);
                        }}
                      >
                        {['New', 'Qualified', 'Proposition', 'Negotiation', 'Won', 'Lost'].map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedDeal && (
        <div className="modal-backdrop" onClick={onCloseDeal}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>{selectedDeal.title}</h3>
                <div className="muted" style={{ fontSize: '12px' }}>{selectedDeal.company} · {selectedDeal.contact_name} ({selectedDeal.contact_email})</div>
              </div>
              <button type="button" className="btn btn-sm" onClick={onCloseDeal}>Close</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {PIPELINE_STAGES.map((s) => (
                    <button key={s} type="button" className={`btn btn-sm ${selectedDeal.stage === s ? 'btn-primary' : ''}`} onClick={() => void onStageChange(selectedDeal.id, s)}>{s}</button>
                  ))}
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => setLostModalDeal(selectedDeal)}>Mark Lost</button>
                </div>
                <strong style={{ fontSize: '16px', fontVariantNumeric: 'tabular-nums' }}>{formatMoney(Number(selectedDeal.expected_revenue))} ({selectedDeal.probability}%)</strong>
              </div>
              {selectedDeal.notes && <p style={{ margin: 0, fontSize: '13px', color: 'var(--ink-secondary)' }}>{selectedDeal.notes}</p>}

              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '4px 0' }} />
              <strong style={{ fontSize: '13px' }}>Activity Chatter &amp; Follow-Up Scheduler</strong>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!actSummary.trim()) return;
                  await onAddActivity(selectedDeal.id, actKind, actSummary.trim(), actDue);
                  setActSummary('');
                  setActDue('');
                }}
                style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}
              >
                <select className="select" value={actKind} onChange={(e) => setActKind(e.target.value)}>
                  <option value="Call">Call</option><option value="Email">Email</option><option value="Demo">Demo</option><option value="Meeting">Meeting</option><option value="Note">Note</option>
                </select>
                <input className="input" style={{ flex: 1, minWidth: '180px' }} placeholder="Log note or schedule next action..." value={actSummary} onChange={(e) => setActSummary(e.target.value)} />
                <input className="input" type="date" value={actDue} onChange={(e) => setActDue(e.target.value)} />
                <button type="submit" className="btn btn-primary">{actDue ? 'Schedule' : 'Log'}</button>
              </form>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {activities.map((a) => (
                  <div key={a.id} className={`chatter-item ${a.done === 0 ? 'internal' : ''}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
                      <span>
                        <span className="badge badge-neutral" style={{ marginRight: '6px' }}>{a.kind}</span>
                        <strong>{a.author}</strong>
                        {a.due_date && <span className={`badge ${a.done ? 'badge-success' : 'badge-warning'}`} style={{ marginLeft: '6px' }}>Due {a.due_date}</span>}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {a.due_date && <button type="button" className="btn btn-sm" onClick={() => void onToggleActivity(a.id)}>{a.done ? 'Reopen' : 'Mark Done'}</button>}
                        <span className="muted">{a.created_at}</span>
                      </div>
                    </div>
                    <div style={{ fontSize: '13px', textDecoration: a.due_date && a.done ? 'line-through' : 'none' }}>{a.summary}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {lostModalDeal && (
        <div className="modal-backdrop" onClick={() => setLostModalDeal(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await onStageChange(lostModalDeal.id, 'Lost', lostReason);
              setLostModalDeal(null);
            }}
          >
            <div className="modal-head"><h3>Mark Opportunity Lost</h3><button type="button" className="btn btn-sm" onClick={() => setLostModalDeal(null)}>Cancel</button></div>
            <div className="modal-body">
              <div className="muted">{lostModalDeal.title} ({lostModalDeal.company})</div>
              <div className="field">
                <label>Lost Reason</label>
                <select className="select" value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
                  <option value="Pricing / Budget">Pricing / Budget</option>
                  <option value="Lost to Competitor">Lost to Competitor</option>
                  <option value="Timing / Delayed">Timing / Delayed</option>
                  <option value="Missing Requirement">Missing Requirement</option>
                </select>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setLostModalDeal(null)}>Cancel</button><button type="submit" className="btn btn-danger">Confirm Lost</button></div>
          </form>
        </div>
      )}
    </>
  );
};
