import React, { useState } from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import type { Appraisal, Payslip } from '../types';

interface AppraisalsViewProps {
  appraisals: Appraisal[];
  onUpdateAppraisal: (id: number, patch: { status: string; manager_rating: number }) => Promise<void>;
}

export const AppraisalsView: React.FC<AppraisalsViewProps> = ({ appraisals, onUpdateAppraisal }) => (
  <div className="panel">
    <div className="panel-header">
      <h2>Performance Appraisals &amp; OKR Reviews</h2>
      <span className="muted" style={{ fontSize: '12px' }}>Rate goals &amp; complete quarterly reviews</span>
    </div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Employee</th><th>Cycle</th><th>Goals / Focus</th><th>Self</th><th>Manager</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody>
          {appraisals.map((ap) => (
            <tr key={ap.id}>
              <td><strong>{ap.employee_name}</strong><div className="muted" style={{ fontSize: '11.5px' }}>Review {ap.review_date}</div></td>
              <td><span className="badge badge-neutral">{ap.cycle}</span></td>
              <td style={{ maxWidth: '300px' }}>{ap.goals}</td>
              <td style={{ color: '#d97706' }}>{'★'.repeat(ap.self_rating)}</td>
              <td style={{ color: '#059669' }}>{ap.manager_rating > 0 ? '★'.repeat(ap.manager_rating) : <span className="muted">Pending</span>}</td>
              <td>
                <span className={`badge ${ap.status === 'Completed' ? 'badge-success' : ap.status === 'In Review' ? 'badge-info' : 'badge-warning'}`}>
                  {ap.status}
                </span>
              </td>
              <td style={{ display: 'flex', gap: '6px' }}>
                {ap.status === 'Scheduled' && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void onUpdateAppraisal(ap.id, { status: 'In Review', manager_rating: 4 })}>Start Review</button>
                )}
                {ap.status !== 'Completed' && (
                  <button type="button" className="btn btn-sm btn-success" onClick={() => void onUpdateAppraisal(ap.id, { status: 'Completed', manager_rating: Math.max(4, ap.manager_rating || 5) })}>
                    Complete (5★)
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

interface PayrollViewProps {
  payslips: Payslip[];
  onRunPayroll: (period: string) => Promise<void>;
  onPaySlip: (id: number) => Promise<void>;
}

export const PayrollView: React.FC<PayrollViewProps> = ({ payslips, onRunPayroll, onPaySlip }) => {
  const [period, setPeriod] = useState('2026-11');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div className="panel">
        <div className="panel-body" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <div>
            <strong>Monthly Payroll Run Generator</strong>
            <div className="muted" style={{ fontSize: '12.5px' }}>Computes Gross, Tax Withholding (22%), Superannuation (11.5%) &amp; Net Pay for all active staff</div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input className="input" style={{ width: '130px' }} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" />
            <button type="button" className="btn btn-primary" onClick={() => void onRunPayroll(period)}>Generate Payslips</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><h2>Payslips Register</h2></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Slip #</th><th>Employee</th><th>Period</th><th className="num">Gross</th><th className="num">Tax</th><th className="num">Super</th><th className="num">Net Pay</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              {payslips.map((ps) => (
                <tr key={ps.id}>
                  <td><code>{ps.slip_number}</code></td>
                  <td><strong>{ps.employee_name}</strong></td>
                  <td>{ps.pay_period}</td>
                  <td className="num">{formatMoney(Number(ps.gross_pay))}</td>
                  <td className="num">{formatMoney(Number(ps.tax_withheld))}</td>
                  <td className="num">{formatMoney(Number(ps.super_contrib))}</td>
                  <td className="num"><strong>{formatMoney(Number(ps.net_pay))}</strong></td>
                  <td><span className={`badge ${ps.status === 'Paid' ? 'badge-success' : 'badge-warning'}`}>{ps.status}</span></td>
                  <td>
                    {ps.status !== 'Paid' ? (
                      <button type="button" className="btn btn-sm btn-success" onClick={() => void onPaySlip(ps.id)}>Confirm &amp; Pay</button>
                    ) : (
                      <span className="muted" style={{ fontSize: '12px' }}>Disbursed</span>
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
};
