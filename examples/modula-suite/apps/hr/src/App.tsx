import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatCompactMoney } from '../../../shared/ui/format';
import { AppraisalsView, PayrollView } from './components/AppraisalsAndPayrollView';
import { AttendanceView } from './components/AttendanceView';
import { EmployeesView } from './components/EmployeesView';
import { RecruitmentAtsView, TimeOffView } from './components/TimeOffAndAtsView';
import type { Appraisal, Attendance, Candidate, Employee, HrOverview, LeaveRequest, Payslip } from './types';

export function App() {
  const [tab, setTab] = useState<'employees' | 'attendance' | 'leaves' | 'ats' | 'appraisals' | 'payroll'>('employees');
  const [overview, setOverview] = useState<HrOverview | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendances, setAttendances] = useState<Attendance[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [appraisals, setAppraisals] = useState<Appraisal[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showNewEmp, setShowNewEmp] = useState(false);
  const [empForm, setEmpForm] = useState({ name: '', role_title: '', department: 'Engineering', email: '', location: 'Sydney', base_salary: '110000' });

  const [showNewLeave, setShowNewLeave] = useState(false);
  const [leaveForm, setLeaveForm] = useState({ employee_id: '1', leave_type: 'Annual Leave', start_date: '2026-12-10', end_date: '2026-12-12', days: '3', reason: '' });

  const [showNewCand, setShowNewCand] = useState(false);
  const [candForm, setCandForm] = useState({ name: '', role_applied: '', department: 'Engineering', email: '', rating: '4', notes: '' });

  const [showNewAppraisal, setShowNewAppraisal] = useState(false);
  const [apForm, setApForm] = useState({ employee_id: '1', cycle: '2027 Q1', goals: '', self_rating: '4' });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, eRes, aRes, lRes, cRes, apRes, pRes, rt] = await Promise.all([
        apiFetch<HrOverview>('/api/overview'),
        apiFetch<{ employees: Employee[] }>('/api/employees'),
        apiFetch<{ attendances: Attendance[] }>('/api/attendances'),
        apiFetch<{ leaves: LeaveRequest[] }>('/api/leaves'),
        apiFetch<{ candidates: Candidate[] }>('/api/candidates'),
        apiFetch<{ appraisals: Appraisal[] }>('/api/appraisals'),
        apiFetch<{ payslips: Payslip[] }>('/api/payslips'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setEmployees(eRes.employees);
      setAttendances(aRes.attendances);
      setLeaves(lRes.leaves);
      setCandidates(cRes.candidates);
      setAppraisals(apRes.appraisals);
      setPayslips(pRes.payslips);
      setRuntime(rt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleToggleCheckIn = async (employeeId: number) => {
    const res = await apiFetch<{ action: string }>('/api/attendances/toggle', { method: 'POST', body: { employee_id: employeeId } });
    await loadAll();
    notify(res.action === 'checked_in' ? 'Employee checked in' : 'Employee checked out & shift hours logged');
  };

  const handleEditEmployee = async (id: number, patch: Partial<Employee>) => {
    await apiFetch(`/api/employees/${id}`, { method: 'PUT', body: patch });
    await loadAll();
    notify('Employee profile updated');
  };

  const handleLeaveDecision = async (id: number, status: 'Approved' | 'Rejected') => {
    await apiFetch(`/api/leaves/${id}/decision`, { method: 'PATCH', body: { status } });
    await loadAll();
    notify(`Leave request ${status.toLowerCase()}`);
  };

  const handleAtsAdvance = async (cand: Candidate, stage: string) => {
    await apiFetch(`/api/candidates/${cand.id}/stage`, { method: 'PATCH', body: { stage } });
    await loadAll();
    notify(stage === 'Hired' ? `${cand.name} hired and added to Employees!` : `${cand.name} moved to ${stage}`);
  };

  const handleUpdateAppraisal = async (id: number, patch: { status: string; manager_rating: number }) => {
    await apiFetch(`/api/appraisals/${id}`, { method: 'PATCH', body: patch });
    await loadAll();
    notify('Appraisal updated');
  };

  const handleRunPayroll = async (period: string) => {
    const res = await apiFetch<{ created: number }>('/api/payroll/run', { method: 'POST', body: { pay_period: period } });
    await loadAll();
    notify(res.created > 0 ? `Generated ${res.created} payslip(s) for ${period}` : `Payslips already generated for ${period}`);
  };

  const handlePaySlip = async (id: number) => {
    await apiFetch(`/api/payslips/${id}/pay`, { method: 'PATCH' });
    await loadAll();
    notify('Payslip confirmed & marked Paid');
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/employees', { method: 'POST', body: { ...empForm, base_salary: Number(empForm.base_salary) || 100000 } });
    setShowNewEmp(false);
    setEmpForm({ name: '', role_title: '', department: 'Engineering', email: '', location: 'Sydney', base_salary: '110000' });
    await loadAll();
    notify('Employee added');
  };

  const handleCreateLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/leaves', { method: 'POST', body: { ...leaveForm, employee_id: Number(leaveForm.employee_id), days: Number(leaveForm.days) || 1 } });
    setShowNewLeave(false);
    await loadAll();
    notify('Leave request submitted');
  };

  const handleCreateCandidate = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/candidates', { method: 'POST', body: { ...candForm, rating: Number(candForm.rating) || 3 } });
    setShowNewCand(false);
    setCandForm({ name: '', role_applied: '', department: 'Engineering', email: '', rating: '4', notes: '' });
    await loadAll();
    notify('Candidate added');
  };

  const handleCreateAppraisal = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/appraisals', { method: 'POST', body: { ...apForm, employee_id: Number(apForm.employee_id), self_rating: Number(apForm.self_rating) || 4 } });
    setShowNewAppraisal(false);
    setApForm({ employee_id: employees[0] ? String(employees[0].id) : '1', cycle: '2027 Q1', goals: '', self_rating: '4' });
    await loadAll();
    notify('Appraisal scheduled');
  };

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#db2777', ['--accent-soft' as string]: '#fce7f3', ['--accent-ink' as string]: '#9d174d' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">HR</div>
          <div>
            <h1>HR, Attendance &amp; Payroll</h1>
            <div className="erp-brand-sub">Directory, Shift Kiosk, Time Off, Recruitment ATS, Appraisals &amp; Payslips</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="HR sections">
          <button type="button" className={`erp-tab ${tab === 'employees' ? 'active' : ''}`} onClick={() => setTab('employees')}>Employees ({employees.length})</button>
          <button type="button" className={`erp-tab ${tab === 'attendance' ? 'active' : ''}`} onClick={() => setTab('attendance')}>Attendance ({overview?.checkedInCount ?? 0} in)</button>
          <button type="button" className={`erp-tab ${tab === 'leaves' ? 'active' : ''}`} onClick={() => setTab('leaves')}>Time Off ({overview?.pendingLeaves ?? 0})</button>
          <button type="button" className={`erp-tab ${tab === 'ats' ? 'active' : ''}`} onClick={() => setTab('ats')}>Recruitment ({candidates.length})</button>
          <button type="button" className={`erp-tab ${tab === 'appraisals' ? 'active' : ''}`} onClick={() => setTab('appraisals')}>Appraisals ({appraisals.length})</button>
          <button type="button" className={`erp-tab ${tab === 'payroll' ? 'active' : ''}`} onClick={() => setTab('payroll')}>Payroll ({payslips.length})</button>
        </nav>

        <div className="erp-actions">
          {tab === 'employees' && <button type="button" className="btn btn-primary" onClick={() => setShowNewEmp(true)}>+ Employee</button>}
          {tab === 'leaves' && <button type="button" className="btn btn-primary" onClick={() => setShowNewLeave(true)}>+ Time Off</button>}
          {tab === 'ats' && <button type="button" className="btn btn-primary" onClick={() => setShowNewCand(true)}>+ Candidate</button>}
          {tab === 'appraisals' && <button type="button" className="btn btn-primary" onClick={() => setShowNewAppraisal(true)}>+ Appraisal</button>}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Team Headcount</span>
              <span className="kpi-value">{overview.headcount}</span>
              <span className="kpi-sub">{overview.checkedInCount} clocked in · {overview.onLeaveCount} on leave</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Pending Leave &amp; Reviews</span>
              <span className="kpi-value" style={{ color: overview.pendingLeaves > 0 ? '#d97706' : '#059669' }}>{overview.pendingLeaves} / {overview.openAppraisals}</span>
              <span className="kpi-sub">Leave approvals · Open appraisals</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Active Candidates</span>
              <span className="kpi-value">{overview.openCandidates}</span>
              <span className="kpi-sub">Open ATS pipeline</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Est. Monthly Payroll</span>
              <span className="kpi-value">{formatCompactMoney(overview.monthlyPayroll)}</span>
              <span className="kpi-sub">Gross monthly base run-rate</span>
            </div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading HR records from PHP + XDB SQLite...</div></div>
        ) : tab === 'employees' ? (
          <EmployeesView employees={employees} onEditEmployee={handleEditEmployee} onToggleCheckIn={handleToggleCheckIn} />
        ) : tab === 'attendance' ? (
          <AttendanceView employees={employees} attendances={attendances} onToggleCheckIn={handleToggleCheckIn} />
        ) : tab === 'leaves' ? (
          <TimeOffView leaves={leaves} onDecision={handleLeaveDecision} />
        ) : tab === 'ats' ? (
          <RecruitmentAtsView candidates={candidates} onAdvance={handleAtsAdvance} />
        ) : tab === 'appraisals' ? (
          <AppraisalsView appraisals={appraisals} onUpdateAppraisal={handleUpdateAppraisal} />
        ) : (
          <PayrollView payslips={payslips} onRunPayroll={handleRunPayroll} onPaySlip={handlePaySlip} />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula HR, Attendance &amp; Payroll · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showNewEmp && (
        <div className="modal-backdrop" onClick={() => setShowNewEmp(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateEmployee(e)}>
            <div className="modal-head"><h3>Add Employee</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewEmp(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Name *</label><input className="input" required value={empForm.name} onChange={(e) => setEmpForm({ ...empForm, name: e.target.value })} /></div>
                <div className="field"><label>Role *</label><input className="input" required value={empForm.role_title} onChange={(e) => setEmpForm({ ...empForm, role_title: e.target.value })} /></div>
                <div className="field"><label>Department</label><input className="input" value={empForm.department} onChange={(e) => setEmpForm({ ...empForm, department: e.target.value })} /></div>
                <div className="field"><label>Location</label><input className="input" value={empForm.location} onChange={(e) => setEmpForm({ ...empForm, location: e.target.value })} /></div>
                <div className="field"><label>Annual Salary ($)</label><input className="input" type="number" value={empForm.base_salary} onChange={(e) => setEmpForm({ ...empForm, base_salary: e.target.value })} /></div>
                <div className="field"><label>Email</label><input className="input" type="email" value={empForm.email} onChange={(e) => setEmpForm({ ...empForm, email: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewEmp(false)}>Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
          </form>
        </div>
      )}

      {showNewLeave && (
        <div className="modal-backdrop" onClick={() => setShowNewLeave(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateLeave(e)}>
            <div className="modal-head"><h3>Request Time Off</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewLeave(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Employee</label><select className="select" value={leaveForm.employee_id} onChange={(e) => setLeaveForm({ ...leaveForm, employee_id: e.target.value })}>{employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name} ({emp.leave_balance}d)</option>)}</select></div>
                <div className="field"><label>Type</label><select className="select" value={leaveForm.leave_type} onChange={(e) => setLeaveForm({ ...leaveForm, leave_type: e.target.value })}><option value="Annual Leave">Annual Leave</option><option value="Sick Leave">Sick Leave</option><option value="Personal">Personal</option></select></div>
                <div className="field"><label>Start</label><input className="input" type="date" value={leaveForm.start_date} onChange={(e) => setLeaveForm({ ...leaveForm, start_date: e.target.value })} /></div>
                <div className="field"><label>End</label><input className="input" type="date" value={leaveForm.end_date} onChange={(e) => setLeaveForm({ ...leaveForm, end_date: e.target.value })} /></div>
                <div className="field"><label>Days</label><input className="input" type="number" step="0.5" min="0.5" value={leaveForm.days} onChange={(e) => setLeaveForm({ ...leaveForm, days: e.target.value })} /></div>
                <div className="field full"><label>Reason</label><input className="input" value={leaveForm.reason} onChange={(e) => setLeaveForm({ ...leaveForm, reason: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewLeave(false)}>Cancel</button><button type="submit" className="btn btn-primary">Submit</button></div>
          </form>
        </div>
      )}

      {showNewCand && (
        <div className="modal-backdrop" onClick={() => setShowNewCand(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateCandidate(e)}>
            <div className="modal-head"><h3>Add Candidate</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewCand(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Name *</label><input className="input" required value={candForm.name} onChange={(e) => setCandForm({ ...candForm, name: e.target.value })} /></div>
                <div className="field"><label>Role *</label><input className="input" required value={candForm.role_applied} onChange={(e) => setCandForm({ ...candForm, role_applied: e.target.value })} /></div>
                <div className="field"><label>Department</label><input className="input" value={candForm.department} onChange={(e) => setCandForm({ ...candForm, department: e.target.value })} /></div>
                <div className="field"><label>Email</label><input className="input" type="email" value={candForm.email} onChange={(e) => setCandForm({ ...candForm, email: e.target.value })} /></div>
                <div className="field full"><label>Notes</label><textarea className="textarea" value={candForm.notes} onChange={(e) => setCandForm({ ...candForm, notes: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewCand(false)}>Cancel</button><button type="submit" className="btn btn-primary">Add</button></div>
          </form>
        </div>
      )}

      {showNewAppraisal && (
        <div className="modal-backdrop" onClick={() => setShowNewAppraisal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateAppraisal(e)}>
            <div className="modal-head"><h3>Schedule Performance Appraisal</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewAppraisal(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Employee</label><select className="select" value={apForm.employee_id} onChange={(e) => setApForm({ ...apForm, employee_id: e.target.value })}>{employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name}</option>)}</select></div>
                <div className="field"><label>Cycle</label><input className="input" value={apForm.cycle} onChange={(e) => setApForm({ ...apForm, cycle: e.target.value })} /></div>
                <div className="field full"><label>Goals / OKRs *</label><textarea className="textarea" required value={apForm.goals} onChange={(e) => setApForm({ ...apForm, goals: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewAppraisal(false)}>Cancel</button><button type="submit" className="btn btn-primary">Schedule</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
