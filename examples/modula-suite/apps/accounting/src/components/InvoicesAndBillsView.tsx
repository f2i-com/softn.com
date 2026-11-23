import React from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import { accountingStatusBadge, type Expense, type Invoice } from '../types';

interface InvoicesTableProps {
  kind: 'customer' | 'vendor';
  invoices: Invoice[];
  onRecordPayment: (inv: Invoice, due: number) => void;
  onCreditNote: (inv: Invoice) => Promise<void>;
}

export const InvoicesTableView: React.FC<InvoicesTableProps> = ({
  kind,
  invoices,
  onRecordPayment,
  onCreditNote,
}) => (
  <div className="panel">
    <div className="panel-header">
      <h2>{kind === 'customer' ? 'Customer Invoices' : 'Vendor Bills'}</h2>
      <span className="muted" style={{ fontSize: '12px' }}>Payments &amp; Credit Notes automatically balance the double-entry General Ledger</span>
    </div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Document</th>
            <th>{kind === 'customer' ? 'Customer' : 'Vendor'}</th>
            <th>Issued</th>
            <th>Due</th>
            <th>Status</th>
            <th className="num">Total</th>
            <th className="num">Balance Due</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => {
            const due = inv.status === 'Credited' ? 0 : Math.max(0, Number(inv.total) - Number(inv.paid_amount));
            return (
              <tr key={inv.id}>
                <td><strong>{inv.invoice_number}</strong></td>
                <td>{inv.party_name}</td>
                <td>{inv.issue_date}</td>
                <td>{inv.due_date}</td>
                <td><span className={`badge ${accountingStatusBadge(inv.status)}`}>{inv.status}</span></td>
                <td className="num">{formatMoney(Number(inv.total))}</td>
                <td className="num"><strong>{formatMoney(due)}</strong></td>
                <td style={{ display: 'flex', gap: '6px' }}>
                  {due > 0.01 ? (
                    <button type="button" className="btn btn-sm btn-success" onClick={() => onRecordPayment(inv, due)}>Record Payment</button>
                  ) : (
                    <span className="muted" style={{ fontSize: '12px', alignSelf: 'center' }}>{inv.status === 'Credited' ? 'Credited' : 'Settled'}</span>
                  )}
                  {kind === 'customer' && inv.status !== 'Credited' && (
                    <button type="button" className="btn btn-sm" onClick={() => void onCreditNote(inv)}>Credit Note</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </div>
);

interface ExpensesTableProps {
  expenses: Expense[];
  onExpenseStatus: (id: number, status: string) => Promise<void>;
}

export const ExpensesTableView: React.FC<ExpensesTableProps> = ({ expenses, onExpenseStatus }) => (
  <div className="panel">
    <div className="panel-header">
      <h2>Employee Expense Claims</h2>
      <span className="muted" style={{ fontSize: '12px' }}>Reimbursing posts directly to Account 6100 &amp; Operating Bank</span>
    </div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Employee</th><th>Category</th><th>Description</th><th>Date</th><th>Status</th><th className="num">Amount</th><th>Workflow</th></tr>
        </thead>
        <tbody>
          {expenses.map((ex) => (
            <tr key={ex.id}>
              <td><strong>{ex.employee_name}</strong></td>
              <td><span className="badge badge-neutral">{ex.category}</span></td>
              <td>{ex.description}</td>
              <td>{ex.expense_date}</td>
              <td><span className={`badge ${accountingStatusBadge(ex.status)}`}>{ex.status}</span></td>
              <td className="num"><strong>{formatMoney(Number(ex.amount))}</strong></td>
              <td style={{ display: 'flex', gap: '6px' }}>
                {ex.status === 'Submitted' && (
                  <>
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => void onExpenseStatus(ex.id, 'Approved')}>Approve</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => void onExpenseStatus(ex.id, 'Rejected')}>Reject</button>
                  </>
                )}
                {ex.status === 'Approved' && (
                  <button type="button" className="btn btn-sm btn-success" onClick={() => void onExpenseStatus(ex.id, 'Reimbursed')}>Reimburse</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);
