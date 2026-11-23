import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../shared/ui/opal.css';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatAuDate, formatAud, formatNumber, initialsOf } from '../../../shared/ui/format';

interface PayrollOverview {
  activeEmployees: number;
  ytdGross: number;
  ytdPayg: number;
  ytdSuper: number;
  unpaidSuper: number;
  pendingStp: number;
  pendingLeave: number;
  pendingTimesheets: number;
  sgRatePercent: number;
}

interface Employee {
  id: number;
  emp_code: string;
  full_name: string;
  role_title: string;
  employment_type: string;
  stp_income_type: string;
  pay_basis: string;
  pay_rate: number;
  pay_frequency: string;
  tax_free_threshold: number;
  has_help_debt: number;
  super_fund: string;
  super_usi: string;
  annual_leave_hrs: number;
  personal_leave_hrs: number;
  ytd_gross: number;
  ytd_payg: number;
  ytd_super: number;
}

interface Payslip {
  id: number;
  pay_run_id: number;
  run_number: string;
  employee_id: number;
  employee_name: string;
  role_title: string;
  super_fund: string;
  super_usi: string;
  ordinary_hours: number;
  overtime_hours: number;
  ordinary_pay: number;
  overtime_pay: number;
  allowances: number;
  gross_pay: number;
  payg_tax: number;
  super_amount: number;
  net_pay: number;
  annual_leave_bal: number;
  personal_leave_bal: number;
  payment_date: string;
}

interface PayRun {
  id: number;
  run_number: string;
  frequency: string;
  period_start: string;
  period_end: string;
  payment_date: string;
  employee_count: number;
  total_gross: number;
  total_payg: number;
  total_super: number;
  total_net: number;
  stp_status: string;
  stp_receipt: string;
  super_status: string;
  super_ref: string;
  payslips: Payslip[];
}

interface Timesheet {
  id: number;
  employee_id: number;
  employee_name: string;
  week_ending: string;
  ordinary_hours: number;
  overtime_hours: number;
  job_code: string;
  status: string;
}

interface LeaveReq {
  id: number;
  employee_id: number;
  employee_name: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  hours: number;
  reason: string;
  status: string;
}

type TabKey = 'payruns' | 'employees' | 'stp' | 'team';

function App() {
  const [tab, setTab] = useState<TabKey>('payruns');
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [overview, setOverview] = useState<PayrollOverview | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payRuns, setPayRuns] = useState<PayRun[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [leaveReqs, setLeaveReqs] = useState<LeaveReq[]>([]);
  const [activePayslip, setActivePayslip] = useState<Payslip | null>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  // Pay Run Modal
  const [showRunModal, setShowRunModal] = useState(false);
  const [runFreq, setRunFreq] = useState('Fortnightly');
  const [runStart, setRunStart] = useState('2026-11-16');
  const [runEnd, setRunEnd] = useState('2026-11-29');
  const [runPayDate, setRunPayDate] = useState('2026-11-30');
  const [overtimeMap, setOvertimeMap] = useState<Record<number, number>>({});

  // Employee Modal
  const [showEmpModal, setShowEmpModal] = useState(false);
  const [empName, setEmpName] = useState('');
  const [empRole, setEmpRole] = useState('');
  const [empType, setEmpType] = useState('Full-Time');
  const [empBasis, setEmpBasis] = useState('Salary');
  const [empRate, setEmpRate] = useState('92000');
  const [empFund, setEmpFund] = useState('AustralianSuper');
  const [empHelp, setEmpHelp] = useState(false);

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast((prev) => (prev?.msg === msg ? null : prev)), 3400);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [rt, ov, em, pr, ts, lv] = await Promise.all([
        apiFetch<RuntimeInfo>('/api/runtime'),
        apiFetch<PayrollOverview>('/api/overview'),
        apiFetch<{ employees: Employee[] }>('/api/employees'),
        apiFetch<{ payRuns: PayRun[] }>('/api/pay-runs'),
        apiFetch<{ timesheets: Timesheet[] }>('/api/timesheets'),
        apiFetch<{ leaveRequests: LeaveReq[] }>('/api/leave'),
      ]);
      setRuntime(rt);
      setOverview(ov);
      setEmployees(em.employees);
      setPayRuns(pr.payRuns);
      setTimesheets(ts.timesheets);
      setLeaveReqs(lv.leaveRequests);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleRunPayroll = async (e: React.FormEvent) => {
    e.preventDefault();
    const hoursPayload: Record<string, { overtime: number }> = {};
    for (const [k, v] of Object.entries(overtimeMap)) {
      hoursPayload[k] = { overtime: v };
    }
    try {
      const res = await apiFetch<{ payRun: PayRun }>('/api/pay-runs', {
        method: 'POST',
        body: {
          frequency: runFreq,
          period_start: runStart,
          period_end: runEnd,
          payment_date: runPayDate,
          hours: hoursPayload,
        },
      });
      setShowRunModal(false);
      setOvertimeMap({});
      notify(`Processed ${res.payRun.run_number} · Gross ${formatAud(res.payRun.total_gross)} · Super (12%) ${formatAud(res.payRun.total_super)}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleLodgeStp = async (pr: PayRun) => {
    try {
      const res = await apiFetch<{ payRun: PayRun }>(`/api/pay-runs/${pr.id}/lodge-stp`, { method: 'POST', body: {} });
      notify(`STP Phase 2 accepted by ATO · Receipt ${res.payRun.stp_receipt}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handlePaySuper = async (pr: PayRun) => {
    try {
      const res = await apiFetch<{ payRun: PayRun }>(`/api/pay-runs/${pr.id}/pay-super`, { method: 'POST', body: {} });
      notify(`Pay Super batch submitted · Clearing Ref ${res.payRun.super_ref}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/employees', {
        method: 'POST',
        body: {
          full_name: empName,
          role_title: empRole,
          employment_type: empType,
          pay_basis: empBasis,
          pay_rate: Number(empRate),
          super_fund: empFund,
          has_help_debt: empHelp,
        },
      });
      setShowEmpModal(false);
      setEmpName('');
      setEmpRole('');
      notify(`Onboarded employee ${empName} for STP Phase 2 payroll`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleApproveTimesheet = async (ts: Timesheet) => {
    try {
      await apiFetch(`/api/timesheets/${ts.id}/approve`, { method: 'PATCH', body: {} });
      notify(`Approved timesheet for ${ts.employee_name}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleLeaveDecision = async (lv: LeaveReq, status: 'Approved' | 'Declined') => {
    try {
      await apiFetch(`/api/leave/${lv.id}/decide`, { method: 'PATCH', body: { status } });
      notify(`Leave request ${status.toLowerCase()} for ${lv.employee_name}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  return (
    <div className="opal-app">
      <header className="opal-topbar">
        <div className="opal-brand">
          <div className="opal-brand-mark" style={{ background: 'linear-gradient(135deg, #059669, #0d9488)' }}>PR</div>
          <div>
            <h1>Australian Payroll, STP Phase 2 &amp; Super</h1>
            <div className="opal-brand-sub">Unlimited Staff · Stage 3 PAYG · 12% Super Guarantee · ATO STP2 · MYOB Team Leave</div>
          </div>
        </div>

        <nav className="opal-tabs">
          <button className={`opal-tab ${tab === 'payruns' ? 'active' : ''}`} onClick={() => setTab('payruns')}>
            Pay Runs &amp; Payslips <span className="opal-tab-count">{payRuns.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'employees' ? 'active' : ''}`} onClick={() => setTab('employees')}>
            Employees <span className="opal-tab-count">{employees.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'stp' ? 'active' : ''}`} onClick={() => setTab('stp')}>
            STP Phase 2 &amp; Pay Super
          </button>
          <button className={`opal-tab ${tab === 'team' ? 'active' : ''}`} onClick={() => setTab('team')}>
            Timesheets &amp; Leave <span className="opal-tab-count">{(overview?.pendingLeave ?? 0) + (overview?.pendingTimesheets ?? 0)}</span>
          </button>
        </nav>

        <div className="opal-actions">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP · XDB' : 'Standalone PHP'}
            </span>
          )}
          <button className="btn btn-soft btn-sm" onClick={() => setShowEmpModal(true)}>+ Employee</button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowRunModal(true)}>Run Pay Run</button>
        </div>
      </header>

      <main className="opal-main">
        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #059669, #0d9488)' } as React.CSSProperties}>
              <div className="kpi-label">FY2026-27 YTD Gross Wages</div>
              <div className="kpi-value">{formatAud(overview.ytdGross)}</div>
              <div className="kpi-sub">{overview.activeEmployees} active staff · Unlimited employees included ($0/emp)</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #6100a5, #7c3aed)' } as React.CSSProperties}>
              <div className="kpi-label">YTD PAYG Tax Withheld (W2)</div>
              <div className="kpi-value text-brand">{formatAud(overview.ytdPayg)}</div>
              <div className="kpi-sub">Calculated via AU Stage 3 Brackets + 2% Medicare</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #d97706, #f59e0b)' } as React.CSSProperties}>
              <div className="kpi-label">Super Payable (12.0% SG)</div>
              <div className="kpi-value text-warning">{formatAud(overview.unpaidSuper)}</div>
              <div className="kpi-sub">YTD Super Accrued: {formatAud(overview.ytdSuper)}</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #2563eb, #0d9488)' } as React.CSSProperties}>
              <div className="kpi-label">ATO STP Phase 2 Queue</div>
              <div className="kpi-value">{overview.pendingStp === 0 ? 'All Lodged' : `${overview.pendingStp} Pending`}</div>
              <div className="kpi-sub">{overview.pendingLeave} leave · {overview.pendingTimesheets} timesheet approvals</div>
            </div>
          </section>
        )}

        {tab === 'payruns' && (
          <div className="stack" style={{ gap: 16 }}>
            {payRuns.map((pr) => (
              <section key={pr.id} className="panel">
                <div className="panel-head">
                  <div>
                    <div className="row">
                      <h2 className="panel-title">{pr.run_number} · {pr.frequency} Pay Run</h2>
                      <span className={`badge ${pr.stp_status === 'Accepted by ATO' ? 'badge-success' : 'badge-warning'}`}>
                        STP2: {pr.stp_status}
                      </span>
                      <span className={`badge ${pr.super_status === 'Paid' ? 'badge-opal' : 'badge-warning'}`}>
                        Super: {pr.super_status}
                      </span>
                    </div>
                    <div className="panel-subtitle">
                      Period: {formatAuDate(pr.period_start)} – {formatAuDate(pr.period_end)} · Payment Date: {formatAuDate(pr.payment_date)}
                      {pr.stp_receipt ? ` · ATO Receipt: ${pr.stp_receipt}` : ''}
                    </div>
                  </div>
                  <div className="row">
                    {pr.stp_status !== 'Accepted by ATO' && (
                      <button className="btn btn-primary btn-sm" onClick={() => void handleLodgeStp(pr)}>Lodge STP Phase 2 to ATO</button>
                    )}
                    {pr.super_status !== 'Paid' && (
                      <button className="btn btn-opal btn-sm" onClick={() => void handlePaySuper(pr)}>Pay Super ({formatAud(pr.total_super)})</button>
                    )}
                  </div>
                </div>
                <div className="panel-body" style={{ paddingBottom: 8 }}>
                  <div className="grid-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
                    <div><div className="muted">Total Gross</div><div className="money fw-700" style={{ fontSize: 16 }}>{formatAud(pr.total_gross)}</div></div>
                    <div><div className="muted">PAYG Tax Withheld</div><div className="money fw-700 text-danger" style={{ fontSize: 16 }}>{formatAud(pr.total_payg)}</div></div>
                    <div><div className="muted">Super Guarantee (12%)</div><div className="money fw-700 text-brand" style={{ fontSize: 16 }}>{formatAud(pr.total_super)}</div></div>
                    <div><div className="muted">Net Bank ABA Total</div><div className="money fw-700 text-success" style={{ fontSize: 16 }}>{formatAud(pr.total_net)}</div></div>
                  </div>
                </div>
                {pr.payslips.length > 0 && (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th className="right">Hrs (Ord/OT)</th>
                          <th className="right">Gross Pay</th>
                          <th className="right">PAYG Tax</th>
                          <th className="right">Super (12%)</th>
                          <th className="right">Net Pay</th>
                          <th className="right">Payslip</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pr.payslips.map((ps) => (
                          <tr key={ps.id}>
                            <td>
                              <div className="fw-700">{ps.employee_name}</div>
                              <div className="row-sub">{ps.role_title} · {ps.super_fund}</div>
                            </td>
                            <td className="right num">{ps.ordinary_hours}h {ps.overtime_hours > 0 ? `+ ${ps.overtime_hours}h OT` : ''}</td>
                            <td className="right money">{formatAud(ps.gross_pay)}</td>
                            <td className="right money text-danger">-{formatAud(ps.payg_tax)}</td>
                            <td className="right money text-brand">{formatAud(ps.super_amount)}</td>
                            <td className="right money fw-700 text-success">{formatAud(ps.net_pay)}</td>
                            <td className="right">
                              <button className="btn btn-soft btn-xs" onClick={() => setActivePayslip(ps)}>View Payslip</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        {tab === 'employees' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Employee Directory &amp; NES Leave Balances</h2>
                <div className="panel-subtitle">STP Phase 2 Income Stream classification, Superannuation fund USI, and National Employment Standards leave accruals.</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowEmpModal(true)}>+ Add Employee</button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Basis &amp; Rate</th>
                    <th>STP2 / Tax Flags</th>
                    <th>Super Fund (12%)</th>
                    <th className="right">Annual Leave</th>
                    <th className="right">Personal Leave</th>
                    <th className="right">YTD Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <div className="row-nowrap">
                          <div className="avatar">{initialsOf(e.full_name)}</div>
                          <div>
                            <div className="fw-700">{e.full_name}</div>
                            <div className="row-sub">{e.emp_code} · {e.role_title}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="fw-700 money">{e.pay_basis === 'Salary' ? `${formatAud(e.pay_rate)}/yr` : `${formatAud(e.pay_rate)}/hr`}</div>
                        <div className="row-sub">{e.employment_type} · {e.pay_frequency}</div>
                      </td>
                      <td>
                        <span className="badge badge-brand">{e.stp_income_type}</span>{' '}
                        {e.has_help_debt === 1 && <span className="badge badge-warning">HELP</span>}
                      </td>
                      <td>
                        <div className="fw-700">{e.super_fund}</div>
                        <div className="row-sub">USI {e.super_usi}</div>
                      </td>
                      <td className="right num fw-700">{formatNumber(e.annual_leave_hrs, 1)} hrs</td>
                      <td className="right num">{formatNumber(e.personal_leave_hrs, 1)} hrs</td>
                      <td className="right money fw-700">{formatAud(e.ytd_gross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'stp' && (
          <div className="grid-2">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2 className="panel-title">Single Touch Payroll (STP Phase 2) Centre</h2>
                  <div className="panel-subtitle">Disaggregated gross reporting directly to the Australian Taxation Office (ATO).</div>
                </div>
              </div>
              <div className="panel-body stack">
                {payRuns.map((pr) => (
                  <div key={pr.id} className="callout">
                    <div>
                      <div className="fw-700">{pr.run_number} · {formatAuDate(pr.payment_date)}</div>
                      <div className="row-sub">Gross {formatAud(pr.total_gross)} · PAYG {formatAud(pr.total_payg)} · Super {formatAud(pr.total_super)}</div>
                      {pr.stp_receipt && <div className="row-sub text-brand fw-700">Receipt: {pr.stp_receipt}</div>}
                    </div>
                    {pr.stp_status === 'Accepted by ATO' ? (
                      <span className="badge badge-success">ATO Accepted</span>
                    ) : (
                      <button className="btn btn-primary btn-xs" onClick={() => void handleLodgeStp(pr)}>Lodge STP2</button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2 className="panel-title">Pay Super Clearing House (12% SG)</h2>
                  <div className="panel-subtitle">SuperStream compliant clearing batches across AustralianSuper, Aware, Hostplus &amp; REST.</div>
                </div>
              </div>
              <div className="panel-body stack">
                {payRuns.map((pr) => (
                  <div key={pr.id} className="callout">
                    <div>
                      <div className="fw-700">{pr.run_number} · {formatAud(pr.total_super)} SG</div>
                      <div className="row-sub">{pr.employee_count} employees · Period ending {formatAuDate(pr.period_end)}</div>
                      {pr.super_ref && <div className="row-sub text-opal fw-700">Clearing Ref: {pr.super_ref}</div>}
                    </div>
                    {pr.super_status === 'Paid' ? (
                      <span className="badge badge-opal">Super Paid</span>
                    ) : (
                      <button className="btn btn-opal btn-xs" onClick={() => void handlePaySuper(pr)}>Pay Batch</button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {tab === 'team' && (
          <div className="grid-2">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2 className="panel-title">Employee Timesheets</h2>
                  <div className="panel-subtitle">Approve ordinary &amp; overtime hours submitted via self-service.</div>
                </div>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Week Ending</th>
                      <th className="right">Hours</th>
                      <th>Job</th>
                      <th>Status</th>
                      <th className="right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timesheets.map((ts) => (
                      <tr key={ts.id}>
                        <td className="fw-700">{ts.employee_name}</td>
                        <td>{formatAuDate(ts.week_ending)}</td>
                        <td className="right num">{ts.ordinary_hours}h {ts.overtime_hours > 0 ? `+ ${ts.overtime_hours}h OT` : ''}</td>
                        <td><span className="badge badge-neutral">{ts.job_code}</span></td>
                        <td><span className={`badge ${ts.status === 'Approved' ? 'badge-success' : 'badge-warning'}`}>{ts.status}</span></td>
                        <td className="right">
                          {ts.status === 'Submitted' && (
                            <button className="btn btn-opal btn-xs" onClick={() => void handleApproveTimesheet(ts)}>Approve</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2 className="panel-title">NES Leave Requests</h2>
                  <div className="panel-subtitle">Approving automatically deducts hours from the employee's leave balance.</div>
                </div>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Employee &amp; Leave</th>
                      <th>Dates</th>
                      <th className="right">Hours</th>
                      <th>Status</th>
                      <th className="right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaveReqs.map((lv) => (
                      <tr key={lv.id}>
                        <td>
                          <div className="fw-700">{lv.employee_name}</div>
                          <div className="row-sub">{lv.leave_type} · {lv.reason}</div>
                        </td>
                        <td>{formatAuDate(lv.start_date)} – {formatAuDate(lv.end_date)}</td>
                        <td className="right num fw-700">{lv.hours}h</td>
                        <td><span className={`badge ${lv.status === 'Approved' ? 'badge-success' : lv.status === 'Declined' ? 'badge-danger' : 'badge-warning'}`}>{lv.status}</span></td>
                        <td className="right">
                          {lv.status === 'Pending' && (
                            <div className="row" style={{ justifyContent: 'flex-end', gap: 5 }}>
                              <button className="btn btn-opal btn-xs" onClick={() => void handleLeaveDecision(lv, 'Approved')}>Approve</button>
                              <button className="btn btn-danger btn-xs" onClick={() => void handleLeaveDecision(lv, 'Declined')}>Decline</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Run Pay Run Modal */}
      {showRunModal && (
        <div className="modal-backdrop" onClick={() => setShowRunModal(false)}>
          <form className="modal modal-lg" onClick={(e) => e.stopPropagation()} onSubmit={handleRunPayroll}>
            <div className="modal-head">
              <h2>Process Australian Pay Run (Stage 3 PAYG + 12% Super)</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowRunModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid-3">
                <div className="field">
                  <label>Pay Frequency</label>
                  <select className="select" value={runFreq} onChange={(e) => setRunFreq(e.target.value)}>
                    <option>Fortnightly</option>
                    <option>Weekly</option>
                    <option>Monthly</option>
                  </select>
                </div>
                <div className="field">
                  <label>Period Start</label>
                  <input className="input" type="date" value={runStart} onChange={(e) => setRunStart(e.target.value)} />
                </div>
                <div className="field">
                  <label>Payment Date</label>
                  <input className="input" type="date" value={runPayDate} onChange={(e) => setRunPayDate(e.target.value)} />
                </div>
              </div>
              <div className="line-editor">
                <table>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Employment</th>
                      <th>Base Rate</th>
                      <th style={{ width: 120 }}>Overtime Hrs (1.5×)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((e) => (
                      <tr key={e.id}>
                        <td className="fw-700">{e.full_name}</td>
                        <td><span className="badge badge-neutral">{e.employment_type}</span></td>
                        <td className="money">{e.pay_basis === 'Salary' ? `${formatAud(e.pay_rate)}/yr` : `${formatAud(e.pay_rate)}/hr`}</td>
                        <td>
                          <input
                            className="input num"
                            type="number"
                            min="0"
                            step="0.5"
                            value={overtimeMap[e.id] ?? 0}
                            onChange={(ev) => setOvertimeMap((p) => ({ ...p, [e.id]: Number(ev.target.value) }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="callout callout-brand">
                <div>PHP backend automatically calculates Australian Stage 3 PAYG tax withholding, 2% Medicare Levy, HELP repayments, 12% SG Superannuation on OTE, and NES leave accruals.</div>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowRunModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Finalise Pay Run &amp; Generate Payslips</button>
            </div>
          </form>
        </div>
      )}

      {/* Fair Work Payslip Preview Modal */}
      {activePayslip && (
        <div className="modal-backdrop" onClick={() => setActivePayslip(null)}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Fair Work Compliant Payslip · {activePayslip.run_number}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setActivePayslip(null)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="doc-sheet">
                <div className="doc-sheet-header">
                  <div>
                    <div className="fw-700" style={{ fontSize: 17, color: 'var(--brand)' }}>Harbourview Digital Pty Ltd</div>
                    <div className="muted">ABN 53 004 085 616 · Sydney NSW 2000</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="fw-700" style={{ fontSize: 18 }}>PAYSLIP</div>
                    <div className="muted">Pay Date: {formatAuDate(activePayslip.payment_date)}</div>
                  </div>
                </div>
                <div className="form-grid" style={{ marginBottom: 14 }}>
                  <div>
                    <div className="fw-700">{activePayslip.employee_name}</div>
                    <div className="muted">{activePayslip.role_title}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div>Super Fund: <strong>{activePayslip.super_fund}</strong></div>
                    <div className="muted">USI: {activePayslip.super_usi} · Rate: 12.0% SG</div>
                  </div>
                </div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>STP Phase 2 Disaggregated Item</th>
                      <th className="right">Hours</th>
                      <th className="right">Amount (AUD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><td>Ordinary Time Earnings (SAW)</td><td className="right num">{activePayslip.ordinary_hours}h</td><td className="right money">{formatAud(activePayslip.ordinary_pay)}</td></tr>
                    {activePayslip.overtime_pay > 0 && (
                      <tr><td>Overtime Earnings (1.5×)</td><td className="right num">{activePayslip.overtime_hours}h</td><td className="right money">{formatAud(activePayslip.overtime_pay)}</td></tr>
                    )}
                    <tr><td className="fw-700">Gross Earnings</td><td></td><td className="right money fw-700">{formatAud(activePayslip.gross_pay)}</td></tr>
                    <tr><td>PAYG Tax Withheld (ATO)</td><td></td><td className="right money text-danger">-{formatAud(activePayslip.payg_tax)}</td></tr>
                    <tr><td className="fw-700">Net Pay Deposited (EFT)</td><td></td><td className="right money fw-700 text-success">{formatAud(activePayslip.net_pay)}</td></tr>
                    <tr><td>Employer Superannuation Guarantee (12.0%)</td><td></td><td className="right money text-brand">{formatAud(activePayslip.super_amount)}</td></tr>
                  </tbody>
                </table>
                <div className="callout callout-brand" style={{ marginTop: 14 }}>
                  <div><strong>NES Leave Balances:</strong> Annual Leave: <strong>{formatNumber(activePayslip.annual_leave_bal, 1)} hrs</strong> · Personal/Carer&apos;s Leave: <strong>{formatNumber(activePayslip.personal_leave_bal, 1)} hrs</strong></div>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setActivePayslip(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* New Employee Modal */}
      {showEmpModal && (
        <div className="modal-backdrop" onClick={() => setShowEmpModal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateEmployee}>
            <div className="modal-head">
              <h2>Add Australian Employee (STP Phase 2)</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowEmpModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field">
                  <label>Full Name</label>
                  <input className="input" required value={empName} onChange={(e) => setEmpName(e.target.value)} placeholder="e.g. Emma Gallagher" />
                </div>
                <div className="field">
                  <label>Role Title</label>
                  <input className="input" required value={empRole} onChange={(e) => setEmpRole(e.target.value)} placeholder="e.g. Account Executive" />
                </div>
                <div className="field">
                  <label>Employment Type</label>
                  <select className="select" value={empType} onChange={(e) => setEmpType(e.target.value)}>
                    <option>Full-Time</option>
                    <option>Part-Time</option>
                    <option>Casual</option>
                  </select>
                </div>
                <div className="field">
                  <label>Pay Basis</label>
                  <select className="select" value={empBasis} onChange={(e) => setEmpBasis(e.target.value)}>
                    <option>Salary</option>
                    <option>Hourly</option>
                  </select>
                </div>
                <div className="field">
                  <label>{empBasis === 'Salary' ? 'Annual Salary (AUD)' : 'Hourly Rate (AUD)'}</label>
                  <input className="input num" type="number" step="0.01" required value={empRate} onChange={(e) => setEmpRate(e.target.value)} />
                </div>
                <div className="field">
                  <label>Superannuation Fund</label>
                  <select className="select" value={empFund} onChange={(e) => setEmpFund(e.target.value)}>
                    <option>AustralianSuper</option>
                    <option>Aware Super</option>
                    <option>Hostplus Super</option>
                    <option>REST Industry Super</option>
                  </select>
                </div>
              </div>
              <label className="row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={empHelp} onChange={(e) => setEmpHelp(e.target.checked)} />
                <span>Employee has HELP / HECS-HELP study loan withholding</span>
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowEmpModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save Employee</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
