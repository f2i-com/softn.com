import React from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import type { BankTx } from '../types';

interface BankReconciliationViewProps {
  transactions: BankTx[];
  onReconcile: (tx: BankTx, invoiceId?: number) => Promise<void>;
}

export const BankReconciliationView: React.FC<BankReconciliationViewProps> = ({
  transactions,
  onReconcile,
}) => (
  <div className="panel">
    <div className="panel-header">
      <h2>Bank Feed &amp; 1-Click Smart Reconciliation</h2>
      <span className="muted" style={{ fontSize: '12px' }}>Auto-matches open invoices &amp; vendor bills by amount and counterparty</span>
    </div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Date / Ref</th><th>Counterparty &amp; Memo</th><th className="num">Amount</th><th>Smart Match Suggestion</th><th>Action</th></tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.id}>
              <td>
                <div><strong>{tx.bank_ref}</strong></div>
                <div className="muted" style={{ fontSize: '11.5px' }}>{tx.tx_date}</div>
              </td>
              <td>
                <div><strong>{tx.counterparty}</strong></div>
                <div className="muted" style={{ fontSize: '11.5px' }}>{tx.memo}</div>
              </td>
              <td className="num" style={{ color: Number(tx.amount) >= 0 ? '#059669' : '#dc2626', fontWeight: 700 }}>
                {Number(tx.amount) >= 0 ? '+' : ''}{formatMoney(Number(tx.amount))}
              </td>
              <td>
                {tx.reconciled ? (
                  <span className="badge badge-success">Reconciled</span>
                ) : tx.suggested ? (
                  <span className="badge badge-accent">Match: {tx.suggested.invoice_number} ({formatMoney(tx.suggested.balance_due)} due)</span>
                ) : (
                  <span className="badge badge-neutral">Direct Entry</span>
                )}
              </td>
              <td style={{ display: 'flex', gap: '6px' }}>
                {!tx.reconciled && tx.suggested && (
                  <button type="button" className="btn btn-sm btn-success" onClick={() => void onReconcile(tx, tx.suggested?.id)}>
                    Reconcile {tx.suggested.invoice_number}
                  </button>
                )}
                {!tx.reconciled && (
                  <button type="button" className="btn btn-sm" onClick={() => void onReconcile(tx)}>Post Direct</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);
