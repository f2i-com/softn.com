import React from 'react';
import { formatMoney, initialsOf } from '../../../../shared/ui/format';
import type { Contact, CrmOverview, Quote } from '../types';

function quoteBadge(status: string): string {
  if (status === 'Accepted') return 'badge-success';
  if (status === 'Sent') return 'badge-info';
  if (status === 'Declined') return 'badge-danger';
  return 'badge-neutral';
}

export const QuotesView: React.FC<{ quotes: Quote[]; onQuoteStatus: (id: number, status: string) => Promise<void> }> = ({
  quotes,
  onQuoteStatus,
}) => (
  <div className="panel">
    <div className="panel-header">
      <h2>Sales Quotations &amp; Orders</h2>
      <span className="muted" style={{ fontSize: '12px' }}>Accepting a linked quote automatically marks its CRM deal Won</span>
    </div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Number</th><th>Customer</th><th>Items</th><th>Valid Until</th><th>Status</th><th className="num">Total (incl. tax)</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {quotes.map((q) => (
            <tr key={q.id}>
              <td><strong>{q.quote_number}</strong></td>
              <td>{q.customer_name}</td>
              <td>{q.items.length} line(s)</td>
              <td>{q.valid_until}</td>
              <td><span className={`badge ${quoteBadge(q.status)}`}>{q.status}</span></td>
              <td className="num"><strong>{formatMoney(Number(q.total))}</strong></td>
              <td style={{ display: 'flex', gap: '6px' }}>
                {q.status === 'Draft' && <button type="button" className="btn btn-sm" onClick={() => void onQuoteStatus(q.id, 'Sent')}>Send Quote</button>}
                {(q.status === 'Draft' || q.status === 'Sent') && (
                  <button type="button" className="btn btn-sm btn-success" onClick={() => void onQuoteStatus(q.id, 'Accepted')}>Mark Accepted</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

export const ContactsView: React.FC<{ contacts: Contact[] }> = ({ contacts }) => (
  <div className="card-grid">
    {contacts.map((c) => (
      <div key={c.id} className="panel">
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="avatar">{initialsOf(c.name)}</div>
              <div>
                <div style={{ fontWeight: 700 }}>{c.name}</div>
                <div className="muted" style={{ fontSize: '12px' }}>{c.role_title || 'Contact'}</div>
              </div>
            </div>
            <span className="badge badge-accent">{c.tag}</span>
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--ink-secondary)' }}>
            <div><strong>{c.company}</strong></div>
            <div>{c.email}</div>
            <div>{c.phone}</div>
          </div>
        </div>
      </div>
    ))}
  </div>
);

export const AnalyticsView: React.FC<{ overview: CrmOverview | null }> = ({ overview }) => {
  const maxStageRev = Math.max(1, ...(overview?.byStage.map((s) => s.revenue) ?? [1]));
  return (
    <div className="split-2">
      <div className="panel">
        <div className="panel-header"><h2>Pipeline Funnel by Stage</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {(overview?.byStage ?? []).map((st) => (
            <div key={st.stage} style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span><strong>{st.stage}</strong> <span className="muted">({st.count} deals)</span></span>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(st.revenue)}</strong>
              </div>
              <div className="progress">
                <div className="progress-fill" style={{ width: `${Math.round((st.revenue / maxStageRev) * 100)}%`, background: st.stage === 'Lost' ? '#dc2626' : st.stage === 'Won' ? '#059669' : '#0d9488' }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><h2>Sales Rep Performance</h2></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Sales Rep</th><th className="num">Deals</th><th className="num">Open Pipeline</th><th className="num">Closed Won</th></tr>
            </thead>
            <tbody>
              {(overview?.byOwner ?? []).map((o) => (
                <tr key={o.owner}>
                  <td><strong>{o.owner}</strong></td>
                  <td className="num">{o.deals}</td>
                  <td className="num">{formatMoney(o.open)}</td>
                  <td className="num" style={{ color: '#059669', fontWeight: 700 }}>{formatMoney(o.won)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
