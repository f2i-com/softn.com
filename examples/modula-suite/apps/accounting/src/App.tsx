import { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatCompactMoney, formatMoney } from '../../../shared/ui/format';
import { BankReconciliationView } from './components/BankReconciliationView';
import { ExpensesTableView, InvoicesTableView } from './components/InvoicesAndBillsView';
import { FinancialReportsView, GeneralLedgerView } from './components/ReportsAndLedgerView';
import type { Account, AccountingOverview, BankTx, Expense, FinancialReports, Invoice, InvoiceLine, JournalEntry } from './types';

export function App() {
  const [tab, setTab] = useState<'invoices' | 'bills' | 'bank' | 'expenses' | 'reports' | 'ledger'>('invoices');
  const [overview, setOverview] = useState<AccountingOverview | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [bankTxs, setBankTxs] = useState<BankTx[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [reports, setReports] = useState<FinancialReports | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showNewInv, setShowNewInv] = useState<'customer' | 'vendor' | null>(null);
  const [invParty, setInvParty] = useState('');
  const [invDue, setInvDue] = useState('2026-12-22');
  const [invTax, setInvTax] = useState('10');
  const [invLines, setInvLines] = useState<InvoiceLine[]>([{ description: 'Consulting & Setup', qty: 1, unitPrice: 3500 }]);

  const [payModal, setPayModal] = useState<Invoice | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [showNewExp, setShowNewExp] = useState(false);
  const [expForm, setExpForm] = useState({ employee_name: 'Alex Rivera', category: 'Travel', description: '', amount: '' });
  const [showNewJournal, setShowNewJournal] = useState(false);
  const [jeForm, setJeForm] = useState({ reference: 'JE-2026-01', debit_account: '6100', credit_account: '1000', amount: '500', memo: 'Office supplies adjustment' });
  const [showNewBank, setShowNewBank] = useState(false);
  const [bankForm, setBankForm] = useState({ counterparty: '', memo: '', amount: '2500', bank_ref: 'EFT-99501' });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, invRes, bankRes, expRes, ledRes, repRes, rt] = await Promise.all([
        apiFetch<AccountingOverview>('/api/overview'),
        apiFetch<{ invoices: Invoice[] }>('/api/invoices'),
        apiFetch<{ transactions: BankTx[] }>('/api/bank'),
        apiFetch<{ expenses: Expense[] }>('/api/expenses'),
        apiFetch<{ accounts: Account[]; entries: JournalEntry[] }>('/api/ledger'),
        apiFetch<FinancialReports>('/api/reports'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setInvoices(invRes.invoices);
      setBankTxs(bankRes.transactions);
      setExpenses(expRes.expenses);
      setAccounts(ledRes.accounts);
      setEntries(ledRes.entries);
      setReports(repRes);
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

  const customerInvoices = invoices.filter((i) => i.kind === 'customer');
  const vendorBills = invoices.filter((i) => i.kind === 'vendor');
  const draftTotal = invLines.reduce((s, l) => s + l.qty * l.unitPrice, 0) * (1 + (Number(invTax) || 0) / 100);

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#6d28d9', ['--accent-soft' as string]: '#ede9fe', ['--accent-ink' as string]: '#4c1d95' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">AC</div>
          <div>
            <h1>Accounting &amp; Invoicing</h1>
            <div className="erp-brand-sub">Double-Entry Ledger, Smart Bank Reconciliation, Financial Statements &amp; Expenses</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="Accounting sections">
          <button type="button" className={`erp-tab ${tab === 'invoices' ? 'active' : ''}`} onClick={() => setTab('invoices')}>Invoices ({customerInvoices.length})</button>
          <button type="button" className={`erp-tab ${tab === 'bills' ? 'active' : ''}`} onClick={() => setTab('bills')}>Bills ({vendorBills.length})</button>
          <button type="button" className={`erp-tab ${tab === 'bank' ? 'active' : ''}`} onClick={() => setTab('bank')}>Bank Recon ({overview?.unreconciledBank ?? 0})</button>
          <button type="button" className={`erp-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses ({expenses.length})</button>
          <button type="button" className={`erp-tab ${tab === 'reports' ? 'active' : ''}`} onClick={() => setTab('reports')}>P&amp;L &amp; Balance Sheet</button>
          <button type="button" className={`erp-tab ${tab === 'ledger' ? 'active' : ''}`} onClick={() => setTab('ledger')}>General Ledger</button>
        </nav>

        <div className="erp-actions">
          {tab === 'invoices' && <button id="new-invoice-btn" type="button" className="btn btn-primary" onClick={() => setShowNewInv('customer')}>+ Invoice</button>}
          {tab === 'bills' && <button type="button" className="btn btn-primary" onClick={() => setShowNewInv('vendor')}>+ Vendor Bill</button>}
          {tab === 'bank' && <button type="button" className="btn btn-primary" onClick={() => setShowNewBank(true)}>+ Bank Line</button>}
          {tab === 'expenses' && <button type="button" className="btn btn-primary" onClick={() => setShowNewExp(true)}>+ Expense</button>}
          {tab === 'ledger' && <button type="button" className="btn btn-primary" onClick={() => setShowNewJournal(true)}>+ Journal Entry</button>}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card"><span className="kpi-label">Operating Bank</span><span className="kpi-value" id="kpi-bank">{formatCompactMoney(overview.bankBalance)}</span><span className="kpi-sub">{overview.unreconciledBank} bank line(s) ready to reconcile</span></div>
            <div className="kpi-card"><span className="kpi-label">Accounts Receivable</span><span className="kpi-value" style={{ color: '#d97706' }}>{formatCompactMoney(overview.receivables)}</span><span className="kpi-sub">{overview.overdueCount} overdue customer invoice(s)</span></div>
            <div className="kpi-card"><span className="kpi-label">Accounts Payable</span><span className="kpi-value">{formatCompactMoney(overview.payables)}</span><span className="kpi-sub">{overview.pendingExpenses} expense(s) awaiting approval</span></div>
            <div className="kpi-card"><span className="kpi-label">Net Profit (YTD)</span><span className="kpi-value" style={{ color: '#059669' }}>{formatCompactMoney(overview.netProfit)}</span><span className="kpi-sub">Rev {formatCompactMoney(overview.revenue)} · Exp {formatCompactMoney(overview.expenses)}</span></div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading financial ledger from PHP + XDB SQLite...</div></div>
        ) : (tab === 'invoices' || tab === 'bills') ? (
          <InvoicesTableView
            kind={tab === 'invoices' ? 'customer' : 'vendor'}
            invoices={tab === 'invoices' ? customerInvoices : vendorBills}
            onRecordPayment={(inv, due) => { setPayModal(inv); setPayAmount(due.toFixed(2)); }}
            onCreditNote={async (inv) => {
              await apiFetch(`/api/invoices/${inv.id}/credit-note`, { method: 'POST' });
              await loadAll();
              notify(`Credit Note issued for ${inv.invoice_number}`);
            }}
          />
        ) : tab === 'bank' ? (
          <BankReconciliationView
            transactions={bankTxs}
            onReconcile={async (tx, invoiceId) => {
              await apiFetch(`/api/bank/${tx.id}/reconcile`, { method: 'POST', body: { invoice_id: invoiceId ?? 0 } });
              await loadAll();
              notify(invoiceId ? `Reconciled ${tx.bank_ref} against invoice!` : `Posted ${tx.bank_ref} directly`);
            }}
          />
        ) : tab === 'expenses' ? (
          <ExpensesTableView
            expenses={expenses}
            onExpenseStatus={async (id, status) => {
              await apiFetch(`/api/expenses/${id}/status`, { method: 'PATCH', body: { status } });
              await loadAll();
              notify(`Expense marked ${status}`);
            }}
          />
        ) : tab === 'reports' && reports ? (
          <FinancialReportsView reports={reports} />
        ) : (
          <GeneralLedgerView accounts={accounts} entries={entries} />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula Accounting &amp; Invoicing · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showNewInv && (
        <div className="modal-backdrop" onClick={() => setShowNewInv(null)}>
          <form
            className="modal modal-wide"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/invoices', { method: 'POST', body: { kind: showNewInv, party_name: invParty, due_date: invDue, tax_rate: Number(invTax) || 0, lines: invLines } });
              setShowNewInv(null);
              setInvParty('');
              setInvLines([{ description: 'Consulting & Setup', qty: 1, unitPrice: 3500 }]);
              await loadAll();
              notify('Document posted to General Ledger');
            }}
          >
            <div className="modal-head"><h3>{showNewInv === 'customer' ? 'New Customer Invoice' : 'Record Vendor Bill'}</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewInv(null)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>{showNewInv === 'customer' ? 'Customer *' : 'Vendor *'}</label><input className="input" required value={invParty} onChange={(e) => setInvParty(e.target.value)} /></div>
                <div className="field"><label>Due Date</label><input className="input" type="date" value={invDue} onChange={(e) => setInvDue(e.target.value)} /></div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: '12.5px' }}>Lines</strong>
                <button type="button" className="btn btn-sm" onClick={() => setInvLines([...invLines, { description: '', qty: 1, unitPrice: 0 }])}>+ Add Line</button>
              </div>
              {invLines.map((line, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 75px 110px 36px', gap: '6px' }}>
                  <input className="input" placeholder="Description" value={line.description} onChange={(e) => { const n = [...invLines]; n[i] = { ...n[i], description: e.target.value }; setInvLines(n); }} />
                  <input className="input" type="number" min="1" value={line.qty} onChange={(e) => { const n = [...invLines]; n[i] = { ...n[i], qty: Number(e.target.value) || 1 }; setInvLines(n); }} />
                  <input className="input" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(e) => { const n = [...invLines]; n[i] = { ...n[i], unitPrice: Number(e.target.value) || 0 }; setInvLines(n); }} />
                  <button type="button" className="btn btn-sm btn-danger" disabled={invLines.length <= 1} onClick={() => setInvLines(invLines.filter((_, idx) => idx !== i))}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><label style={{ fontSize: '12px' }}>Tax %</label><input className="input" style={{ width: '70px' }} type="number" value={invTax} onChange={(e) => setInvTax(e.target.value)} /></div>
                <strong style={{ fontSize: '16px', fontVariantNumeric: 'tabular-nums' }}>Total: {formatMoney(draftTotal)}</strong>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewInv(null)}>Cancel</button><button type="submit" className="btn btn-primary">Post to Ledger</button></div>
          </form>
        </div>
      )}

      {payModal && (
        <div className="modal-backdrop" onClick={() => setPayModal(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch(`/api/invoices/${payModal.id}/pay`, { method: 'POST', body: { amount: Number(payAmount) || undefined } });
              setPayModal(null);
              await loadAll();
              notify('Payment recorded & balanced');
            }}
          >
            <div className="modal-head"><h3>Record Payment — {payModal.invoice_number}</h3><button type="button" className="btn btn-sm" onClick={() => setPayModal(null)}>Cancel</button></div>
            <div className="modal-body">
              <div className="muted">{payModal.party_name} · Total {formatMoney(Number(payModal.total))}</div>
              <div className="field"><label>Amount ($)</label><input className="input" type="number" min="0.01" step="0.01" required value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /></div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setPayModal(null)}>Cancel</button><button type="submit" className="btn btn-success">Confirm Payment</button></div>
          </form>
        </div>
      )}

      {showNewBank && (
        <div className="modal-backdrop" onClick={() => setShowNewBank(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/bank', { method: 'POST', body: { ...bankForm, amount: Number(bankForm.amount) || 0 } });
              setShowNewBank(false);
              setBankForm({ counterparty: '', memo: '', amount: '2500', bank_ref: 'EFT-99502' });
              await loadAll();
              notify('Bank statement line imported');
            }}
          >
            <div className="modal-head"><h3>Import Bank Line</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewBank(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Counterparty *</label><input className="input" required value={bankForm.counterparty} onChange={(e) => setBankForm({ ...bankForm, counterparty: e.target.value })} /></div>
                <div className="field"><label>Reference</label><input className="input" value={bankForm.bank_ref} onChange={(e) => setBankForm({ ...bankForm, bank_ref: e.target.value })} /></div>
                <div className="field"><label>Amount (+ / -)</label><input className="input" type="number" step="0.01" required value={bankForm.amount} onChange={(e) => setBankForm({ ...bankForm, amount: e.target.value })} /></div>
                <div className="field"><label>Memo</label><input className="input" value={bankForm.memo} onChange={(e) => setBankForm({ ...bankForm, memo: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewBank(false)}>Cancel</button><button type="submit" className="btn btn-primary">Import</button></div>
          </form>
        </div>
      )}

      {showNewExp && (
        <div className="modal-backdrop" onClick={() => setShowNewExp(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/expenses', { method: 'POST', body: { ...expForm, amount: Number(expForm.amount) || 0 } });
              setShowNewExp(false);
              setExpForm({ employee_name: 'Alex Rivera', category: 'Travel', description: '', amount: '' });
              await loadAll();
              notify('Expense claim submitted');
            }}
          >
            <div className="modal-head"><h3>Submit Expense</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewExp(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Employee *</label><input className="input" required value={expForm.employee_name} onChange={(e) => setExpForm({ ...expForm, employee_name: e.target.value })} /></div>
                <div className="field"><label>Category</label><select className="select" value={expForm.category} onChange={(e) => setExpForm({ ...expForm, category: e.target.value })}><option value="Travel">Travel</option><option value="Hardware">Hardware</option><option value="Software">Software</option><option value="Meals">Meals</option></select></div>
                <div className="field full"><label>Description *</label><input className="input" required value={expForm.description} onChange={(e) => setExpForm({ ...expForm, description: e.target.value })} /></div>
                <div className="field"><label>Amount ($) *</label><input className="input" type="number" min="0.01" step="0.01" required value={expForm.amount} onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewExp(false)}>Cancel</button><button type="submit" className="btn btn-primary">Submit</button></div>
          </form>
        </div>
      )}

      {showNewJournal && (
        <div className="modal-backdrop" onClick={() => setShowNewJournal(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/journal', { method: 'POST', body: { ...jeForm, amount: Number(jeForm.amount) || 0 } });
              setShowNewJournal(false);
              await loadAll();
              notify('Balanced journal entry posted');
            }}
          >
            <div className="modal-head"><h3>Manual Balanced Journal Entry</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewJournal(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Reference</label><input className="input" value={jeForm.reference} onChange={(e) => setJeForm({ ...jeForm, reference: e.target.value })} /></div>
                <div className="field"><label>Amount ($)</label><input className="input" type="number" step="0.01" min="0.01" required value={jeForm.amount} onChange={(e) => setJeForm({ ...jeForm, amount: e.target.value })} /></div>
                <div className="field"><label>Debit Account</label><select className="select" value={jeForm.debit_account} onChange={(e) => setJeForm({ ...jeForm, debit_account: e.target.value })}>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select></div>
                <div className="field"><label>Credit Account</label><select className="select" value={jeForm.credit_account} onChange={(e) => setJeForm({ ...jeForm, credit_account: e.target.value })}>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select></div>
                <div className="field full"><label>Memo</label><input className="input" value={jeForm.memo} onChange={(e) => setJeForm({ ...jeForm, memo: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewJournal(false)}>Cancel</button><button type="submit" className="btn btn-primary">Post Entry</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
