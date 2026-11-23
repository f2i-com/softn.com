import type { Appointment } from '../types';

interface AppointmentsViewProps {
  appointments: Appointment[];
  onStatusChange: (id: number, status: Appointment['status']) => Promise<void>;
  onOpenNew: () => void;
}

export function AppointmentsView({ appointments, onStatusChange, onOpenNew }: AppointmentsViewProps) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Customer Appointments &amp; Slot Booking Desk</h2>
        <button type="button" className="btn btn-sm btn-primary" onClick={onOpenNew}>+ Book Appointment</button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Date &amp; Time</th>
              <th>Service</th>
              <th>Customer</th>
              <th>Assigned Specialist</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((a) => (
              <tr key={a.id}>
                <td><strong>{a.ref_code}</strong></td>
                <td style={{ whiteSpace: 'nowrap' }}><strong>{a.appt_date}</strong> · {a.start_time}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{a.service_type}</div>
                  {a.notes && <div className="muted" style={{ fontSize: '11.5px' }}>{a.notes}</div>}
                </td>
                <td>
                  <div>{a.customer_name}</div>
                  <div className="muted" style={{ fontSize: '11.5px' }}>{a.customer_phone || a.customer_email}</div>
                </td>
                <td>{a.technician_name}</td>
                <td>{a.duration_min} min</td>
                <td>
                  <span className={`badge ${a.status === 'Completed' ? 'badge-success' : a.status === 'Checked In' ? 'badge-warning' : a.status === 'Cancelled' ? 'badge-danger' : 'badge-info'}`}>
                    {a.status}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {a.status === 'Confirmed' && (
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => void onStatusChange(a.id, 'Checked In')}>Check In</button>
                    )}
                    {(a.status === 'Confirmed' || a.status === 'Checked In') && (
                      <>
                        <button type="button" className="btn btn-sm btn-success" onClick={() => void onStatusChange(a.id, 'Completed')}>Complete</button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void onStatusChange(a.id, 'Cancelled')}>Cancel</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
