import { formatMoney } from '../../../../shared/ui/format';
import type { ApprovalRequest } from '../types';

interface ApprovalsInboxViewProps {
  approvals: ApprovalRequest[];
  onDecide: (id: number, status: 'Approved' | 'Refused', note: string) => Promise<void>;
}

export function ApprovalsInboxView({ approvals, onDecide }: ApprovalsInboxViewProps) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Cross-Department Approvals Inbox</h2>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Category</th>
              <th>Request &amp; Justification</th>
              <th>Requester</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.id}>
                <td><strong>{a.ref_code}</strong></td>
                <td><span className="badge badge-info">{a.category}</span></td>
                <td>
                  <div style={{ fontWeight: 600 }}>{a.title}</div>
                  {a.justification && <div className="muted" style={{ fontSize: '12px' }}>{a.justification}</div>}
                </td>
                <td>{a.requester_name}</td>
                <td className="num"><strong>{formatMoney(a.amount)}</strong></td>
                <td>
                  <span className={`badge ${a.status === 'Approved' ? 'badge-success' : a.status === 'Refused' ? 'badge-danger' : 'badge-warning'}`}>
                    {a.status}
                  </span>
                </td>
                <td>
                  {a.status === 'Pending' ? (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button type="button" className="btn btn-sm btn-success" onClick={() => void onDecide(a.id, 'Approved', 'Approved via Modula Inbox')}>Approve</button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void onDecide(a.id, 'Refused', 'Declined by approver')}>Refuse</button>
                    </div>
                  ) : (
                    <span className="muted" style={{ fontSize: '12px' }}>{a.decision_note || a.decided_at}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
