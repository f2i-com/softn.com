import React, { useState } from 'react';
import { formatMoney, formatNumber, initialsOf } from '../../../../shared/ui/format';
import type { Employee } from '../types';

interface EmployeesViewProps {
  employees: Employee[];
  onEditEmployee: (id: number, patch: Partial<Employee>) => Promise<void>;
  onToggleCheckIn: (employeeId: number) => Promise<void>;
}

export const EmployeesView: React.FC<EmployeesViewProps> = ({
  employees,
  onEditEmployee,
  onToggleCheckIn,
}) => {
  const [deptFilter, setDeptFilter] = useState('All');
  const [editing, setEditing] = useState<Employee | null>(null);

  const departments = ['All', ...Array.from(new Set(employees.map((e) => e.department)))];
  const visible = deptFilter === 'All' ? employees : employees.filter((e) => e.department === deptFilter);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    await onEditEmployee(editing.id, {
      role_title: editing.role_title,
      department: editing.department,
      location: editing.location,
      base_salary: Number(editing.base_salary) || 0,
      status: editing.status,
      leave_balance: Number(editing.leave_balance) || 0,
    });
    setEditing(null);
  };

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          {departments.map((d) => (
            <button key={d} type="button" className={`btn btn-sm ${deptFilter === d ? 'btn-primary' : ''}`} onClick={() => setDeptFilter(d)}>
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="card-grid">
        {visible.map((emp) => (
          <div key={emp.id} className="panel">
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <div className="avatar">{initialsOf(emp.name)}</div>
                  <div>
                    <div style={{ fontWeight: 700 }}>{emp.name}</div>
                    <div className="muted" style={{ fontSize: '12px' }}>{emp.role_title}</div>
                  </div>
                </div>
                <span className={`badge ${emp.status === 'Active' ? 'badge-success' : 'badge-warning'}`}>{emp.status}</span>
              </div>

              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <span className="badge badge-accent">{emp.department}</span>
                <span className="badge badge-neutral">{emp.location}</span>
                <span className="badge badge-info">{formatNumber(Number(emp.leave_balance), 1)}d leave</span>
                {emp.checked_in && <span className="badge badge-success">● In since {emp.check_in_time}</span>}
              </div>

              <div className="muted" style={{ fontSize: '12px' }}>
                Reports to: {emp.manager_name} · Salary: <strong>{formatMoney(Number(emp.base_salary))}/yr</strong>
              </div>
              <div className="muted" style={{ fontSize: '11.5px' }}>{emp.email} · Started {emp.start_date}</div>

              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '6px', borderTop: '1px solid var(--border)' }}>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(emp)}>Edit Profile</button>
                <button
                  type="button"
                  className={`btn btn-sm ${emp.checked_in ? 'btn-danger' : 'btn-success'}`}
                  onClick={() => void onToggleCheckIn(emp.id)}
                >
                  {emp.checked_in ? 'Check Out' : 'Check In'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleSave(e)}>
            <div className="modal-head">
              <h3>Edit Profile — {editing.name}</h3>
              <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Role Title</label><input className="input" value={editing.role_title} onChange={(e) => setEditing({ ...editing, role_title: e.target.value })} /></div>
                <div className="field"><label>Department</label><input className="input" value={editing.department} onChange={(e) => setEditing({ ...editing, department: e.target.value })} /></div>
                <div className="field"><label>Location</label><input className="input" value={editing.location} onChange={(e) => setEditing({ ...editing, location: e.target.value })} /></div>
                <div className="field">
                  <label>Status</label>
                  <select className="select" value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                    <option value="Active">Active</option><option value="On Leave">On Leave</option><option value="Contractor">Contractor</option>
                  </select>
                </div>
                <div className="field"><label>Annual Salary ($)</label><input className="input" type="number" value={editing.base_salary} onChange={(e) => setEditing({ ...editing, base_salary: Number(e.target.value) })} /></div>
                <div className="field"><label>Leave Balance (days)</label><input className="input" type="number" step="0.5" value={editing.leave_balance} onChange={(e) => setEditing({ ...editing, leave_balance: Number(e.target.value) })} /></div>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save Changes</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
};
