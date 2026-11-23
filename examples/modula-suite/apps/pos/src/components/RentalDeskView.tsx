import { formatMoney } from '../../../../shared/ui/format';
import type { RentalAsset, RentalBooking } from '../types';

interface RentalDeskViewProps {
  assets: RentalAsset[];
  bookings: RentalBooking[];
  onUpdateStatus: (bookingId: number, status: RentalBooking['status']) => Promise<void>;
  onOpenNewBooking: () => void;
}

export function RentalDeskView({
  assets,
  bookings,
  onUpdateStatus,
  onOpenNewBooking,
}: RentalDeskViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="panel">
        <div className="panel-header">
          <h2>Rental Fleet Availability</h2>
          <button type="button" className="btn btn-sm btn-primary" onClick={onOpenNewBooking}>+ New Rental Booking</button>
        </div>
        <div className="panel-body">
          <div className="card-grid">
            {assets.map((asset) => {
              const pct = asset.total_qty > 0 ? Math.round((asset.available_qty / asset.total_qty) * 100) : 0;
              return (
                <div key={asset.id} className="kanban-card" style={{ cursor: 'default' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="badge badge-info">{asset.category}</span>
                    <span className="muted" style={{ fontSize: '11.5px' }}>{asset.asset_code}</span>
                  </div>
                  <div className="kanban-card-title">{asset.name}</div>
                  <div className="kanban-card-sub">{asset.condition_note}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px' }}>
                    <span><strong>{formatMoney(asset.daily_rate)}</strong>/day</span>
                    <span className="muted">Deposit {formatMoney(asset.deposit_amount)}</span>
                  </div>
                  <div className="progress"><div className="progress-fill" style={{ width: `${pct}%`, background: asset.available_qty === 0 ? '#dc2626' : '#0284c7' }} /></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span>{asset.available_qty} / {asset.total_qty} units available</span>
                    <strong>{pct}% free</strong>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Active Rental Contracts &amp; Check-Out / Return</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Booking #</th>
                <th>Equipment</th>
                <th>Customer</th>
                <th>Dates</th>
                <th className="num">Qty</th>
                <th className="num">Deposit</th>
                <th className="num">Rental Total</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.booking_number}</strong></td>
                  <td>{b.asset_name}</td>
                  <td>{b.customer_name}</td>
                  <td>{b.start_date} → {b.end_date}</td>
                  <td className="num">{b.qty}</td>
                  <td className="num">{formatMoney(b.deposit_amount)}</td>
                  <td className="num"><strong>{formatMoney(b.total_amount)}</strong></td>
                  <td>
                    <span className={`badge ${b.status === 'Picked Up' ? 'badge-warning' : b.status === 'Returned' ? 'badge-success' : b.status === 'Cancelled' ? 'badge-danger' : 'badge-info'}`}>
                      {b.status}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {b.status === 'Reserved' && (
                        <>
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => void onUpdateStatus(b.id, 'Picked Up')}>Check Out</button>
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => void onUpdateStatus(b.id, 'Cancelled')}>Cancel</button>
                        </>
                      )}
                      {b.status === 'Picked Up' && (
                        <button type="button" className="btn btn-sm btn-success" onClick={() => void onUpdateStatus(b.id, 'Returned')}>Return Check-In</button>
                      )}
                      {(b.status === 'Returned' || b.status === 'Cancelled') && (
                        <span className="muted" style={{ fontSize: '12px' }}>Completed</span>
                      )}
                    </div>
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
