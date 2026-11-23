import { formatMoney } from '../../../../shared/ui/format';
import type { Shift, Technician } from '../types';

interface ShiftPlannerViewProps {
  shifts: Shift[];
  technicians: Technician[];
  onPublishShift: (id: number) => Promise<void>;
  onPublishAll: () => Promise<void>;
  onOpenNewShift: () => void;
}

export function ShiftPlannerView({
  shifts,
  technicians,
  onPublishShift,
  onPublishAll,
  onOpenNewShift,
}: ShiftPlannerViewProps) {
  const draftCount = shifts.filter((s) => !s.published).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="panel">
        <div className="panel-header">
          <h2>Resource Planning &amp; Shift Roster</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            {draftCount > 0 && (
              <button type="button" className="btn btn-sm btn-success" onClick={() => void onPublishAll()}>
                Publish All Drafts ({draftCount})
              </button>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={onOpenNewShift}>+ Assign Shift</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Team Member</th>
                <th>Time Window</th>
                <th>Role / Assignment</th>
                <th>Territory</th>
                <th className="num">Hours</th>
                <th>Schedule State</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.shift_date}</strong></td>
                  <td>{s.technician_name}</td>
                  <td>{s.start_time} – {s.end_time}</td>
                  <td>{s.role_label}</td>
                  <td>{s.location}</td>
                  <td className="num">{s.hours}h</td>
                  <td><span className={`badge ${s.published ? 'badge-success' : 'badge-warning'}`}>{s.published ? 'Published' : 'Draft'}</span></td>
                  <td>
                    {!s.published ? (
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => void onPublishShift(s.id)}>Publish</button>
                    ) : (
                      <span className="muted" style={{ fontSize: '12px' }}>Sent to crew</span>
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
          <h2>Field Technician Roster &amp; Billable Rates</h2>
        </div>
        <div className="panel-body">
          <div className="card-grid">
            {technicians.map((t) => {
              const techHours = shifts.filter((s) => s.technician_id === t.id).reduce((sum, s) => sum + s.hours, 0);
              return (
                <div key={t.id} className="kanban-card" style={{ cursor: 'default' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>{t.name}</strong>
                    <span className="badge badge-info">{t.territory}</span>
                  </div>
                  <div className="kanban-card-sub">{t.specialty}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span className="muted">{t.phone}</span>
                    <strong>{formatMoney(t.hourly_rate)}/hr</strong>
                  </div>
                  <div className="muted" style={{ fontSize: '12px' }}>Scheduled capacity: <strong>{techHours}h</strong></div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
