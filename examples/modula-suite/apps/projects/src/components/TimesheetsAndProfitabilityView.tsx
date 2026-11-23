import React from 'react';
import { formatMoney, formatNumber, formatPercent } from '../../../../shared/ui/format';
import type { EmployeeUtil, Project, Timesheet } from '../types';

export const TimesheetsView: React.FC<{ timesheets: Timesheet[] }> = ({ timesheets }) => (
  <div className="panel">
    <div className="panel-header"><h2>Timesheet Entries</h2></div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Date</th><th>Employee</th><th>Project / Task</th><th>Notes</th><th>Billable</th><th className="num">Hours</th><th className="num">Value</th></tr>
        </thead>
        <tbody>
          {timesheets.map((ts) => (
            <tr key={ts.id}>
              <td>{ts.work_date}</td>
              <td><strong>{ts.employee_name}</strong></td>
              <td><div><strong>{ts.project_name}</strong></div><div className="muted" style={{ fontSize: '11.5px' }}>{ts.task_title}</div></td>
              <td>{ts.note}</td>
              <td><span className={`badge ${ts.billable ? 'badge-success' : 'badge-neutral'}`}>{ts.billable ? 'Billable' : 'Internal'}</span></td>
              <td className="num"><strong>{formatNumber(Number(ts.hours), 1)} h</strong></td>
              <td className="num">{ts.billable ? formatMoney(Number(ts.hours) * Number(ts.hourly_rate || 0)) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

export const ProfitabilityView: React.FC<{ projects: Project[]; byEmployee: EmployeeUtil[] }> = ({
  projects,
  byEmployee,
}) => (
  <div className="split-2">
    <div className="panel">
      <div className="panel-header"><h2>Project Profitability</h2></div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Project</th><th className="num">Billed</th><th className="num">Labor Cost</th><th className="num">Gross Margin</th></tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const profit = p.billed_revenue - p.labor_cost;
              const pct = p.billed_revenue > 0 ? (profit / p.billed_revenue) * 100 : 0;
              return (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong><div className="muted" style={{ fontSize: '11.5px' }}>{p.client_name}</div></td>
                  <td className="num">{formatMoney(p.billed_revenue)}</td>
                  <td className="num">{formatMoney(p.labor_cost)}</td>
                  <td className="num"><span className={`badge ${pct >= 50 ? 'badge-success' : 'badge-warning'}`}>{formatMoney(profit)} ({formatPercent(pct)})</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>

    <div className="panel">
      <div className="panel-header"><h2>Team Utilization</h2></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Team Member</th><th className="num">Logged Hours</th><th className="num">Billable Hours</th><th className="num">Billable %</th></tr></thead>
          <tbody>
            {byEmployee.map((u) => (
              <tr key={u.employee}>
                <td><strong>{u.employee}</strong></td>
                <td className="num">{formatNumber(u.hours, 1)} h</td>
                <td className="num">{formatNumber(u.billable, 1)} h</td>
                <td className="num"><span className="badge badge-success">{u.hours > 0 ? formatPercent((u.billable / u.hours) * 100) : '0%'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
);
