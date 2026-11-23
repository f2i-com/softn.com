import React from 'react';
import { formatNumber, initialsOf } from '../../../../shared/ui/format';
import type { Attendance, Employee } from '../types';

interface AttendanceViewProps {
  employees: Employee[];
  attendances: Attendance[];
  onToggleCheckIn: (employeeId: number) => Promise<void>;
}

export const AttendanceView: React.FC<AttendanceViewProps> = ({
  employees,
  attendances,
  onToggleCheckIn,
}) => {
  return (
    <div className="split-2">
      <div className="panel">
        <div className="panel-header">
          <h2>Live Check-In / Check-Out Kiosk</h2>
          <span className="muted" style={{ fontSize: '12px' }}>1-click shift attendance tracking</span>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {employees.map((emp) => (
            <div
              key={emp.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 12px',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                background: emp.checked_in ? '#ecfdf5' : 'var(--surface-subtle)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div className="avatar">{initialsOf(emp.name)}</div>
                <div>
                  <strong>{emp.name}</strong>
                  <div className="muted" style={{ fontSize: '12px' }}>
                    {emp.checked_in ? `Clocked in at ${emp.check_in_time}` : `${emp.department} · Off shift`}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className={`btn btn-sm ${emp.checked_in ? 'btn-danger' : 'btn-success'}`}
                onClick={() => void onToggleCheckIn(emp.id)}
              >
                {emp.checked_in ? 'Check Out' : 'Check In'}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><h2>Attendance Log</h2></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Employee</th><th>Check In</th><th>Check Out</th><th className="num">Hours</th><th>Status</th></tr>
            </thead>
            <tbody>
              {attendances.map((a) => (
                <tr key={a.id}>
                  <td>{a.work_date}</td>
                  <td><strong>{a.employee_name}</strong></td>
                  <td>{a.check_in}</td>
                  <td>{a.check_out || '-'}</td>
                  <td className="num">{a.worked_hours > 0 ? `${formatNumber(Number(a.worked_hours), 1)} h` : '-'}</td>
                  <td><span className={`badge ${a.status === 'Checked In' ? 'badge-success' : 'badge-neutral'}`}>{a.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
