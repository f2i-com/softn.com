import { formatMoney } from '../../../../shared/ui/format';
import type { PosOrder, PosSession } from '../types';

interface OrdersAndSessionsViewProps {
  orders: PosOrder[];
  sessions: PosSession[];
  onRefund: (orderId: number) => Promise<void>;
  onCloseSession: (sessionId: number) => Promise<void>;
  onOpenShiftModal: () => void;
}

export function OrdersAndSessionsView({
  orders,
  sessions,
  onRefund,
  onCloseSession,
  onOpenShiftModal,
}: OrdersAndSessionsViewProps) {
  const hasOpen = sessions.some((s) => s.status === 'Open');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="panel">
        <div className="panel-header">
          <h2>Register Shifts &amp; Z-Reports</h2>
          {!hasOpen && (
            <button type="button" className="btn btn-sm btn-primary" onClick={onOpenShiftModal}>+ Open Shift</button>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Register</th>
                <th>Cashier</th>
                <th>Opened</th>
                <th className="num">Opening Float</th>
                <th className="num">Cash Sales</th>
                <th className="num">Card Sales</th>
                <th className="num">Expected Drawer</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.register_name}</strong></td>
                  <td>{s.cashier_name}</td>
                  <td>{s.opened_at}</td>
                  <td className="num">{formatMoney(s.opening_float)}</td>
                  <td className="num">{formatMoney(s.cash_sales)}</td>
                  <td className="num">{formatMoney(s.card_sales)}</td>
                  <td className="num"><strong>{formatMoney(s.opening_float + s.cash_sales)}</strong></td>
                  <td><span className={`badge ${s.status === 'Open' ? 'badge-success' : 'badge-neutral'}`}>{s.status}</span></td>
                  <td>
                    {s.status === 'Open' ? (
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void onCloseSession(s.id)}>Close Shift (Z-Report)</button>
                    ) : (
                      <span className="muted" style={{ fontSize: '12px' }}>Closed {s.closed_at}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Order History &amp; Refunds</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Receipt #</th>
                <th>Customer</th>
                <th>Mode</th>
                <th>Items</th>
                <th>Payment</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td><strong>{o.order_number}</strong></td>
                  <td>{o.customer_name}</td>
                  <td>{o.order_type}{o.table_label ? ` · ${o.table_label}` : ''}</td>
                  <td>{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</td>
                  <td><span className="badge badge-info">{o.payment_method}</span></td>
                  <td className="num"><strong>{formatMoney(o.total)}</strong></td>
                  <td><span className={`badge ${o.status === 'Paid' ? 'badge-success' : 'badge-danger'}`}>{o.status}</span></td>
                  <td>
                    {o.status === 'Paid' ? (
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void onRefund(o.id)}>Refund &amp; Restock</button>
                    ) : (
                      <span className="muted" style={{ fontSize: '12px' }}>Restocked</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
