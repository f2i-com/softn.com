import React from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import type { Account, FinancialReports, JournalEntry } from '../types';

export const FinancialReportsView: React.FC<{ reports: FinancialReports }> = ({ reports }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <div className="split-2">
      <div className="panel">
        <div className="panel-header"><h2>Profit &amp; Loss Statement</h2></div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr><td colSpan={2}><strong>Revenue</strong></td></tr>
              {reports.pnl.revenues.map((a) => <tr key={a.code}><td>{a.code} · {a.name}</td><td className="num">{formatMoney(a.balance)}</td></tr>)}
              <tr><td><strong>Total Revenue</strong></td><td className="num"><strong>{formatMoney(reports.pnl.totalRevenue)}</strong></td></tr>
              <tr><td colSpan={2}><strong>Expenses</strong></td></tr>
              {reports.pnl.expenses.map((a) => <tr key={a.code}><td>{a.code} · {a.name}</td><td className="num">{formatMoney(a.balance)}</td></tr>)}
              <tr><td><strong>Total Expenses</strong></td><td className="num"><strong>{formatMoney(reports.pnl.totalExpense)}</strong></td></tr>
              <tr style={{ background: '#ecfdf5' }}>
                <td><strong>Net Operating Profit</strong></td>
                <td className="num" style={{ color: '#059669', fontWeight: 800 }}>{formatMoney(reports.pnl.netIncome)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><h2>Balance Sheet</h2></div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr><td colSpan={2}><strong>Assets</strong></td></tr>
              {reports.balanceSheet.assets.map((a) => <tr key={a.code}><td>{a.code} · {a.name}</td><td className="num">{formatMoney(a.balance)}</td></tr>)}
              <tr><td><strong>Total Assets</strong></td><td className="num"><strong>{formatMoney(reports.balanceSheet.totalAssets)}</strong></td></tr>
              <tr><td colSpan={2}><strong>Liabilities &amp; Equity</strong></td></tr>
              {reports.balanceSheet.liabilities.map((a) => <tr key={a.code}><td>{a.code} · {a.name}</td><td className="num">{formatMoney(a.balance)}</td></tr>)}
              {reports.balanceSheet.equity.map((a) => <tr key={a.code}><td>{a.code} · {a.name}</td><td className="num">{formatMoney(a.balance)}</td></tr>)}
              <tr><td>Current Year Retained Earnings</td><td className="num">{formatMoney(reports.balanceSheet.retainedEarnings)}</td></tr>
              <tr style={{ background: '#f5f3ff' }}>
                <td><strong>Total Liabilities + Equity</strong></td>
                <td className="num" style={{ color: '#5b21b6', fontWeight: 800 }}>{formatMoney(reports.balanceSheet.totalLiabAndEquity)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div className="panel">
      <div className="panel-header"><h2>Aged Receivables Summary</h2></div>
      <div className="panel-body">
        <div className="kpi-grid">
          <div className="kpi-card"><span className="kpi-label">Not Yet Due</span><span className="kpi-value">{formatMoney(reports.agedReceivables.current)}</span></div>
          <div className="kpi-card"><span className="kpi-label">1 – 30 Days Overdue</span><span className="kpi-value" style={{ color: '#d97706' }}>{formatMoney(reports.agedReceivables.days_1_30)}</span></div>
          <div className="kpi-card"><span className="kpi-label">31 – 60 Days Overdue</span><span className="kpi-value" style={{ color: '#ea580c' }}>{formatMoney(reports.agedReceivables.days_31_60)}</span></div>
          <div className="kpi-card"><span className="kpi-label">60+ Days Overdue</span><span className="kpi-value" style={{ color: '#dc2626' }}>{formatMoney(reports.agedReceivables.days_60_plus)}</span></div>
        </div>
      </div>
    </div>
  </div>
);

export const GeneralLedgerView: React.FC<{ accounts: Account[]; entries: JournalEntry[] }> = ({
  accounts,
  entries,
}) => (
  <div className="split-2">
    <div className="panel">
      <div className="panel-header"><h2>Chart of Accounts</h2></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td><code>{a.code}</code></td>
                <td><strong>{a.name}</strong></td>
                <td><span className="badge badge-neutral">{a.kind}</span></td>
                <td className="num"><strong>{formatMoney(Number(a.balance))}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>

    <div className="panel">
      <div className="panel-header"><h2>Double-Entry Journal Ledger</h2></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Date</th><th>Ref</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>
            {entries.map((je) => (
              <tr key={je.id}>
                <td>{je.entry_date}</td>
                <td><code>{je.reference}</code></td>
                <td>
                  <div><strong>{je.account_code}</strong> {je.account_name}</div>
                  <div className="muted" style={{ fontSize: '11.5px' }}>{je.memo}</div>
                </td>
                <td className="num">{Number(je.debit) > 0 ? formatMoney(Number(je.debit)) : '-'}</td>
                <td className="num">{Number(je.credit) > 0 ? formatMoney(Number(je.credit)) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
);
