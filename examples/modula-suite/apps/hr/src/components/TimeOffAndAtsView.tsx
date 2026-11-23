import React from 'react';
import type { Candidate, LeaveRequest } from '../types';

const ATS_STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired'] as const;

function nextAtsStage(stage: string): string | null {
  const idx = ATS_STAGES.indexOf(stage as (typeof ATS_STAGES)[number]);
  return idx >= 0 && idx < ATS_STAGES.length - 1 ? ATS_STAGES[idx + 1] : null;
}

interface TimeOffViewProps {
  leaves: LeaveRequest[];
  onDecision: (id: number, status: 'Approved' | 'Rejected') => Promise<void>;
}

export const TimeOffView: React.FC<TimeOffViewProps> = ({ leaves, onDecision }) => (
  <div className="panel">
    <div className="panel-header">
      <h2>Time Off &amp; Leave Approvals</h2>
      <span className="muted" style={{ fontSize: '12px' }}>Approving deducts days from the employee&apos;s balance automatically</span>
    </div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Employee</th><th>Type</th><th>Dates</th><th className="num">Days</th><th>Reason</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody>
          {leaves.map((l) => (
            <tr key={l.id}>
              <td><strong>{l.employee_name}</strong></td>
              <td>{l.leave_type}</td>
              <td>{l.start_date} → {l.end_date}</td>
              <td className="num"><strong>{l.days}</strong></td>
              <td>{l.reason}</td>
              <td>
                <span className={`badge ${l.status === 'Approved' ? 'badge-success' : l.status === 'Rejected' ? 'badge-danger' : 'badge-warning'}`}>
                  {l.status}
                </span>
              </td>
              <td style={{ display: 'flex', gap: '6px' }}>
                {l.status === 'Pending' && (
                  <>
                    <button type="button" className="btn btn-sm btn-success" onClick={() => void onDecision(l.id, 'Approved')}>Approve</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => void onDecision(l.id, 'Rejected')}>Reject</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

interface RecruitmentAtsViewProps {
  candidates: Candidate[];
  onAdvance: (cand: Candidate, stage: string) => Promise<void>;
}

export const RecruitmentAtsView: React.FC<RecruitmentAtsViewProps> = ({ candidates, onAdvance }) => (
  <div className="kanban">
    {ATS_STAGES.map((stage) => {
      const list = candidates.filter((c) => c.stage === stage);
      return (
        <div key={stage} className="kanban-col">
          <div className="kanban-col-head">
            <span className="kanban-col-title">{stage} <span className="badge badge-neutral">{list.length}</span></span>
          </div>
          {list.map((c) => {
            const nxt = nextAtsStage(c.stage);
            return (
              <div key={c.id} className="kanban-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="kanban-card-title">{c.name}</span>
                  <span style={{ color: '#d97706', fontSize: '12px' }}>{'★'.repeat(c.rating)}</span>
                </div>
                <div className="kanban-card-sub">{c.role_applied} · {c.department}</div>
                {c.notes && <div className="muted" style={{ fontSize: '12px' }}>{c.notes}</div>}
                <div className="kanban-card-foot">
                  <span className="muted" style={{ fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.email}</span>
                  {nxt && (
                    <button
                      type="button"
                      className={`btn btn-sm ${nxt === 'Hired' ? 'btn-success' : 'btn-primary'}`}
                      onClick={() => void onAdvance(c, nxt)}
                    >
                      {nxt === 'Hired' ? 'Hire →' : `${nxt} →`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {list.length === 0 && <div className="empty-state" style={{ padding: '16px 8px' }}>None</div>}
        </div>
      );
    })}
  </div>
);
