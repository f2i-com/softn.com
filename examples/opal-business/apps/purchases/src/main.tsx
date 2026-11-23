import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../shared/ui/opal.css';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatAbn, formatAuDate, formatAud } from '../../../shared/ui/format';

interface PurchasesOverview {
  openPayables: number;
  overdueBills: number;
  gstPaid: number;
  intrayReady: number;
  openPos: number;
  pendingExpenses: number;
  openDebits: number;
}

interface InTrayDoc {
  id: number;
  file_name: string;
  source: string;
  supplier_name: string;
  supplier_abn: string;
  supplier_inv_no: string;
  doc_date: string;
  category: string;
  tax_code: string;
  subtotal: number;
  gst_amount: number;
  total: number;
  ocr_confidence: number;
  status: string;
  linked_bill_number: string;
}

interface PurchaseLine {
  description: string;
  qty: number;
  unitPrice: number;
  taxCode: string;
}

interface PurchaseDoc {
  id: number;
  doc_type: 'bill' | 'po';
  doc_number: string;
  supplier_name: string;
  supplier_abn: string;
  supplier_inv_no: string;
  issue_date: string;
  due_date: string;
  status: string;
  category: string;
  subtotal: number;
  gst_amount: number;
  total: number;
  paid_amount: number;
  balance_due: number;
  attachment_name: string;
  lines: PurchaseLine[];
}

interface SupplierDebit {
  id: number;
  debit_number: string;
  supplier_name: string;
  issue_date: string;
  reason: string;
  subtotal: number;
  gst_amount: number;
  total: number;
  status: string;
  applied_bill_number: string;
}

interface ExpenseClaim {
  id: number;
  employee_name: string;
  merchant: string;
  category: string;
  expense_date: string;
  tax_code: string;
  amount: number;
  gst_amount: number;
  billable_customer: string;
  status: string;
}

function badgeFor(status: string): string {
  switch (status) {
    case 'Paid':
    case 'Linked':
    case 'Reimbursed':
    case 'Applied':
      return 'badge-success';
    case 'Overdue':
    case 'Rejected':
      return 'badge-danger';
    case 'Ready':
    case 'Open':
    case 'Partial':
    case 'Submitted':
      return 'badge-warning';
    case 'Approved':
    case 'Issued':
      return 'badge-opal';
    case 'Billed':
    case 'Refunded':
      return 'badge-brand';
    default:
      return 'badge-neutral';
  }
}

type TabKey = 'intray' | 'bills' | 'pos' | 'debits' | 'expenses';

function App() {
  const [tab, setTab] = useState<TabKey>('intray');
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [overview, setOverview] = useState<PurchasesOverview | null>(null);
  const [intray, setIntray] = useState<InTrayDoc[]>([]);
  const [docs, setDocs] = useState<PurchaseDoc[]>([]);
  const [debits, setDebits] = useState<SupplierDebit[]>([]);
  const [expenses, setExpenses] = useState<ExpenseClaim[]>([]);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  // Modals
  const [showUpload, setShowUpload] = useState(false);
  const [upSupplier, setUpSupplier] = useState('Reece Plumbing Supplies');
  const [upAbn, setUpAbn] = useState('84 004 097 090');
  const [upFile, setUpFile] = useState('reece-trade-invoice-4012.pdf');
  const [upTotal, setUpTotal] = useState('682.00');
  const [upTaxCode, setUpTaxCode] = useState('GST');
  const [upCategory, setUpCategory] = useState('6-2100 Repairs & Fitout');

  const [newDocType, setNewDocType] = useState<'bill' | 'po' | null>(null);
  const [formSupplier, setFormSupplier] = useState('');
  const [formAbn, setFormAbn] = useState('');
  const [formSupInv, setFormSupInv] = useState('');
  const [formCategory, setFormCategory] = useState('6-1200 Cloud & Software');
  const [formLines, setFormLines] = useState<PurchaseLine[]>([
    { description: 'Monthly Software / Stock Supply', qty: 1, unitPrice: 1200, taxCode: 'GST' },
  ]);

  const [showExpModal, setShowExpModal] = useState(false);
  const [expEmp, setExpEmp] = useState('Liam O\'Connor');
  const [expMerchant, setExpMerchant] = useState('Virgin Australia');
  const [expAmount, setExpAmount] = useState('385.00');
  const [expCategory, setExpCategory] = useState('6-2400 Travel & Accommodation');
  const [expBillable, setExpBillable] = useState('');

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast((prev) => (prev?.msg === msg ? null : prev)), 3200);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [rt, ov, it, ds, db, ex] = await Promise.all([
        apiFetch<RuntimeInfo>('/api/runtime'),
        apiFetch<PurchasesOverview>('/api/overview'),
        apiFetch<{ docs: InTrayDoc[] }>('/api/intray'),
        apiFetch<{ docs: PurchaseDoc[] }>('/api/docs'),
        apiFetch<{ debits: SupplierDebit[] }>('/api/debits'),
        apiFetch<{ expenses: ExpenseClaim[] }>('/api/expenses'),
      ]);
      setRuntime(rt);
      setOverview(ov);
      setIntray(it.docs);
      setDocs(ds.docs);
      setDebits(db.debits);
      setExpenses(ex.expenses);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const bills = docs.filter((d) => d.doc_type === 'bill');
  const pos = docs.filter((d) => d.doc_type === 'po');

  const handleUploadInTray = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/intray', {
        method: 'POST',
        body: {
          file_name: upFile,
          source: 'OCR Upload',
          supplier_name: upSupplier,
          supplier_abn: upAbn,
          category: upCategory,
          tax_code: upTaxCode,
          total: Number(upTotal),
        },
      });
      setShowUpload(false);
      notify(`OCR captured ${upFile} into In Tray`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleInTrayToBill = async (doc: InTrayDoc) => {
    try {
      const res = await apiFetch<{ bill: PurchaseDoc }>(`/api/intray/${doc.id}/to-bill`, { method: 'POST', body: {} });
      notify(`Created Supplier Bill ${res.bill.doc_number} with attached receipt`);
      setTab('bills');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleCreateDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocType) return;
    try {
      const res = await apiFetch<{ doc: PurchaseDoc }>('/api/docs', {
        method: 'POST',
        body: {
          doc_type: newDocType,
          supplier_name: formSupplier,
          supplier_abn: formAbn,
          supplier_inv_no: formSupInv,
          category: formCategory,
          lines: formLines,
        },
      });
      setNewDocType(null);
      notify(`Created ${res.doc.doc_number} for ${res.doc.supplier_name}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handlePayBill = async (bill: PurchaseDoc) => {
    try {
      await apiFetch(`/api/docs/${bill.id}/pay`, { method: 'POST', body: { amount: bill.balance_due } });
      notify(`Paid ${bill.doc_number} (${formatAud(bill.balance_due)}) via ABA EFT`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handlePoToBill = async (po: PurchaseDoc) => {
    try {
      const res = await apiFetch<{ bill: PurchaseDoc }>(`/api/docs/${po.id}/to-bill`, { method: 'POST', body: {} });
      notify(`Converted ${po.doc_number} -> ${res.bill.doc_number}`);
      setTab('bills');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleApplyDebit = async (d: SupplierDebit) => {
    try {
      await apiFetch(`/api/debits/${d.id}/apply`, { method: 'POST', body: {} });
      notify(`Applied Supplier Debit ${d.debit_number}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/expenses', {
        method: 'POST',
        body: {
          employee_name: expEmp,
          merchant: expMerchant,
          category: expCategory,
          amount: Number(expAmount),
          billable_customer: expBillable,
        },
      });
      setShowExpModal(false);
      notify(`Submitted expense claim for ${expEmp}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleExpenseStatus = async (ex: ExpenseClaim, status: string) => {
    try {
      await apiFetch(`/api/expenses/${ex.id}/status`, { method: 'PATCH', body: { status } });
      notify(`Expense #${ex.id} marked ${status}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  return (
    <div className="opal-app">
      <header className="opal-topbar">
        <div className="opal-brand">
          <div className="opal-brand-mark" style={{ background: 'linear-gradient(135deg, #be185d, #7c3aed)' }}>PU</div>
          <div>
            <h1>Purchases, Bills &amp; In Tray</h1>
            <div className="opal-brand-sub">Smart OCR In Tray · Supplier Bills · Purchase Orders · Debits · Expense Claims</div>
          </div>
        </div>

        <nav className="opal-tabs">
          <button className={`opal-tab ${tab === 'intray' ? 'active' : ''}`} onClick={() => setTab('intray')}>
            In Tray (OCR) <span className="opal-tab-count">{intray.filter((d) => d.status === 'Ready').length}</span>
          </button>
          <button className={`opal-tab ${tab === 'bills' ? 'active' : ''}`} onClick={() => setTab('bills')}>
            Bills <span className="opal-tab-count">{bills.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'pos' ? 'active' : ''}`} onClick={() => setTab('pos')}>
            Purchase Orders <span className="opal-tab-count">{pos.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'debits' ? 'active' : ''}`} onClick={() => setTab('debits')}>
            Supplier Returns <span className="opal-tab-count">{debits.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>
            Expenses <span className="opal-tab-count">{expenses.length}</span>
          </button>
        </nav>

        <div className="opal-actions">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP · XDB' : 'Standalone PHP'}
            </span>
          )}
          <button className="btn btn-soft btn-sm" onClick={() => setShowUpload(true)}>+ Capture Receipt</button>
          <button className="btn btn-primary btn-sm" onClick={() => { setNewDocType('bill'); setFormSupplier(''); setFormAbn(''); }}>+ Enter Bill</button>
        </div>
      </header>

      <main className="opal-main">
        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #be185d, #7c3aed)' } as React.CSSProperties}>
              <div className="kpi-label">Bills To Pay (AP)</div>
              <div className="kpi-value">{formatAud(overview.openPayables)}</div>
              <div className="kpi-sub">Overdue bills: <strong className="text-danger">{formatAud(overview.overdueBills)}</strong></div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #d97706, #f59e0b)' } as React.CSSProperties}>
              <div className="kpi-label">In Tray Queue (OCR)</div>
              <div className="kpi-value">{overview.intrayReady} docs</div>
              <div className="kpi-sub">Pre-filled from Bunnings, Officeworks &amp; Email</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #0d9488, #10b981)' } as React.CSSProperties}>
              <div className="kpi-label">GST Credits (BAS 1B)</div>
              <div className="kpi-value text-opal">{formatAud(overview.gstPaid)}</div>
              <div className="kpi-sub">Input tax credits across GST &amp; CAP bills</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #2563eb, #6366f1)' } as React.CSSProperties}>
              <div className="kpi-label">Open POs &amp; Expenses</div>
              <div className="kpi-value">{formatAud(overview.openPos)}</div>
              <div className="kpi-sub">Pending staff claims: {formatAud(overview.pendingExpenses)}</div>
            </div>
          </section>
        )}

        {tab === 'intray' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">In Tray — Smart Receipt &amp; Supplier Bill Capture</h2>
                <div className="panel-subtitle">Forward PDFs to bills@opal.harbourview.au, sync Bunnings/Officeworks feeds, or upload receipts for instant bill creation.</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowUpload(true)}>+ Upload Document (OCR)</button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Document &amp; Source</th>
                    <th>Extracted Supplier</th>
                    <th>Date &amp; Ref</th>
                    <th>Suggested Category</th>
                    <th>OCR Match</th>
                    <th className="right">GST</th>
                    <th className="right">Total</th>
                    <th>Status</th>
                    <th className="right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {intray.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div className="fw-700 text-brand">{d.file_name}</div>
                        <div className="row-sub">{d.source}</div>
                      </td>
                      <td>
                        <div className="fw-700">{d.supplier_name}</div>
                        <div className="row-sub">ABN {formatAbn(d.supplier_abn)}</div>
                      </td>
                      <td>
                        <div>{formatAuDate(d.doc_date)}</div>
                        <div className="row-sub">{d.supplier_inv_no}</div>
                      </td>
                      <td>
                        <div>{d.category}</div>
                        <span className="badge badge-neutral">{d.tax_code}</span>
                      </td>
                      <td><span className="badge badge-opal">{d.ocr_confidence}% OCR</span></td>
                      <td className="right money">{formatAud(d.gst_amount)}</td>
                      <td className="right money fw-700">{formatAud(d.total)}</td>
                      <td>
                        <span className={`badge ${badgeFor(d.status)}`}>{d.status}</span>
                        {d.linked_bill_number && <div className="row-sub">{d.linked_bill_number}</div>}
                      </td>
                      <td className="right">
                        {d.status === 'Ready' ? (
                          <button className="btn btn-primary btn-xs" onClick={() => void handleInTrayToBill(d)}>
                            Create Bill
                          </button>
                        ) : (
                          <span className="muted">Attached</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {(tab === 'bills' || tab === 'pos') && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">{tab === 'bills' ? 'Supplier Bills (Accounts Payable)' : 'Purchase Orders'}</h2>
                <div className="panel-subtitle">
                  {tab === 'bills'
                    ? 'Track supplier terms, GST vs CAP capital purchases, and pay bills in one click.'
                    : 'Issue supplier purchase orders and convert received orders directly into bills.'}
                </div>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setNewDocType(tab === 'bills' ? 'bill' : 'po');
                  setFormSupplier('');
                  setFormAbn('');
                }}
              >
                + New {tab === 'bills' ? 'Supplier Bill' : 'Purchase Order'}
              </button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Supplier</th>
                    <th>Account / Category</th>
                    <th>Due Date</th>
                    <th>Status</th>
                    <th className="right">GST</th>
                    <th className="right">Total</th>
                    {tab === 'bills' && <th className="right">Balance Due</th>}
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(tab === 'bills' ? bills : pos).map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div className="fw-700 text-brand">{d.doc_number}</div>
                        {d.attachment_name && <div className="row-sub">Attached: {d.attachment_name}</div>}
                      </td>
                      <td>
                        <div className="fw-700">{d.supplier_name}</div>
                        <div className="row-sub">ABN {formatAbn(d.supplier_abn)} {d.supplier_inv_no ? `· ${d.supplier_inv_no}` : ''}</div>
                      </td>
                      <td>{d.category}</td>
                      <td>{formatAuDate(d.due_date)}</td>
                      <td><span className={`badge ${badgeFor(d.status)}`}>{d.status}</span></td>
                      <td className="right money">{formatAud(d.gst_amount)}</td>
                      <td className="right money fw-700">{formatAud(d.total)}</td>
                      {tab === 'bills' && (
                        <td className={`right money fw-700 ${d.balance_due > 0 ? 'text-danger' : 'text-success'}`}>
                          {formatAud(d.balance_due)}
                        </td>
                      )}
                      <td className="right">
                        {tab === 'bills' && d.balance_due > 0 && (
                          <button className="btn btn-opal btn-xs" onClick={() => void handlePayBill(d)}>Pay Bill (EFT)</button>
                        )}
                        {tab === 'pos' && d.status !== 'Billed' && (
                          <button className="btn btn-primary btn-xs" onClick={() => void handlePoToBill(d)}>Convert to Bill</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'debits' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Supplier Returns &amp; Debit Notes</h2>
                <div className="panel-subtitle">Apply supplier credits against unpaid bills or record refunds.</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Debit #</th>
                    <th>Supplier</th>
                    <th>Date</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th className="right">GST</th>
                    <th className="right">Amount</th>
                    <th className="right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {debits.map((d) => (
                    <tr key={d.id}>
                      <td className="fw-700 text-brand">{d.debit_number}</td>
                      <td className="fw-700">{d.supplier_name}</td>
                      <td>{formatAuDate(d.issue_date)}</td>
                      <td>{d.reason}{d.applied_bill_number && <div className="row-sub">Applied to {d.applied_bill_number}</div>}</td>
                      <td><span className={`badge ${badgeFor(d.status)}`}>{d.status}</span></td>
                      <td className="right money">{formatAud(d.gst_amount)}</td>
                      <td className="right money fw-700">{formatAud(d.total)}</td>
                      <td className="right">
                        {d.status === 'Open' ? (
                          <button className="btn btn-primary btn-xs" onClick={() => void handleApplyDebit(d)}>Apply to Bill</button>
                        ) : (
                          <span className="muted">Settled</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'expenses' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Staff Expense Claims &amp; On-Chargeable Costs</h2>
                <div className="panel-subtitle">Review employee receipts, approve reimbursements, and track expenses billable back to customers.</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowExpModal(true)}>+ Submit Expense</button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Employee</th>
                    <th>Merchant &amp; Category</th>
                    <th>On-Charge Customer</th>
                    <th>Tax</th>
                    <th className="right">Amount</th>
                    <th>Status</th>
                    <th className="right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((ex) => (
                    <tr key={ex.id}>
                      <td>{formatAuDate(ex.expense_date)}</td>
                      <td className="fw-700">{ex.employee_name}</td>
                      <td>
                        <div className="fw-700">{ex.merchant}</div>
                        <div className="row-sub">{ex.category}</div>
                      </td>
                      <td>{ex.billable_customer ? <span className="badge badge-brand">{ex.billable_customer}</span> : <span className="muted">Internal</span>}</td>
                      <td><span className="badge badge-neutral">{ex.tax_code}</span></td>
                      <td className="right money fw-700">{formatAud(ex.amount)}</td>
                      <td><span className={`badge ${badgeFor(ex.status)}`}>{ex.status}</span></td>
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          {ex.status === 'Submitted' && (
                            <button className="btn btn-soft btn-xs" onClick={() => void handleExpenseStatus(ex, 'Approved')}>Approve</button>
                          )}
                          {ex.status === 'Approved' && (
                            <button className="btn btn-opal btn-xs" onClick={() => void handleExpenseStatus(ex, 'Reimbursed')}>Reimburse</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* In Tray Capture Modal */}
      {showUpload && (
        <div className="modal-backdrop" onClick={() => setShowUpload(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleUploadInTray}>
            <div className="modal-head">
              <h2>Capture Receipt / Bill into In Tray (OCR)</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowUpload(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field">
                  <label>Document Filename</label>
                  <input className="input" required value={upFile} onChange={(e) => setUpFile(e.target.value)} />
                </div>
                <div className="field">
                  <label>Supplier Name</label>
                  <input className="input" required value={upSupplier} onChange={(e) => setUpSupplier(e.target.value)} />
                </div>
                <div className="field">
                  <label>Supplier ABN</label>
                  <input className="input" value={upAbn} onChange={(e) => setUpAbn(e.target.value)} />
                </div>
                <div className="field">
                  <label>Total Amount (Inc GST)</label>
                  <input className="input num" type="number" step="0.01" required value={upTotal} onChange={(e) => setUpTotal(e.target.value)} />
                </div>
                <div className="field">
                  <label>Suggested Account Category</label>
                  <input className="input" value={upCategory} onChange={(e) => setUpCategory(e.target.value)} />
                </div>
                <div className="field">
                  <label>AU Tax Code</label>
                  <select className="select" value={upTaxCode} onChange={(e) => setUpTaxCode(e.target.value)}>
                    <option value="GST">GST (10% Standard)</option>
                    <option value="CAP">CAP (10% Capital Asset)</option>
                    <option value="FRE">FRE (0% GST-Free)</option>
                    <option value="N-T">N-T (Not Reportable)</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowUpload(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Capture to In Tray</button>
            </div>
          </form>
        </div>
      )}

      {/* New Bill / PO Modal */}
      {newDocType && (
        <div className="modal-backdrop" onClick={() => setNewDocType(null)}>
          <form className="modal modal-lg" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateDoc}>
            <div className="modal-head">
              <h2>New {newDocType === 'bill' ? 'Supplier Bill' : 'Purchase Order'}</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNewDocType(null)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid-3">
                <div className="field">
                  <label>Supplier Name</label>
                  <input className="input" required value={formSupplier} onChange={(e) => setFormSupplier(e.target.value)} placeholder="e.g. Bunnings Trade Pty Ltd" />
                </div>
                <div className="field">
                  <label>Supplier ABN</label>
                  <input className="input" value={formAbn} onChange={(e) => setFormAbn(e.target.value)} placeholder="26 008 672 179" />
                </div>
                <div className="field">
                  <label>Supplier Invoice #</label>
                  <input className="input" value={formSupInv} onChange={(e) => setFormSupInv(e.target.value)} placeholder="INV-9981" />
                </div>
              </div>
              <div className="field">
                <label>Expense / Asset Category</label>
                <select className="select" value={formCategory} onChange={(e) => setFormCategory(e.target.value)}>
                  <option>6-1200 Cloud &amp; Software</option>
                  <option>5-1100 Inventory Purchases</option>
                  <option>6-1400 Office Supplies</option>
                  <option>6-1800 Rent &amp; Outgoings</option>
                  <option>1-3200 Computer Equipment</option>
                </select>
              </div>
              <div className="line-editor">
                <table>
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th style={{ width: 80 }}>Qty</th>
                      <th style={{ width: 120 }}>Unit (Ex GST)</th>
                      <th style={{ width: 110 }}>Tax Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {formLines.map((l, idx) => (
                      <tr key={idx}>
                        <td><input className="input" required value={l.description} onChange={(e) => setFormLines((p) => p.map((x, i) => (i === idx ? { ...x, description: e.target.value } : x)))} /></td>
                        <td><input className="input num" type="number" step="0.01" value={l.qty} onChange={(e) => setFormLines((p) => p.map((x, i) => (i === idx ? { ...x, qty: Number(e.target.value) } : x)))} /></td>
                        <td><input className="input num" type="number" step="0.01" value={l.unitPrice} onChange={(e) => setFormLines((p) => p.map((x, i) => (i === idx ? { ...x, unitPrice: Number(e.target.value) } : x)))} /></td>
                        <td>
                          <select className="select" value={l.taxCode} onChange={(e) => setFormLines((p) => p.map((x, i) => (i === idx ? { ...x, taxCode: e.target.value } : x)))}>
                            <option value="GST">GST (10%)</option>
                            <option value="CAP">CAP (10%)</option>
                            <option value="FRE">FRE (0%)</option>
                            <option value="INP">INP (0%)</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setNewDocType(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save {newDocType === 'bill' ? 'Bill' : 'Purchase Order'}</button>
            </div>
          </form>
        </div>
      )}

      {/* Expense Modal */}
      {showExpModal && (
        <div className="modal-backdrop" onClick={() => setShowExpModal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateExpense}>
            <div className="modal-head">
              <h2>Submit Staff Expense Claim</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowExpModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field">
                  <label>Employee Name</label>
                  <input className="input" required value={expEmp} onChange={(e) => setExpEmp(e.target.value)} />
                </div>
                <div className="field">
                  <label>Merchant</label>
                  <input className="input" required value={expMerchant} onChange={(e) => setExpMerchant(e.target.value)} />
                </div>
                <div className="field">
                  <label>Amount (Inc GST)</label>
                  <input className="input num" type="number" step="0.01" required value={expAmount} onChange={(e) => setExpAmount(e.target.value)} />
                </div>
                <div className="field">
                  <label>Category</label>
                  <input className="input" value={expCategory} onChange={(e) => setExpCategory(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>On-Charge to Customer (Optional)</label>
                <input className="input" value={expBillable} onChange={(e) => setExpBillable(e.target.value)} placeholder="Leave blank if internal cost" />
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowExpModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Submit Claim</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
