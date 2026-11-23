import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../shared/ui/opal.css';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatAuDate, formatAud } from '../../../shared/ui/format';

interface AccountingOverview {
  totalAssets: number;
  totalLiabilities: number;
  netProfit: number;
  netBasPayable: number;
  anomalyCount: number;
  accountCount: number;
  journalCount: number;
}

interface Account {
  id: number;
  code: string;
  name: string;
  classification: string;
  account_type: string;
  default_tax_code: string;
  balance: number;
  is_system: number;
}

interface JournalLine {
  id?: number;
  account_code: string;
  account_name?: string;
  tax_code: string;
  debit: number;
  credit: number;
  line_memo: string;
}

interface JournalEntry {
  id: number;
  journal_number: string;
  entry_date: string;
  memo: string;
  source: string;
  total_debit: number;
  total_credit: number;
  reversed: number;
  lines: JournalLine[];
}

interface TaxTx {
  id: number;
  period: string;
  tx_date: string;
  reference: string;
  direction: string;
  tax_code: string;
  account_code: string;
  gross_amount: number;
  gst_amount: number;
  anomaly_flag: string;
  resolved: number;
}

interface BasSnapshot {
  period: string;
  dateRange: string;
  dueDate: string;
  G1: number;
  G2: number;
  G3: number;
  G10: number;
  G11: number;
  '1A': number;
  '1B': number;
  netGst: number;
  W1: number;
  W2: number;
  netBasPayable: number;
  anomalies: TaxTx[];
  transactions: TaxTx[];
}

interface BasLodgement {
  id: number;
  period: string;
  date_range: string;
  gst_1a: number;
  gst_1b: number;
  w2_payg: number;
  net_payable: number;
  status: string;
  ato_receipt: string;
  lodged_at: string;
}

const AU_TAX_CODES = [
  { code: 'GST', name: 'Goods & Services Tax', rate: '10%', bas: 'G1 / G11 / 1A / 1B', desc: 'Standard Australian taxable sales & non-capital purchases.' },
  { code: 'CAP', name: 'Capital Acquisitions', rate: '10%', bas: 'G10 / 1B', desc: 'Fixed assets, equipment & vehicles over $1,000 GST-inclusive.' },
  { code: 'FRE', name: 'GST-Free', rate: '0%', bas: 'G1 / G3 / G11', desc: 'Basic food, medical/health services, education & bank fees.' },
  { code: 'EXP', name: 'Export Sales', rate: '0%', bas: 'G1 / G2', desc: 'Overseas goods or services consumed outside Australia.' },
  { code: 'INP', name: 'Input Taxed Purchases', rate: '0%', bas: 'G11', desc: 'Purchases tied to financial supplies or residential rent.' },
  { code: 'ITS', name: 'Input Taxed Sales', rate: '0%', bas: 'G1', desc: 'Residential property rental & financial supplies.' },
  { code: 'N-T', name: 'Not Reportable', rate: '0%', bas: 'Excluded', desc: 'Wages, super, owner drawings, ATO payments & transfers.' },
];

type TabKey = 'bas' | 'accounts' | 'journals' | 'taxcodes';

function App() {
  const [tab, setTab] = useState<TabKey>('bas');
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [overview, setOverview] = useState<AccountingOverview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [journals, setJournals] = useState<JournalEntry[]>([]);
  const [bas, setBas] = useState<BasSnapshot | null>(null);
  const [lodgements, setLodgements] = useState<BasLodgement[]>([]);
  const [classFilter, setClassFilter] = useState('All');
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  // Modals
  const [showAccModal, setShowAccModal] = useState(false);
  const [accCode, setAccCode] = useState('6-2900');
  const [accName, setAccName] = useState('Marketing & Digital Ads');
  const [accClass, setAccClass] = useState('Expense');
  const [accTax, setAccTax] = useState('GST');

  const [showJournalModal, setShowJournalModal] = useState(false);
  const [jMemo, setJMemo] = useState('Monthly Equipment Depreciation');
  const [jDate, setJDate] = useState('2026-11-22');
  const [jLines, setJLines] = useState<JournalLine[]>([
    { account_code: '6-1400', tax_code: 'N-T', debit: 850, credit: 0, line_memo: 'Depreciation expense' },
    { account_code: '1-3200', tax_code: 'N-T', debit: 0, credit: 850, line_memo: 'Accumulated depreciation' },
  ]);

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast((prev) => (prev?.msg === msg ? null : prev)), 3400);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [rt, ov, ac, jn, bs] = await Promise.all([
        apiFetch<RuntimeInfo>('/api/runtime'),
        apiFetch<AccountingOverview>('/api/overview'),
        apiFetch<{ accounts: Account[] }>('/api/accounts'),
        apiFetch<{ journals: JournalEntry[] }>('/api/journals'),
        apiFetch<{ bas: BasSnapshot; lodgements: BasLodgement[] }>('/api/bas'),
      ]);
      setRuntime(rt);
      setOverview(ov);
      setAccounts(ac.accounts);
      setJournals(jn.journals);
      setBas(bs.bas);
      setLodgements(bs.lodgements);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleResolveAnomaly = async (tx: TaxTx, newCode: string) => {
    try {
      await apiFetch(`/api/bas/anomalies/${tx.id}/resolve`, { method: 'POST', body: { tax_code: newCode } });
      notify(`AI BAS check resolved for ${tx.reference} (${newCode})`);
      await loadAll();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };

  const handleLodgeBas = async () => {
    try {
      const res = await apiFetch<{ lodgement: BasLodgement }>('/api/bas/lodge', { method: 'POST', body: {} });
      notify(`BAS lodged with ATO! Receipt: ${res.lodgement.ato_receipt}`);
      await loadAll();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/accounts', {
        method: 'POST',
        body: { code: accCode, name: accName, classification: accClass, account_type: accClass, default_tax_code: accTax },
      });
      setShowAccModal(false);
      notify(`Added account ${accCode} ${accName}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const jDr = jLines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const jCr = jLines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const jBalanced = jDr > 0 && Math.abs(jDr - jCr) < 0.01;

  const handleCreateJournal = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ journal: JournalEntry }>('/api/journals', {
        method: 'POST',
        body: { memo: jMemo, entry_date: jDate, lines: jLines },
      });
      setShowJournalModal(false);
      notify(`Posted General Journal ${res.journal.journal_number}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleReverseJournal = async (j: JournalEntry) => {
    try {
      await apiFetch(`/api/journals/${j.id}/reverse`, { method: 'POST', body: {} });
      notify(`Created reversal journal for ${j.journal_number}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const filteredAccounts = classFilter === 'All' ? accounts : accounts.filter((a) => a.classification === classFilter);

  return (
    <div className="opal-app">
      <header className="opal-topbar">
        <div className="opal-brand">
          <div className="opal-brand-mark" style={{ background: 'linear-gradient(135deg, #6100a5, #4338ca)' }}>GL</div>
          <div>
            <h1>Accounting, Chart of Accounts &amp; BAS</h1>
            <div className="opal-brand-sub">AU Categories (1-xxxx–8-xxxx) · Double-Entry Journals · AI BAS &amp; ATO Lodgement</div>
          </div>
        </div>

        <nav className="opal-tabs">
          <button className={`opal-tab ${tab === 'bas' ? 'active' : ''}`} onClick={() => setTab('bas')}>
            GST &amp; AI BAS <span className="opal-tab-count">{bas?.anomalies.length ?? 0}</span>
          </button>
          <button className={`opal-tab ${tab === 'accounts' ? 'active' : ''}`} onClick={() => setTab('accounts')}>
            Chart of Accounts <span className="opal-tab-count">{accounts.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'journals' ? 'active' : ''}`} onClick={() => setTab('journals')}>
            General Journals <span className="opal-tab-count">{journals.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'taxcodes' ? 'active' : ''}`} onClick={() => setTab('taxcodes')}>
            AU Tax Codes
          </button>
        </nav>

        <div className="opal-actions">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP · XDB' : 'Standalone PHP'}
            </span>
          )}
          <button className="btn btn-soft btn-sm" onClick={() => setShowAccModal(true)}>+ Account</button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowJournalModal(true)}>+ General Journal</button>
        </div>
      </header>

      <main className="opal-main">
        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #6100a5, #8b5cf6)' } as React.CSSProperties}>
              <div className="kpi-label">Est. Q2 BAS Payable (ATO)</div>
              <div className="kpi-value text-brand">{formatAud(overview.netBasPayable)}</div>
              <div className="kpi-sub">Net GST (1A − 1B) + PAYG Withholding (W2)</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #0d9488, #10b981)' } as React.CSSProperties}>
              <div className="kpi-label">Total Assets</div>
              <div className="kpi-value">{formatAud(overview.totalAssets)}</div>
              <div className="kpi-sub">Liabilities: {formatAud(overview.totalLiabilities)}</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #059669, #34d399)' } as React.CSSProperties}>
              <div className="kpi-label">YTD Operating Net Profit</div>
              <div className="kpi-value text-success">{formatAud(overview.netProfit)}</div>
              <div className="kpi-sub">{overview.accountCount} active accounts · {overview.journalCount} journals</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': overview.anomalyCount > 0 ? 'linear-gradient(90deg, #d97706, #ef4444)' : 'linear-gradient(90deg, #059669, #0d9488)' } as React.CSSProperties}>
              <div className="kpi-label">AI BAS Compliance Audit</div>
              <div className={`kpi-value ${overview.anomalyCount > 0 ? 'text-warning' : 'text-success'}`}>
                {overview.anomalyCount > 0 ? `${overview.anomalyCount} Flags` : 'All Clear'}
              </div>
              <div className="kpi-sub">{overview.anomalyCount > 0 ? 'Review GST anomalies before ATO lodgement' : 'Ready for direct ATO SBR lodgement'}</div>
            </div>
          </section>
        )}

        {tab === 'bas' && bas && (
          <div className="stack" style={{ gap: 16 }}>
            {/* AI BAS Anomaly Guard */}
            {bas.anomalies.length > 0 ? (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2 className="panel-title">AI BAS Smart Checks — {bas.anomalies.length} Flagged Transaction(s)</h2>
                    <div className="panel-subtitle">Automated MYOB-style pre-lodgement GST audit detects misclassified tax codes before you lodge to the ATO.</div>
                  </div>
                </div>
                <div className="panel-body stack">
                  {bas.anomalies.map((an) => (
                    <div key={an.id} className="callout callout-warning">
                      <div>
                        <div className="fw-700">{an.reference} · {formatAud(an.gross_amount)} ({an.tax_code} on {an.account_code})</div>
                        <div>{an.anomaly_flag}</div>
                      </div>
                      <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                        {an.account_code === '1-3200' && (
                          <button className="btn btn-primary btn-xs" onClick={() => void handleResolveAnomaly(an, 'CAP')}>
                            Reclassify to CAP (G10)
                          </button>
                        )}
                        <button className="btn btn-sm btn-xs" onClick={() => void handleResolveAnomaly(an, an.tax_code)}>
                          Confirm &amp; Mark Reviewed
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <div className="callout callout-success">
                <div><strong>AI BAS Pre-Lodgement Audit Passed:</strong> Zero tax-code anomalies detected for {bas.period}.</div>
                <span className="badge badge-success">ATO Ready</span>
              </div>
            )}

            {/* Official ATO BAS Worksheet */}
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2 className="panel-title">Business Activity Statement (BAS) · {bas.period}</h2>
                  <div className="panel-subtitle">{bas.dateRange} · Due {formatAuDate(bas.dueDate)} · ABN 53 004 085 616 (Accrual Method)</div>
                </div>
                <button className="btn btn-primary" onClick={() => void handleLodgeBas()}>
                  Lodge BAS Direct to ATO ({formatAud(bas.netBasPayable)})
                </button>
              </div>
              <div className="panel-body stack">
                <div className="bas-grid">
                  <div className="bas-box">
                    <div className="row"><span className="bas-code">G1</span><span className="fw-700">Total Sales (inc GST)</span></div>
                    <div className="bas-amount">{formatAud(bas.G1)}</div>
                    <div className="row-sub">G2 Exports: {formatAud(bas.G2)} · G3 GST-Free: {formatAud(bas.G3)}</div>
                  </div>
                  <div className="bas-box">
                    <div className="row"><span className="bas-code">G10</span><span className="fw-700">Capital Purchases</span></div>
                    <div className="bas-amount">{formatAud(bas.G10)}</div>
                    <div className="row-sub">Equipment &amp; fixed assets (CAP)</div>
                  </div>
                  <div className="bas-box">
                    <div className="row"><span className="bas-code">G11</span><span className="fw-700">Non-Capital Purchases</span></div>
                    <div className="bas-amount">{formatAud(bas.G11)}</div>
                    <div className="row-sub">Operating expenses &amp; inventory</div>
                  </div>
                  <div className="bas-box">
                    <div className="row"><span className="bas-code" style={{ background: 'var(--opal)' }}>1A</span><span className="fw-700">GST on Sales</span></div>
                    <div className="bas-amount text-brand">{formatAud(bas['1A'])}</div>
                    <div className="row-sub">Collected on taxable supplies</div>
                  </div>
                  <div className="bas-box">
                    <div className="row"><span className="bas-code" style={{ background: 'var(--opal)' }}>1B</span><span className="fw-700">GST on Purchases</span></div>
                    <div className="bas-amount text-opal">{formatAud(bas['1B'])}</div>
                    <div className="row-sub">Net GST (1A − 1B): {formatAud(bas.netGst)}</div>
                  </div>
                  <div className="bas-box">
                    <div className="row"><span className="bas-code" style={{ background: '#1e293b' }}>W1 / W2</span><span className="fw-700">PAYG Tax Withheld</span></div>
                    <div className="bas-amount">{formatAud(bas.W2)}</div>
                    <div className="row-sub">W1 Gross Wages: {formatAud(bas.W1)}</div>
                  </div>
                </div>

                <div className="callout callout-brand">
                  <div>
                    <div className="fw-700" style={{ fontSize: 15 }}>Total Net BAS Payment to ATO (1A − 1B + W2)</div>
                    <div className="muted">Calculated live from SQLite GST ledger &amp; PAYG withholding accounts.</div>
                  </div>
                  <div className="money fw-700 text-brand" style={{ fontSize: 22 }}>{formatAud(bas.netBasPayable)}</div>
                </div>
              </div>
            </section>

            {/* BAS Lodgement History */}
            <section className="panel">
              <div className="panel-head"><h2 className="panel-title">ATO BAS Lodgement History</h2></div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Date Range</th>
                      <th>ATO SBR Receipt</th>
                      <th className="right">1A GST Sales</th>
                      <th className="right">1B GST Credits</th>
                      <th className="right">W2 PAYG</th>
                      <th className="right">Net Payable</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lodgements.map((lg) => (
                      <tr key={lg.id}>
                        <td className="fw-700">{lg.period}</td>
                        <td>{lg.date_range}</td>
                        <td className="num fw-700 text-brand">{lg.ato_receipt}</td>
                        <td className="right money">{formatAud(lg.gst_1a)}</td>
                        <td className="right money">{formatAud(lg.gst_1b)}</td>
                        <td className="right money">{formatAud(lg.w2_payg)}</td>
                        <td className="right money fw-700">{formatAud(lg.net_payable)}</td>
                        <td><span className="badge badge-success">{lg.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {tab === 'accounts' && (
          <section className="panel">
            <div className="toolbar">
              <div className="filter-pills">
                {['All', 'Asset', 'Liability', 'Equity', 'Income', 'Cost of Sales', 'Expense', 'Other Income'].map((c) => (
                  <button key={c} className={`pill-btn ${classFilter === c ? 'active' : ''}`} onClick={() => setClassFilter(c)}>
                    {c}
                  </button>
                ))}
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowAccModal(true)}>+ Create Account</button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Account #</th>
                    <th>Account Name (Category)</th>
                    <th>Classification</th>
                    <th>Type</th>
                    <th>Default Tax</th>
                    <th className="right">Current Balance (AUD)</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.map((a) => (
                    <tr key={a.id}>
                      <td className="num fw-700 text-brand">{a.code}</td>
                      <td className="fw-700">{a.name}</td>
                      <td><span className="badge badge-neutral">{a.classification}</span></td>
                      <td className="muted">{a.account_type}</td>
                      <td><span className="badge badge-opal">{a.default_tax_code}</span></td>
                      <td className="right money fw-700">{formatAud(a.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'journals' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">General Journal Entries</h2>
                <div className="panel-subtitle">Double-entry adjustments, accruals, depreciation &amp; one-click journal reversals.</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowJournalModal(true)}>+ Record Journal Entry</button>
            </div>
            <div className="panel-body stack">
              {journals.map((j) => (
                <div key={j.id} className="panel" style={{ boxShadow: 'none' }}>
                  <div className="panel-head" style={{ padding: '10px 14px' }}>
                    <div>
                      <span className="fw-700 text-brand">{j.journal_number}</span> · <strong>{j.memo}</strong>
                      <div className="row-sub">{formatAuDate(j.entry_date)} · Source: {j.source}</div>
                    </div>
                    <div className="row">
                      <span className="badge badge-success">Balanced {formatAud(j.total_debit)}</span>
                      {j.reversed === 1 ? (
                        <span className="badge badge-neutral">Reversed</span>
                      ) : (
                        <button className="btn btn-xs" onClick={() => void handleReverseJournal(j)}>Reverse</button>
                      )}
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Account</th>
                          <th>Memo</th>
                          <th>Tax</th>
                          <th className="right">Debit</th>
                          <th className="right">Credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {j.lines.map((l, idx) => (
                          <tr key={idx}>
                            <td><strong className="num">{l.account_code}</strong> · {l.account_name}</td>
                            <td className="muted">{l.line_memo}</td>
                            <td><span className="badge badge-neutral">{l.tax_code}</span></td>
                            <td className="right money">{l.debit > 0 ? formatAud(l.debit) : '—'}</td>
                            <td className="right money">{l.credit > 0 ? formatAud(l.credit) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === 'taxcodes' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Australian GST &amp; BAS Tax Codes</h2>
                <div className="panel-subtitle">Pre-configured to ATO Business Activity Statement reporting labels.</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Description</th>
                    <th>Rate</th>
                    <th>BAS Labels</th>
                    <th>Usage</th>
                  </tr>
                </thead>
                <tbody>
                  {AU_TAX_CODES.map((tc) => (
                    <tr key={tc.code}>
                      <td><span className="badge badge-brand">{tc.code}</span></td>
                      <td className="fw-700">{tc.name}</td>
                      <td className="num fw-700">{tc.rate}</td>
                      <td><span className="badge badge-opal">{tc.bas}</span></td>
                      <td className="muted">{tc.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* New Account Modal */}
      {showAccModal && (
        <div className="modal-backdrop" onClick={() => setShowAccModal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateAccount}>
            <div className="modal-head">
              <h2>Add Account to Chart of Accounts</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAccModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field">
                  <label>Account Number (MYOB Format)</label>
                  <input className="input" required value={accCode} onChange={(e) => setAccCode(e.target.value)} placeholder="6-2900" />
                </div>
                <div className="field">
                  <label>Account Name</label>
                  <input className="input" required value={accName} onChange={(e) => setAccName(e.target.value)} />
                </div>
                <div className="field">
                  <label>Classification</label>
                  <select className="select" value={accClass} onChange={(e) => setAccClass(e.target.value)}>
                    <option>Asset</option>
                    <option>Liability</option>
                    <option>Equity</option>
                    <option>Income</option>
                    <option>Cost of Sales</option>
                    <option>Expense</option>
                    <option>Other Income</option>
                  </select>
                </div>
                <div className="field">
                  <label>Default AU Tax Code</label>
                  <select className="select" value={accTax} onChange={(e) => setAccTax(e.target.value)}>
                    {AU_TAX_CODES.map((t) => <option key={t.code} value={t.code}>{t.code} ({t.rate})</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowAccModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save Account</button>
            </div>
          </form>
        </div>
      )}

      {/* New General Journal Modal */}
      {showJournalModal && (
        <div className="modal-backdrop" onClick={() => setShowJournalModal(false)}>
          <form className="modal modal-lg" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateJournal}>
            <div className="modal-head">
              <h2>Record Double-Entry General Journal</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowJournalModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field">
                  <label>Journal Memo / Description</label>
                  <input className="input" required value={jMemo} onChange={(e) => setJMemo(e.target.value)} />
                </div>
                <div className="field">
                  <label>Entry Date</label>
                  <input className="input" type="date" value={jDate} onChange={(e) => setJDate(e.target.value)} />
                </div>
              </div>
              <div className="line-editor">
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Line Memo</th>
                      <th style={{ width: 115 }}>Debit</th>
                      <th style={{ width: 115 }}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jLines.map((l, idx) => (
                      <tr key={idx}>
                        <td>
                          <select
                            className="select"
                            value={l.account_code}
                            onChange={(e) => setJLines((p) => p.map((x, i) => (i === idx ? { ...x, account_code: e.target.value } : x)))}
                          >
                            {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                          </select>
                        </td>
                        <td>
                          <input
                            className="input"
                            value={l.line_memo}
                            onChange={(e) => setJLines((p) => p.map((x, i) => (i === idx ? { ...x, line_memo: e.target.value } : x)))}
                          />
                        </td>
                        <td>
                          <input
                            className="input num"
                            type="number"
                            step="0.01"
                            value={l.debit}
                            onChange={(e) => setJLines((p) => p.map((x, i) => (i === idx ? { ...x, debit: Number(e.target.value) } : x)))}
                          />
                        </td>
                        <td>
                          <input
                            className="input num"
                            type="number"
                            step="0.01"
                            value={l.credit}
                            onChange={(e) => setJLines((p) => p.map((x, i) => (i === idx ? { ...x, credit: Number(e.target.value) } : x)))}
                          />
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
                  onClick={() => setJLines((p) => [...p, { account_code: '1-1100', tax_code: 'N-T', debit: 0, credit: 0, line_memo: '' }])}
                >
                  + Add Line
                </button>
                <div className="spacer" />
                <span className={`badge ${jBalanced ? 'badge-success' : 'badge-danger'}`}>
                  Debits {formatAud(jDr)} · Credits {formatAud(jCr)} · {jBalanced ? 'Balanced' : 'Out of Balance'}
                </span>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowJournalModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!jBalanced}>Post Journal</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
