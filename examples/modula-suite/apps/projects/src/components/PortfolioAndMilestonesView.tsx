import React from 'react';
import { formatMoney, formatPercent } from '../../../../shared/ui/format';
import type { Milestone, Project } from '../types';

export const PortfolioView: React.FC<{ projects: Project[]; onOpenBoard: (projectId: string) => void }> = ({
  projects,
  onOpenBoard,
}) => (
  <div className="card-grid">
    {projects.map((p) => {
      const pct = p.budget_hours > 0 ? Math.min(100, (p.logged_hours / p.budget_hours) * 100) : 0;
      return (
        <div key={p.id} className="panel">
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '8px' }}>
              <div>
                <strong style={{ fontSize: '15px' }}>{p.name}</strong>
                <div className="muted" style={{ fontSize: '12px' }}>{p.client_name} · Lead: {p.lead_name}</div>
              </div>
              <span className="badge badge-success">{p.status}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px' }}>
              <span>Budget: <strong>{p.logged_hours}h / {p.budget_hours}h</strong> ({formatPercent(pct)})</span>
              <span>{formatMoney(Number(p.hourly_rate))}/h</span>
            </div>
            <div className="progress"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
              <span className="muted">Tasks: {p.task_done}/{p.task_total} complete · Due {p.due_date}</span>
              <button type="button" className="btn btn-sm" onClick={() => onOpenBoard(String(p.id))}>Open Board</button>
            </div>
          </div>
        </div>
      );
    })}
  </div>
);

export const MilestonesView: React.FC<{
  milestones: Milestone[];
  onToggle: (id: number) => Promise<void>;
}> = ({ milestones, onToggle }) => (
  <div className="panel">
    <div className="panel-header"><h2>Project Milestones &amp; Billing Gates</h2></div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Status</th><th>Milestone</th><th>Project</th><th>Target Date</th><th className="num">Billing Value</th><th>Action</th></tr>
        </thead>
        <tbody>
          {milestones.map((m) => (
            <tr key={m.id}>
              <td><span className={`badge ${m.reached ? 'badge-success' : 'badge-warning'}`}>{m.reached ? 'Reached' : 'Upcoming'}</span></td>
              <td><strong>{m.title}</strong></td>
              <td>{m.project_name}</td>
              <td>{m.target_date}</td>
              <td className="num"><strong>{formatMoney(Number(m.bill_amount))}</strong></td>
              <td>
                <button type="button" className={`btn btn-sm ${m.reached ? '' : 'btn-success'}`} onClick={() => void onToggle(m.id)}>
                  {m.reached ? 'Reopen' : 'Mark Reached'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);
