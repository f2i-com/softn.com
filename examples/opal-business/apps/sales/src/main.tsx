import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../shared/ui/opal.css';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatAbn, formatAuDate, formatAud, formatCompactAud } from '../../../shared/ui/format';

interface SalesOverview {
  totalInvoiced: number;
  totalPaid: number;
  outstanding: number;
  overdueAmount: number;
  overdueCount: number;
  gstCollected: number;
  quotesOpen: number;
  ordersOpen: number;
  openCredits: number;
  recurringActive: number;
}

interface SalesLine {
  description: string;
  qty: number;
  unitPrice: number;
  taxCode: 'GST' | 'FRE' | 'EXP' | 'N-T';
  lineTotal?: number;
}

interface SalesDoc {
  id: number;
  doc_type: 'invoice' | 'quote' | 'order';
  doc_number: string;
  customer_name: string;
  customer_abn: string;
  issue_date: string;
  due_date: string;
  status: string;
  tax_mode: 'exclusive' | 'inclusive';
  subtotal: number;
  gst_amount: number;
  total: number;
  paid_amount: number;
  balance_due: number;
  online_pay_enabled: number;
  reminder_count: number;
  notes: string;
  lines: SalesLine[];
}

interface CustomerPayment {
  id: number;
  doc_id: number;
  doc_number: string;
  customer_name: string;
  payment_date: string;
  method: string;
  reference: string;
  amount: number;
}

interface CustomerCredit {
  id: number;
  credit_number: string;
  customer_name: string;
  issue_date: string;
  reason: string;
  subtotal: number;
  gst_amount: number;
  total: number;
  applied_amount: number;
  status: string;
  applied_doc_number: string;
}

interface RecurringTemplate {
  id: number;
  template_name: string;
  customer_name: string;
  customer_abn: string;
  frequency: string;
  next_run_date: string;
  subtotal: number;
  gst_amount: number;
  total: number;
  active: number;
  lines: SalesLine[];
}

function statusClass(status: string): string {
  switch (status) {
    case 'Paid':
    case 'Accepted':
    case 'Applied':
      return 'badge-success';
    case 'Overdue':
      return 'badge-danger';
    case 'Partial':
    case 'Open':
    case 'Sent':
      return 'badge-warning';
    case 'Converted':
    case 'Refunded':
      return 'badge-brand';
    case 'Confirmed':
      return 'badge-opal';
    default:
      return 'badge-neutral';
  }
}

type TabKey = 'invoices' | 'quotes' | 'orders' | 'credits' | 'recurring' | 'payments';

function App() {
  const [tab, setTab] = useState<TabKey>('invoices');
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [overview, setOverview] = useState<SalesOverview | null>(null);
  const [docs, setDocs] = useState<SalesDoc[]>([]);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [credits, setCredits] = useState<CustomerCredit[]>([]);
  const [recurring, setRecurring] = useState<RecurringTemplate[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  // Modals
  const [newDocType, setNewDocType] = useState<'invoice' | 'quote' | 'order' | null>(null);
  const [formCustomer, setFormCustomer] = useState('');
  const [formAbn, setFormAbn] = useState('');
  const [formDueDate, setFormDueDate] = useState('2026-12-06');
  const [formTaxMode, setFormTaxMode] = useState<'exclusive' | 'inclusive'>('exclusive');
  const [formNotes, setFormNotes] = useState('Payment terms: 14 days via EFT/OSKO or BPAY.');
  const [formLines, setFormLines] = useState<SalesLine[]>([
    { description: 'Consulting & Implementation', qty: 1, unitPrice: 1800, taxCode: 'GST' },
  ]);

  const [previewDoc, setPreviewDoc] = useState<SalesDoc | null>(null);
  const [payDoc, setPayDoc] = useState<SalesDoc | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('EFT / OSKO');
  const [payRef, setPayRef] = useState('');

  const [showCreditModal, setShowCreditModal] = useState(false);
  const [creditCustomer, setCreditCustomer] = useState('Kangaroo Valley Organics');
  const [creditAmount, setCreditAmount] = useState('440');
  const [creditReason, setCreditReason] = useState('Returned items / service adjustment');

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast((prev) => (prev?.msg === msg ? null : prev)), 3200);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [rt, ov, d, p, c, r] = await Promise.all([
        apiFetch<RuntimeInfo>('/api/runtime'),
        apiFetch<SalesOverview>('/api/overview'),
        apiFetch<{ docs: SalesDoc[] }>('/api/docs'),
        apiFetch<{ payments: CustomerPayment[] }>('/api/payments'),
        apiFetch<{ credits: CustomerCredit[] }>('/api/credits'),
        apiFetch<{ recurring: RecurringTemplate[] }>('/api/recurring'),
      ]);
      setRuntime(rt);
      setOverview(ov);
      setDocs(d.docs);
      setPayments(p.payments);
      setCredits(c.credits);
      setRecurring(r.recurring);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const invoices = docs.filter((d) => d.doc_type === 'invoice');
  const quotes = docs.filter((d) => d.doc_type === 'quote');
  const orders = docs.filter((d) => d.doc_type === 'order');

  const openCreateModal = (type: 'invoice' | 'quote' | 'order') => {
    setNewDocType(type);
    setFormCustomer('');
    setFormAbn('');
    setFormTaxMode('exclusive');
    setFormLines([{ description: '', qty: 1, unitPrice: 0, taxCode: 'GST' }]);
  };

  const calcPreviewTotals = () => {
    let sub = 0;
    let gst = 0;
    let tot = 0;
    for (const l of formLines) {
      const raw = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
      const isTaxable = l.taxCode === 'GST';
      if (!isTaxable) {
        sub += raw;
        tot += raw;
      } else if (formTaxMode === 'inclusive') {
        const g = raw / 11;
        sub += raw - g;
        gst += g;
        tot += raw;
      } else {
        const g = raw * 0.1;
        sub += raw;
        gst += g;
        tot += raw + g;
      }
    }
    return { sub, gst, tot };
  };

  const submitNewDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocType) return;
    try {
      const res = await apiFetch<{ doc: SalesDoc }>('/api/docs', {
        method: 'POST',
        body: {
          doc_type: newDocType,
          customer_name: formCustomer,
          customer_abn: formAbn,
          due_date: formDueDate,
          tax_mode: formTaxMode,
          notes: formNotes,
          lines: formLines,
        },
      });
      setNewDocType(null);
      notify(`Created ${res.doc.doc_number} for ${res.doc.customer_name}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleConvert = async (doc: SalesDoc, targetType: 'invoice' | 'order') => {
    try {
      const res = await apiFetch<{ created: SalesDoc }>(`/api/docs/${doc.id}/convert`, {
        method: 'POST',
        body: { target_type: targetType },
      });
      notify(`Converted ${doc.doc_number} -> ${res.created.doc_number}`);
      setTab(targetType === 'order' ? 'orders' : 'invoices');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const submitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payDoc) return;
    try {
      await apiFetch(`/api/docs/${payDoc.id}/pay`, {
        method: 'POST',
        body: {
          amount: Number(payAmount) || payDoc.balance_due,
          method: payMethod,
          reference: payRef,
        },
      });
      notify(`Recorded payment for ${payDoc.doc_number}`);
      setPayDoc(null);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleRemind = async (doc: SalesDoc) => {
    try {
      await apiFetch(`/api/docs/${doc.id}/remind`, { method: 'POST', body: {} });
      notify(`Payment reminder dispatched to ${doc.customer_name}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const submitCredit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ credit: CustomerCredit }>('/api/credits', {
        method: 'POST',
        body: { customer_name: creditCustomer, amount: Number(creditAmount), reason: creditReason, tax_code: 'GST' },
      });
      setShowCreditModal(false);
      notify(`Issued Adjustment Note ${res.credit.credit_number}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleApplyCredit = async (credit: CustomerCredit, mode: 'apply' | 'refund') => {
    try {
      await apiFetch(`/api/credits/${credit.id}/apply`, { method: 'POST', body: { mode } });
      notify(mode === 'refund' ? `Refunded ${credit.credit_number} via EFT` : `Applied ${credit.credit_number} to open invoice`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleRunRecurring = async (tpl: RecurringTemplate) => {
    try {
      const res = await apiFetch<{ doc: SalesDoc }>(`/api/recurring/${tpl.id}/run`, { method: 'POST', body: {} });
      notify(`Generated Tax Invoice ${res.doc.doc_number} from recurring schedule`);
      setTab('invoices');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const currentList = tab === 'invoices' ? invoices : tab === 'quotes' ? quotes : orders;
  const filteredDocs = currentList.filter((d) => {
    if (statusFilter !== 'All' && d.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return d.doc_number.toLowerCase().includes(q) || d.customer_name.toLowerCase().includes(q);
    }
    return true;
  });

  const totalsPreview = calcPreviewTotals();

  return (
    <div className="opal-app">
      <header className="opal-topbar">
        <div className="opal-brand">
          <div className="opal-brand-mark">SL</div>
          <div>
            <h1>Sales &amp; Invoicing</h1>
            <div className="opal-brand-sub">AU Tax Invoices · Quotes · Sales Orders · Credit Notes · Recurring</div>
          </div>
        </div>

        <nav className="opal-tabs">
          <button className={`opal-tab ${tab === 'invoices' ? 'active' : ''}`} onClick={() => { setTab('invoices'); setStatusFilter('All'); }}>
            Invoices <span className="opal-tab-count">{invoices.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'quotes' ? 'active' : ''}`} onClick={() => { setTab('quotes'); setStatusFilter('All'); }}>
            Quotes <span className="opal-tab-count">{quotes.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'orders' ? 'active' : ''}`} onClick={() => { setTab('orders'); setStatusFilter('All'); }}>
            Sales Orders <span className="opal-tab-count">{orders.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'credits' ? 'active' : ''}`} onClick={() => setTab('credits')}>
            Returns &amp; Credits <span className="opal-tab-count">{credits.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'recurring' ? 'active' : ''}`} onClick={() => setTab('recurring')}>
            Recurring <span className="opal-tab-count">{recurring.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'payments' ? 'active' : ''}`} onClick={() => setTab('payments')}>
            Payments <span className="opal-tab-count">{payments.length}</span>
          </button>
        </nav>

        <div className="opal-actions">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP · XDB' : 'Standalone PHP'}
            </span>
          )}
          <button className="btn btn-soft btn-sm" onClick={() => openCreateModal('quote')}>+ Quote</button>
          <button className="btn btn-primary btn-sm" onClick={() => openCreateModal('invoice')}>+ Tax Invoice</button>
        </div>
      </header>

      <main className="opal-main">
        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #6100a5, #7c3aed)' } as React.CSSProperties}>
              <div className="kpi-label">Outstanding Receivables</div>
              <div className="kpi-value">{formatAud(overview.outstanding)}</div>
              <div className="kpi-sub">Total invoiced {formatCompactAud(overview.totalInvoiced)} · Collected {formatCompactAud(overview.totalPaid)}</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #dc2626, #f97316)' } as React.CSSProperties}>
              <div className="kpi-label">Overdue Invoices</div>
              <div className="kpi-value text-danger">{formatAud(overview.overdueAmount)}</div>
              <div className="kpi-sub">{overview.overdueCount} invoice(s) past due date · Reminders active</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #0d9488, #059669)' } as React.CSSProperties}>
              <div className="kpi-label">GST Collected (BAS 1A)</div>
              <div className="kpi-value text-opal">{formatAud(overview.gstCollected)}</div>
              <div className="kpi-sub">10% AU GST tracked across Tax Invoices</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #2563eb, #6366f1)' } as React.CSSProperties}>
              <div className="kpi-label">Pipeline (Quotes &amp; Orders)</div>
              <div className="kpi-value">{formatAud(overview.quotesOpen + overview.ordersOpen)}</div>
              <div className="kpi-sub">{overview.recurringActive} active recurring schedules · {formatAud(overview.openCredits)} open credits</div>
            </div>
          </section>
        )}

        {(tab === 'invoices' || tab === 'quotes' || tab === 'orders') && (
          <section className="panel">
            <div className="toolbar">
              <div className="filter-pills">
                {(tab === 'invoices'
                  ? ['All', 'Open', 'Partial', 'Overdue', 'Paid']
                  : tab === 'quotes'
                    ? ['All', 'Sent', 'Accepted', 'Converted']
                    : ['All', 'Confirmed', 'Converted']
                ).map((st) => (
                  <button key={st} className={`pill-btn ${statusFilter === st ? 'active' : ''}`} onClick={() => setStatusFilter(st)}>
                    {st}
                  </button>
                ))}
              </div>
              <div className="row">
                <input
                  className="input input-sm"
                  placeholder="Search number or customer..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {tab === 'orders' && (
                  <button className="btn btn-primary btn-sm" onClick={() => openCreateModal('order')}>+ Sales Order</button>
                )}
              </div>
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Customer</th>
                    <th>Issue Date</th>
                    <th>Due / Expiry</th>
                    <th>Status</th>
                    <th className="right">GST</th>
                    <th className="right">Total (AUD)</th>
                    {tab === 'invoices' && <th className="right">Balance Due</th>}
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDocs.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <button className="btn btn-ghost btn-xs fw-700 text-brand" onClick={() => setPreviewDoc(d)}>
                          {d.doc_number}
                        </button>
                        {d.online_pay_enabled === 1 && d.doc_type === 'invoice' && (
                          <div className="row-sub">Online Pay · BPAY</div>
                        )}
                      </td>
                      <td>
                        <div className="fw-700">{d.customer_name}</div>
                        <div className="row-sub">ABN {formatAbn(d.customer_abn)}</div>
                      </td>
                      <td>{formatAuDate(d.issue_date)}</td>
                      <td>{formatAuDate(d.due_date)}</td>
                      <td>
                        <span className={`badge ${statusClass(d.status)}`}>{d.status}</span>
                        {d.reminder_count > 0 && <div className="row-sub">{d.reminder_count} reminder(s)</div>}
                      </td>
                      <td className="right money">{formatAud(d.gst_amount)}</td>
                      <td className="right money fw-700">{formatAud(d.total)}</td>
                      {tab === 'invoices' && (
                        <td className={`right money fw-700 ${d.balance_due > 0 ? 'text-danger' : 'text-success'}`}>
                          {formatAud(d.balance_due)}
                        </td>
                      )}
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          <button className="btn btn-xs" onClick={() => setPreviewDoc(d)}>View</button>
                          {d.doc_type === 'invoice' && d.balance_due > 0 && (
                            <>
                              <button
                                className="btn btn-opal btn-xs"
                                onClick={() => {
                                  setPayDoc(d);
                                  setPayAmount(String(d.balance_due));
                                  setPayRef(`OSKO-${d.doc_number.slice(-4)}`);
                                }}
                              >
                                Record Payment
                              </button>
                              <button className="btn btn-xs" onClick={() => void handleRemind(d)}>Remind</button>
                            </>
                          )}
                          {d.doc_type === 'quote' && d.status !== 'Converted' && (
                            <>
                              <button className="btn btn-soft btn-xs" onClick={() => void handleConvert(d, 'order')}>To Order</button>
                              <button className="btn btn-primary btn-xs" onClick={() => void handleConvert(d, 'invoice')}>To Invoice</button>
                            </>
                          )}
                          {d.doc_type === 'order' && d.status !== 'Converted' && (
                            <button className="btn btn-primary btn-xs" onClick={() => void handleConvert(d, 'invoice')}>Convert to Invoice</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredDocs.length === 0 && (
                    <tr>
                      <td colSpan={9}>
                        <div className="empty-state">
                          <h3>No matching records</h3>
                          <div>Create a new Tax Invoice, Quote, or Sales Order to populate this list.</div>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'credits' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Customer Returns &amp; Adjustment Notes</h2>
                <div className="panel-subtitle">Apply customer credits directly against open Tax Invoices or process EFT refunds.</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowCreditModal(true)}>+ New Credit Note</button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Credit #</th>
                    <th>Customer</th>
                    <th>Date</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th className="right">GST</th>
                    <th className="right">Credit Total</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {credits.map((c) => (
                    <tr key={c.id}>
                      <td className="fw-700 text-brand">{c.credit_number}</td>
                      <td className="fw-700">{c.customer_name}</td>
                      <td>{formatAuDate(c.issue_date)}</td>
                      <td>
                        {c.reason}
                        {c.applied_doc_number && <div className="row-sub">Settled against {c.applied_doc_number}</div>}
                      </td>
                      <td><span className={`badge ${statusClass(c.status)}`}>{c.status}</span></td>
                      <td className="right money">{formatAud(c.gst_amount)}</td>
                      <td className="right money fw-700">{formatAud(c.total)}</td>
                      <td className="right">
                        {c.status === 'Open' ? (
                          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                            <button className="btn btn-primary btn-xs" onClick={() => void handleApplyCredit(c, 'apply')}>Apply to Invoice</button>
                            <button className="btn btn-xs" onClick={() => void handleApplyCredit(c, 'refund')}>Refund EFT</button>
                          </div>
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

        {tab === 'recurring' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Recurring Tax Invoices</h2>
                <div className="panel-subtitle">Automated retainers and scheduled billing with one-click invoice generation.</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Schedule Name</th>
                    <th>Customer</th>
                    <th>Frequency</th>
                    <th>Next Run</th>
                    <th className="right">GST</th>
                    <th className="right">Total (AUD)</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {recurring.map((r) => (
                    <tr key={r.id}>
                      <td className="fw-700">{r.template_name}</td>
                      <td>
                        <div>{r.customer_name}</div>
                        <div className="row-sub">ABN {formatAbn(r.customer_abn)}</div>
                      </td>
                      <td><span className="badge badge-brand">{r.frequency}</span></td>
                      <td>{formatAuDate(r.next_run_date)}</td>
                      <td className="right money">{formatAud(r.gst_amount)}</td>
                      <td className="right money fw-700">{formatAud(r.total)}</td>
                      <td className="right">
                        <button className="btn btn-opal btn-xs" onClick={() => void handleRunRecurring(r)}>Generate Invoice Now</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'payments' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Customer Payments Received</h2>
                <div className="panel-subtitle">EFT/OSKO, BPAY, and Online Card payments matched to Australian Tax Invoices.</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Invoice #</th>
                    <th>Customer</th>
                    <th>Payment Method</th>
                    <th>Reference</th>
                    <th className="right">Amount Received</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td>{formatAuDate(p.payment_date)}</td>
                      <td className="fw-700 text-brand">{p.doc_number}</td>
                      <td className="fw-700">{p.customer_name}</td>
                      <td><span className="badge badge-opal">{p.method}</span></td>
                      <td className="num">{p.reference}</td>
                      <td className="right money fw-700 text-success">{formatAud(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* Create Document Modal */}
      {newDocType && (
        <div className="modal-backdrop" onClick={() => setNewDocType(null)}>
          <form className="modal modal-lg" onClick={(e) => e.stopPropagation()} onSubmit={submitNewDoc}>
            <div className="modal-head">
              <h2>
                New {newDocType === 'invoice' ? 'Australian Tax Invoice' : newDocType === 'quote' ? 'Customer Quote' : 'Sales Order'}
              </h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNewDocType(null)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid-3">
                <div className="field">
                  <label>Customer Name</label>
                  <input className="input" required value={formCustomer} onChange={(e) => setFormCustomer(e.target.value)} placeholder="e.g. Bondi Surf Co Pty Ltd" />
                </div>
                <div className="field">
                  <label>Customer ABN (Optional)</label>
                  <input className="input" value={formAbn} onChange={(e) => setFormAbn(e.target.value)} placeholder="53 004 085 616" />
                </div>
                <div className="field">
                  <label>Due / Expiry Date</label>
                  <input className="input" type="date" value={formDueDate} onChange={(e) => setFormDueDate(e.target.value)} />
                </div>
              </div>

              <div className="row">
                <label className="fw-700">Amounts Are:</label>
                <div className="filter-pills">
                  <button type="button" className={`pill-btn ${formTaxMode === 'exclusive' ? 'active' : ''}`} onClick={() => setFormTaxMode('exclusive')}>
                    Tax Exclusive (+10% GST)
                  </button>
                  <button type="button" className={`pill-btn ${formTaxMode === 'inclusive' ? 'active' : ''}`} onClick={() => setFormTaxMode('inclusive')}>
                    Tax Inclusive (1/11th GST)
                  </button>
                </div>
              </div>

              <div className="line-editor">
                <table>
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th style={{ width: 80 }}>Qty</th>
                      <th style={{ width: 120 }}>Unit Price</th>
                      <th style={{ width: 110 }}>Tax Code</th>
                      <th style={{ width: 42 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {formLines.map((line, idx) => (
                      <tr key={idx}>
                        <td>
                          <input
                            className="input"
                            required
                            value={line.description}
                            onChange={(e) => setFormLines((prev) => prev.map((l, i) => (i === idx ? { ...l, description: e.target.value } : l)))}
                            placeholder="Product or service description"
                          />
                        </td>
                        <td>
                          <input
                            className="input num"
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={line.qty}
                            onChange={(e) => setFormLines((prev) => prev.map((l, i) => (i === idx ? { ...l, qty: Number(e.target.value) } : l)))}
                          />
                        </td>
                        <td>
                          <input
                            className="input num"
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.unitPrice}
                            onChange={(e) => setFormLines((prev) => prev.map((l, i) => (i === idx ? { ...l, unitPrice: Number(e.target.value) } : l)))}
                          />
                        </td>
                        <td>
                          <select
                            className="select"
                            value={line.taxCode}
                            onChange={(e) => setFormLines((prev) => prev.map((l, i) => (i === idx ? { ...l, taxCode: e.target.value as SalesLine['taxCode'] } : l)))}
                          >
                            <option value="GST">GST (10%)</option>
                            <option value="FRE">FRE (0%)</option>
                            <option value="EXP">EXP (0%)</option>
                            <option value="N-T">N-T (0%)</option>
                          </select>
                        </td>
                        <td>
                          {formLines.length > 1 && (
                            <button
                              type="button"
                              className="btn btn-danger btn-xs"
                              onClick={() => setFormLines((prev) => prev.filter((_, i) => i !== idx))}
                            >
                              ×
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="row">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setFormLines((prev) => [...prev, { description: '', qty: 1, unitPrice: 0, taxCode: 'GST' }])}
                >
                  + Add Line
                </button>
                <div className="spacer" />
                <div className="doc-totals" style={{ marginTop: 0 }}>
                  <div className="doc-totals-row"><span>Subtotal (Ex GST)</span><span className="money">{formatAud(totalsPreview.sub)}</span></div>
                  <div className="doc-totals-row"><span>GST (10%)</span><span className="money">{formatAud(totalsPreview.gst)}</span></div>
                  <div className="doc-totals-row grand"><span>Total (AUD)</span><span className="money">{formatAud(totalsPreview.tot)}</span></div>
                </div>
              </div>

              <div className="field">
                <label>Notes &amp; Payment Instructions</label>
                <input className="input" value={formNotes} onChange={(e) => setFormNotes(e.target.value)} />
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setNewDocType(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save &amp; Issue</button>
            </div>
          </form>
        </div>
      )}

      {/* Australian Tax Invoice Preview Sheet */}
      {previewDoc && (
        <div className="modal-backdrop" onClick={() => setPreviewDoc(null)}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{previewDoc.doc_type === 'invoice' ? 'TAX INVOICE' : previewDoc.doc_type === 'quote' ? 'QUOTE' : 'SALES ORDER'} · {previewDoc.doc_number}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setPreviewDoc(null)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="doc-sheet">
                <div className="doc-sheet-header">
                  <div>
                    <div className="fw-700" style={{ fontSize: 18, color: 'var(--brand)' }}>Harbourview Digital Pty Ltd</div>
                    <div className="muted">ABN 53 004 085 616 · Level 14, 60 Margaret St, Sydney NSW 2000</div>
                    <div className="muted">accounts@harbourviewdigital.com.au</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="fw-700" style={{ fontSize: 20, letterSpacing: '-0.02em' }}>
                      {previewDoc.doc_type === 'invoice' ? 'TAX INVOICE' : previewDoc.doc_type === 'quote' ? 'QUOTE' : 'SALES ORDER'}
                    </div>
                    <div className="num fw-700 text-brand">{previewDoc.doc_number}</div>
                    <span className={`badge ${statusClass(previewDoc.status)}`}>{previewDoc.status}</span>
                  </div>
                </div>

                <div className="form-grid" style={{ marginBottom: 16 }}>
                  <div>
                    <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 700 }}>Bill To</div>
                    <div className="fw-700">{previewDoc.customer_name}</div>
                    <div className="muted">ABN {formatAbn(previewDoc.customer_abn)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div><span className="muted">Issue Date:</span> <strong>{formatAuDate(previewDoc.issue_date)}</strong></div>
                    <div><span className="muted">Due Date:</span> <strong>{formatAuDate(previewDoc.due_date)}</strong></div>
                    <div><span className="muted">Tax Mode:</span> <strong>{previewDoc.tax_mode === 'inclusive' ? 'GST Inclusive' : 'GST Exclusive'}</strong></div>
                  </div>
                </div>

                <table className="table">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th className="right">Qty</th>
                      <th className="right">Unit Price</th>
                      <th>Tax</th>
                      <th className="right">Amount (AUD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewDoc.lines.map((l, idx) => (
                      <tr key={idx}>
                        <td>{l.description}</td>
                        <td className="right num">{l.qty}</td>
                        <td className="right money">{formatAud(l.unitPrice)}</td>
                        <td><span className="badge badge-neutral">{l.taxCode || 'GST'}</span></td>
                        <td className="right money fw-700">{formatAud(l.qty * l.unitPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="doc-totals">
                  <div className="doc-totals-row"><span>Subtotal</span><span className="money">{formatAud(previewDoc.subtotal)}</span></div>
                  <div className="doc-totals-row"><span>GST (10%)</span><span className="money">{formatAud(previewDoc.gst_amount)}</span></div>
                  <div className="doc-totals-row grand"><span>Total AUD</span><span className="money">{formatAud(previewDoc.total)}</span></div>
                  {previewDoc.doc_type === 'invoice' && (
                    <>
                      <div className="doc-totals-row"><span>Amount Paid</span><span className="money text-success">-{formatAud(previewDoc.paid_amount)}</span></div>
                      <div className="doc-totals-row fw-700"><span>Balance Due</span><span className="money text-brand">{formatAud(previewDoc.balance_due)}</span></div>
                    </>
                  )}
                </div>

                <div className="callout callout-brand" style={{ marginTop: 18 }}>
                  <div>
                    <div className="fw-700">How to Pay (Australia)</div>
                    <div>EFT / OSKO: CommBank · BSB <strong>062-000</strong> · Acc <strong>1084 9201</strong> · Ref <strong>{previewDoc.doc_number}</strong></div>
                    <div>BPAY Biller Code: <strong>482910</strong> · Online Card &amp; Apple Pay Enabled</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setPreviewDoc(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Record Customer Payment Modal */}
      {payDoc && (
        <div className="modal-backdrop" onClick={() => setPayDoc(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submitPayment}>
            <div className="modal-head">
              <h2>Record Payment · {payDoc.doc_number}</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPayDoc(null)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="callout callout-brand">
                <div>
                  <div className="fw-700">{payDoc.customer_name}</div>
                  <div>Balance remaining: <strong>{formatAud(payDoc.balance_due)}</strong></div>
                </div>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label>Amount Received (AUD)</label>
                  <input className="input num" type="number" step="0.01" required value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </div>
                <div className="field">
                  <label>Payment Method</label>
                  <select className="select" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                    <option value="EFT / OSKO">EFT / OSKO</option>
                    <option value="BPAY">BPAY</option>
                    <option value="Credit Card (Online)">Credit Card (Online Pay)</option>
                    <option value="Direct Deposit">Direct Deposit</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label>Bank / Payment Reference</label>
                <input className="input" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setPayDoc(null)}>Cancel</button>
              <button type="submit" className="btn btn-opal">Confirm Payment</button>
            </div>
          </form>
        </div>
      )}

      {/* New Credit Note Modal */}
      {showCreditModal && (
        <div className="modal-backdrop" onClick={() => setShowCreditModal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submitCredit}>
            <div className="modal-head">
              <h2>Issue Customer Credit / Adjustment Note</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCreditModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field">
                  <label>Customer Name</label>
                  <input className="input" required value={creditCustomer} onChange={(e) => setCreditCustomer(e.target.value)} />
                </div>
                <div className="field">
                  <label>Total Credit Amount (Inc GST)</label>
                  <input className="input num" type="number" step="0.01" required value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>Reason for Adjustment / Return</label>
                <input className="input" required value={creditReason} onChange={(e) => setCreditReason(e.target.value)} />
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowCreditModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create Credit Note</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
