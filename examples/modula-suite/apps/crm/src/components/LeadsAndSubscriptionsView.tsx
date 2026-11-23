import React from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import type { CrmLead, Subscription } from '../types';

interface LeadsQueueViewProps {
  leads: CrmLead[];
  onConvertLead: (lead: CrmLead) => Promise<void>;
}

export const LeadsQueueView: React.FC<LeadsQueueViewProps> = ({ leads, onConvertLead }) => (
  <div className="panel">
    <div className="panel-header">
      <h2>Predictive Lead Scoring &amp; Qualification Queue</h2>
      <span className="muted" style={{ fontSize: '12px' }}>Converting creates a Contact, Qualified Deal &amp; Scheduled Call in one SQLite transaction</span>
    </div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Score</th><th>Contact / Company</th><th>Source</th><th className="num">Est. Budget</th><th className="num">Seats</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody>
          {leads.map((l) => (
            <tr key={l.id}>
              <td><span className={`badge ${l.score >= 80 ? 'badge-success' : l.score >= 60 ? 'badge-info' : 'badge-warning'}`}>{l.score} / 100</span></td>
              <td>
                <div><strong>{l.name}</strong> · {l.company}</div>
                <div className="muted" style={{ fontSize: '11.5px' }}>{l.email} · {l.notes}</div>
              </td>
              <td><span className="badge badge-neutral">{l.source}</span></td>
              <td className="num"><strong>{formatMoney(Number(l.est_budget))}</strong></td>
              <td className="num">{l.team_size}</td>
              <td><span className={`badge ${l.status === 'Converted' ? 'badge-success' : 'badge-accent'}`}>{l.status}</span></td>
              <td>
                {l.status === 'Open' ? (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void onConvertLead(l)}>Convert to Deal →</button>
                ) : (
                  <span className="muted" style={{ fontSize: '12px' }}>Converted</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

interface SubscriptionsViewProps {
  subscriptions: Subscription[];
  onStatusChange: (id: number, status: string) => Promise<void>;
}

export const SubscriptionsView: React.FC<SubscriptionsViewProps> = ({ subscriptions, onStatusChange }) => (
  <div className="panel">
    <div className="panel-header">
      <h2>Recurring Subscriptions (MRR / ARR)</h2>
      <span className="muted" style={{ fontSize: '12px' }}>Manage ongoing hosting, support &amp; maintenance contracts</span>
    </div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Sub #</th><th>Customer</th><th>Plan</th><th>Cycle</th><th className="num">Seats</th><th className="num">MRR</th><th>Next Billing</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody>
          {subscriptions.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.sub_number}</strong></td>
              <td>{s.customer_name}</td>
              <td>{s.plan_name}</td>
              <td><span className="badge badge-neutral">{s.billing_cycle}</span></td>
              <td className="num">{s.seats}</td>
              <td className="num"><strong>{formatMoney(Number(s.mrr))}</strong></td>
              <td>{s.next_billing_date}</td>
              <td><span className={`badge ${s.status === 'Active' ? 'badge-success' : s.status === 'Paused' ? 'badge-warning' : 'badge-danger'}`}>{s.status}</span></td>
              <td style={{ display: 'flex', gap: '6px' }}>
                {s.status === 'Active' ? (
                  <button type="button" className="btn btn-sm" onClick={() => void onStatusChange(s.id, 'Paused')}>Pause</button>
                ) : (
                  <button type="button" className="btn btn-sm btn-success" onClick={() => void onStatusChange(s.id, 'Active')}>Activate</button>
                )}
                {s.status !== 'Churned' && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => void onStatusChange(s.id, 'Churned')}>Cancel</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);
