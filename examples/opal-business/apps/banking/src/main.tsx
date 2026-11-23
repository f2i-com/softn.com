import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../shared/ui/opal.css';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatAuDate, formatAud } from '../../../shared/ui/format';

interface BankingOverview {
  totalCash: number;
  creditCardBalance: number;
  netPosition: number;
  unallocatedCount: number;
  unreconciledCount: number;
  activeRules: number;
  accountCount: number;
}

interface BankAccount {
  id: number;
  name: string;
  institution: string;
  account_type: string;
  bsb: string;
  account_number: string;
  feed_status: string;
  last_synced: string;
  balance: number;
  statement_balance: number;
  unallocated: number;
}

interface BankTx {
  id: number;
  account_id: number;
  tx_date: string;
  bank_ref: string;
  description: string;
  counterparty: string;
  amount: number;
  category: string;
  tax_code: string;
  allocated: number;
  reconciled: number;
  matched_rule: string;
  suggested_match: string;
}

interface BankRule {
  id: number;
  rule_name: string;
  match_text: string;
  direction: string;
  category: string;
  tax_code: string;
  contact_name: string;
  times_applied: number;
  active: number;
}

interface Reconciliation {
  id: number;
  account_id: number;
  account_name: string;
  statement_date: string;
  statement_balance: number;
  cleared_count: number;
  reconciled_at: string;
}

const AU_CATEGORIES = [
  '4-1100 Sales Revenue',
  '4-1200 Consulting Services',
  '6-1100 Bank Charges',
  '6-1200 Cloud & Software',
  '6-1400 Office Supplies',
  '6-1600 Telephone & Internet',
  '6-1800 Rent & Outgoings',
  '6-2100 Repairs & Fitout',
  '6-2400 Travel & Accommodation',
  '2-1400 GST & PAYG Clearing',
  '8-1100 Interest Income',
];

type TabKey = 'feeds' | 'rules' | 'reconcile';

function App() {
  const [tab, setTab] = useState<TabKey>('feeds');
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [overview, setOverview] = useState<BankingOverview | null>(null);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedAcc, setSelectedAcc] = useState<number>(0);
  const [txs, setTxs] = useState<BankTx[]>([]);
  const [rules, setRules] = useState<BankRule[]>([]);
  const [recons, setRecons] = useState<Reconciliation[]>([]);
  const [allocDraft, setAllocDraft] = useState<Record<number, { category: string; taxCode: string }>>({});
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  // Money Modal
  const [moneyModal, setMoneyModal] = useState<'spend' | 'receive' | 'transfer' | null>(null);
  const [mAcc, setMAcc] = useState(1);
  const [mToAcc, setMToAcc] = useState(2);
  const [mAmount, setMAmount] = useState('500.00');
  const [mDesc, setMDesc] = useState('');
  const [mParty, setMParty] = useState('');
  const [mCategory, setMCategory] = useState('6-1400 Office Supplies');
  const [mTaxCode, setMTaxCode] = useState('GST');

  // Rule Modal
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [rName, setRName] = useState('');
  const [rMatch, setRMatch] = useState('');
  const [rDir, setRDir] = useState('spend');
  const [rCat, setRCat] = useState('6-2100 Repairs & Fitout');
  const [rTax, setRTax] = useState('GST');

  // Reconciliation Workbench
  const [recAccId, setRecAccId] = useState(1);
  const [recDate, setRecDate] = useState('2026-11-22');
  const [checkedIds, setCheckedIds] = useState<number[]>([]);

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast((prev) => (prev?.msg === msg ? null : prev)), 3200);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [rt, ov, ac, tx, rl, rc] = await Promise.all([
        apiFetch<RuntimeInfo>('/api/runtime'),
        apiFetch<BankingOverview>('/api/overview'),
        apiFetch<{ accounts: BankAccount[] }>('/api/accounts'),
        apiFetch<{ transactions: BankTx[] }>('/api/transactions'),
        apiFetch<{ rules: BankRule[] }>('/api/rules'),
        apiFetch<{ reconciliations: Reconciliation[] }>('/api/reconciliations'),
      ]);
      setRuntime(rt);
      setOverview(ov);
      setAccounts(ac.accounts);
      setTxs(tx.transactions);
      setRules(rl.rules);
      setRecons(rc.reconciliations);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleSyncFeed = async () => {
    try {
      const res = await apiFetch<{ transaction: BankTx }>('/api/feeds/sync', { method: 'POST', body: {} });
      notify(`Bank feed imported: ${res.transaction.description}`);
      await loadAll();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };

  const handleRunRules = async () => {
    try {
      const res = await apiFetch<{ appliedCount: number }>('/api/rules/apply', { method: 'POST', body: {} });
      notify(
        res.appliedCount > 0
          ? `Bank Rules auto-allocated ${res.appliedCount} transaction(s)!`
          : 'No unallocated feed transactions matched active rules.'
      );
      await loadAll();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };

  const handleAllocate = async (tx: BankTx, forcedCategory?: string, forcedLabel?: string) => {
    const draft = allocDraft[tx.id];
    const category = forcedCategory || draft?.category || (tx.amount >= 0 ? '4-1100 Sales Revenue' : '6-1400 Office Supplies');
    const taxCode = draft?.taxCode || tx.tax_code || 'GST';
    try {
      await apiFetch(`/api/transactions/${tx.id}/allocate`, {
        method: 'POST',
        body: { category, tax_code: taxCode, label: forcedLabel || 'Allocated' },
      });
      notify(`Allocated ${tx.bank_ref} -> ${category}`);
      await loadAll();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };

  const handleMoneySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!moneyModal) return;
    try {
      await apiFetch('/api/money', {
        method: 'POST',
        body: {
          kind: moneyModal,
          account_id: mAcc,
          to_account_id: mToAcc,
          amount: Number(mAmount),
          description: mDesc,
          counterparty: mParty,
          category: mCategory,
          tax_code: mTaxCode,
        },
      });
      setMoneyModal(null);
      notify(moneyModal === 'transfer' ? 'Inter-account transfer completed' : `Recorded ${moneyModal} money transaction`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/rules', {
        method: 'POST',
        body: { rule_name: rName, match_text: rMatch, direction: rDir, category: rCat, tax_code: rTax },
      });
      setShowRuleModal(false);
      setRName('');
      setRMatch('');
      notify(`Created Bank Rule "${rName}"`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const recAcc = accounts.find((a) => a.id === recAccId) || accounts[0];
  const recTxs = txs.filter((t) => t.account_id === (recAcc?.id ?? 1) && t.reconciled === 0);
  const selectedClearedSum = recTxs
    .filter((t) => checkedIds.includes(t.id))
    .reduce((acc, t) => acc + Number(t.amount), 0);
  const unclearedRemainingSum = recTxs
    .filter((t) => !checkedIds.includes(t.id))
    .reduce((acc, t) => acc + Number(t.amount), 0);
  const targetStatement = recAcc ? recAcc.statement_balance : 0;
  const calculatedClearedBalance = recAcc ? Number((recAcc.balance - unclearedRemainingSum).toFixed(2)) : 0;
  const outOfBalance = Number((targetStatement - calculatedClearedBalance).toFixed(2));

  const handleCompleteReconcile = async () => {
    if (!recAcc || checkedIds.length === 0) {
      notify('Tick at least one cleared transaction to reconcile.', true);
      return;
    }
    try {
      await apiFetch('/api/reconcile', {
        method: 'POST',
        body: {
          account_id: recAcc.id,
          statement_date: recDate,
          statement_balance: calculatedClearedBalance,
          transaction_ids: checkedIds,
        },
      });
      setCheckedIds([]);
      notify(`Reconciled ${checkedIds.length} transaction(s) for ${recAcc.name}`);
      await loadAll();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };

  const visibleTxs = selectedAcc === 0 ? txs : txs.filter((t) => t.account_id === selectedAcc);
  const accNameOf = (id: number) => accounts.find((a) => a.id === id)?.name ?? 'Bank';

  return (
    <div className="opal-app">
      <header className="opal-topbar">
        <div className="opal-brand">
          <div className="opal-brand-mark" style={{ background: 'linear-gradient(135deg, #0d9488, #0284c7)' }}>BK</div>
          <div>
            <h1>Banking, Feeds &amp; Reconciliation</h1>
            <div className="opal-brand-sub">Unlimited AU Bank Feeds · Smart Matching · Bank Rules · Statement Reconciliation</div>
          </div>
        </div>

        <nav className="opal-tabs">
          <button className={`opal-tab ${tab === 'feeds' ? 'active' : ''}`} onClick={() => setTab('feeds')}>
            Bank Transactions <span className="opal-tab-count">{txs.filter((t) => t.allocated === 0).length}</span>
          </button>
          <button className={`opal-tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>
            Bank Rules <span className="opal-tab-count">{rules.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'reconcile' ? 'active' : ''}`} onClick={() => setTab('reconcile')}>
            Reconcile Accounts <span className="opal-tab-count">{txs.filter((t) => t.reconciled === 0).length}</span>
          </button>
        </nav>

        <div className="opal-actions">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP · XDB' : 'Standalone PHP'}
            </span>
          )}
          <button className="btn btn-sm" onClick={() => { setMoneyModal('spend'); setMDesc(''); setMParty(''); }}>Spend / Receive</button>
          <button className="btn btn-soft btn-sm" onClick={() => setMoneyModal('transfer')}>Transfer Funds</button>
          <button className="btn btn-opal btn-sm" onClick={() => void handleSyncFeed()}>Sync Bank Feed</button>
        </div>
      </header>

      <main className="opal-main">
        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #0d9488, #10b981)' } as React.CSSProperties}>
              <div className="kpi-label">Total Cash Across Banks</div>
              <div className="kpi-value text-opal">{formatAud(overview.totalCash)}</div>
              <div className="kpi-sub">{overview.accountCount} unlimited live AU feeds connected</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #6100a5, #7c3aed)' } as React.CSSProperties}>
              <div className="kpi-label">Net Cash Position</div>
              <div className="kpi-value">{formatAud(overview.netPosition)}</div>
              <div className="kpi-sub">Credit cards: {formatAud(overview.creditCardBalance)}</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #d97706, #f59e0b)' } as React.CSSProperties}>
              <div className="kpi-label">Unallocated Feed Lines</div>
              <div className="kpi-value">{overview.unallocatedCount}</div>
              <div className="kpi-sub">{overview.activeRules} active Bank Rules ready to apply</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #2563eb, #6366f1)' } as React.CSSProperties}>
              <div className="kpi-label">Awaiting Reconciliation</div>
              <div className="kpi-value">{overview.unreconciledCount}</div>
              <div className="kpi-sub">Reconcile before preparing quarterly BAS</div>
            </div>
          </section>
        )}

        {/* Connected Bank Accounts Strip */}
        <section className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          {accounts.map((acc) => (
            <div
              key={acc.id}
              className="panel"
              style={{
                cursor: 'pointer',
                borderColor: selectedAcc === acc.id ? 'var(--brand)' : undefined,
                boxShadow: selectedAcc === acc.id ? '0 0 0 2px rgba(97,0,165,0.16)' : undefined,
              }}
              onClick={() => setSelectedAcc((prev) => (prev === acc.id ? 0 : acc.id))}
            >
              <div className="panel-body">
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span className="badge badge-opal">{acc.account_type}</span>
                  <span className="badge badge-success">{acc.feed_status}</span>
                </div>
                <div className="fw-700" style={{ fontSize: 14.5 }}>{acc.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>BSB {acc.bsb} · {acc.account_number}</div>
                <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
                  <div className={`money fw-700 ${acc.balance < 0 ? 'text-danger' : ''}`} style={{ fontSize: 19 }}>
                    {formatAud(acc.balance)}
                  </div>
                  {acc.unallocated > 0 ? (
                    <span className="badge badge-warning">{acc.unallocated} to code</span>
                  ) : (
                    <span className="badge badge-success">All coded</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </section>

        {tab === 'feeds' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">
                  Bank Feed Transactions {selectedAcc > 0 ? `· ${accNameOf(selectedAcc)}` : '· All Connected Accounts'}
                </h2>
                <div className="panel-subtitle">Match deposits to open Tax Invoices, run Bank Rules, or allocate directly to your Chart of Accounts.</div>
              </div>
              <div className="row">
                {selectedAcc > 0 && (
                  <button className="btn btn-sm" onClick={() => setSelectedAcc(0)}>Show All Accounts</button>
                )}
                <button className="btn btn-primary btn-sm" onClick={() => void handleRunRules()}>
                  Run Bank Rules ({rules.length})
                </button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date &amp; Account</th>
                    <th>Bank Description</th>
                    <th className="right">Withdrawal</th>
                    <th className="right">Deposit</th>
                    <th>Allocate / Match</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTxs.map((tx) => {
                    const draft = allocDraft[tx.id] ?? {
                      category: tx.category || (tx.amount >= 0 ? '4-1100 Sales Revenue' : '6-1400 Office Supplies'),
                      taxCode: tx.tax_code || 'GST',
                    };
                    return (
                      <tr key={tx.id}>
                        <td>
                          <div className="fw-700">{formatAuDate(tx.tx_date)}</div>
                          <div className="row-sub">{accNameOf(tx.account_id)}</div>
                        </td>
                        <td>
                          <div className="fw-700">{tx.description}</div>
                          <div className="row-sub">{tx.bank_ref} {tx.counterparty ? `· ${tx.counterparty}` : ''}</div>
                          {tx.allocated === 0 && tx.suggested_match && (
                            <div style={{ marginTop: 4 }}>
                              <span className="badge badge-brand">Smart Match: {tx.suggested_match}</span>
                            </div>
                          )}
                        </td>
                        <td className="right money fw-700 text-danger">
                          {tx.amount < 0 ? formatAud(Math.abs(tx.amount)) : '—'}
                        </td>
                        <td className="right money fw-700 text-success">
                          {tx.amount > 0 ? formatAud(tx.amount) : '—'}
                        </td>
                        <td>
                          {tx.allocated === 1 ? (
                            <div>
                              <div className="fw-700">{tx.category}</div>
                              <div className="row-sub">Tax: {tx.tax_code} · {tx.matched_rule}</div>
                            </div>
                          ) : (
                            <div className="row" style={{ gap: 6 }}>
                              {tx.suggested_match ? (
                                <button
                                  className="btn btn-opal btn-xs"
                                  onClick={() => void handleAllocate(tx, '4-1100 Sales Revenue', tx.suggested_match)}
                                >
                                  Accept Match
                                </button>
                              ) : (
                                <>
                                  <select
                                    className="select"
                                    style={{ width: 195, padding: '4px 8px', fontSize: 12 }}
                                    value={draft.category}
                                    onChange={(e) =>
                                      setAllocDraft((p) => ({ ...p, [tx.id]: { ...draft, category: e.target.value } }))
                                    }
                                  >
                                    {AU_CATEGORIES.map((c) => (
                                      <option key={c} value={c}>{c}</option>
                                    ))}
                                  </select>
                                  <select
                                    className="select"
                                    style={{ width: 72, padding: '4px 6px', fontSize: 12 }}
                                    value={draft.taxCode}
                                    onChange={(e) =>
                                      setAllocDraft((p) => ({ ...p, [tx.id]: { ...draft, taxCode: e.target.value } }))
                                    }
                                  >
                                    <option value="GST">GST</option>
                                    <option value="FRE">FRE</option>
                                    <option value="CAP">CAP</option>
                                    <option value="N-T">N-T</option>
                                  </select>
                                  <button className="btn btn-primary btn-xs" onClick={() => void handleAllocate(tx)}>
                                    Allocate
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </td>
                        <td>
                          {tx.reconciled === 1 ? (
                            <span className="badge badge-success">Reconciled</span>
                          ) : tx.allocated === 1 ? (
                            <span className="badge badge-opal">Allocated</span>
                          ) : (
                            <span className="badge badge-warning">Needs Coding</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'rules' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Automated Bank Rules</h2>
                <div className="panel-subtitle">Automatically categorize recurring bank feed transactions and assign Australian GST codes.</div>
              </div>
              <div className="row">
                <button className="btn btn-opal btn-sm" onClick={() => void handleRunRules()}>Run Rules Now</button>
                <button className="btn btn-primary btn-sm" onClick={() => setShowRuleModal(true)}>+ New Bank Rule</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Rule Name</th>
                    <th>Condition (Description Contains)</th>
                    <th>Direction</th>
                    <th>Assign Category</th>
                    <th>Tax Code</th>
                    <th className="right">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <td className="fw-700">{r.rule_name}</td>
                      <td><span className="badge badge-brand">"{r.match_text}"</span></td>
                      <td><span className={`badge ${r.direction === 'receive' ? 'badge-success' : 'badge-neutral'}`}>{r.direction}</span></td>
                      <td className="fw-700">{r.category}</td>
                      <td><span className="badge badge-opal">{r.tax_code}</span></td>
                      <td className="right num fw-700">{r.times_applied}×</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'reconcile' && (
          <div className="split-main">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2 className="panel-title">Bank Reconciliation Workbench</h2>
                  <div className="panel-subtitle">Tick transactions matching your bank statement until Out of Balance equals $0.00.</div>
                </div>
                <div className="row">
                  <select className="select" style={{ width: 220 }} value={recAccId} onChange={(e) => { setRecAccId(Number(e.target.value)); setCheckedIds([]); }}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <input className="input" style={{ width: 145 }} type="date" value={recDate} onChange={(e) => setRecDate(e.target.value)} />
                </div>
              </div>
              <div className="panel-body" style={{ paddingBottom: 0 }}>
                <div className="callout callout-brand">
                  <div>
                    <div className="fw-700">Bank Statement Balance: <span className="money">{formatAud(targetStatement)}</span></div>
                    <div>Calculated Cleared Balance: <strong className="money">{formatAud(calculatedClearedBalance)}</strong> · Selected Delta: <strong className="money">{formatAud(selectedClearedSum)}</strong></div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className={`badge ${Math.abs(outOfBalance) < 0.01 ? 'badge-success' : 'badge-warning'}`}>
                      Out of Balance: {formatAud(outOfBalance)}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => void handleCompleteReconcile()}>
                        Reconcile Selected ({checkedIds.length})
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 42 }}>Clear</th>
                      <th>Date</th>
                      <th>Description</th>
                      <th>Category</th>
                      <th className="right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recTxs.map((t) => {
                      const checked = checkedIds.includes(t.id);
                      return (
                        <tr key={t.id}>
                          <td className="center">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setCheckedIds((prev) => (checked ? prev.filter((x) => x !== t.id) : [...prev, t.id]))
                              }
                            />
                          </td>
                          <td>{formatAuDate(t.tx_date)}</td>
                          <td>
                            <div className="fw-700">{t.description}</div>
                            <div className="row-sub">{t.bank_ref}</div>
                          </td>
                          <td>{t.category || <span className="muted">Unallocated</span>}</td>
                          <td className={`right money fw-700 ${t.amount >= 0 ? 'text-success' : 'text-danger'}`}>
                            {formatAud(t.amount)}
                          </td>
                        </tr>
                      );
                    })}
                    {recTxs.length === 0 && (
                      <tr><td colSpan={5}><div className="empty-state"><h3>Fully Reconciled!</h3><div>All transactions for this bank account are reconciled.</div></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">Reconciliation History</h2>
              </div>
              <div className="panel-body stack">
                {recons.map((rc) => (
                  <div key={rc.id} className="callout">
                    <div>
                      <div className="fw-700">{rc.account_name}</div>
                      <div className="row-sub">Statement {formatAuDate(rc.statement_date)} · {rc.cleared_count} cleared</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="money fw-700">{formatAud(rc.statement_balance)}</div>
                      <span className="badge badge-success">Balanced</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Spend / Receive / Transfer Modal */}
      {moneyModal && (
        <div className="modal-backdrop" onClick={() => setMoneyModal(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleMoneySubmit}>
            <div className="modal-head">
              <h2>{moneyModal === 'transfer' ? 'Transfer Funds Between Bank Accounts' : 'Record Spend / Receive Money'}</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMoneyModal(null)}>Close</button>
            </div>
            <div className="modal-body">
              {moneyModal !== 'transfer' && (
                <div className="filter-pills">
                  <button type="button" className={`pill-btn ${moneyModal === 'spend' ? 'active' : ''}`} onClick={() => setMoneyModal('spend')}>Spend Money</button>
                  <button type="button" className={`pill-btn ${moneyModal === 'receive' ? 'active' : ''}`} onClick={() => setMoneyModal('receive')}>Receive Money</button>
                </div>
              )}
              <div className="form-grid">
                <div className="field">
                  <label>{moneyModal === 'transfer' ? 'From Account' : 'Bank Account'}</label>
                  <select className="select" value={mAcc} onChange={(e) => setMAcc(Number(e.target.value))}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatAud(a.balance)})</option>)}
                  </select>
                </div>
                {moneyModal === 'transfer' ? (
                  <div className="field">
                    <label>To Account</label>
                    <select className="select" value={mToAcc} onChange={(e) => setMToAcc(Number(e.target.value))}>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatAud(a.balance)})</option>)}
                    </select>
                  </div>
                ) : (
                  <div className="field">
                    <label>Counterparty / Contact</label>
                    <input className="input" value={mParty} onChange={(e) => setMParty(e.target.value)} placeholder="e.g. Bunnings Trade" />
                  </div>
                )}
                <div className="field">
                  <label>Amount (AUD)</label>
                  <input className="input num" type="number" step="0.01" required value={mAmount} onChange={(e) => setMAmount(e.target.value)} />
                </div>
                {moneyModal !== 'transfer' && (
                  <div className="field">
                    <label>Category</label>
                    <select className="select" value={mCategory} onChange={(e) => setMCategory(e.target.value)}>
                      {AU_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                )}
              </div>
              {moneyModal !== 'transfer' && (
                <div className="form-grid">
                  <div className="field">
                    <label>Description</label>
                    <input className="input" required value={mDesc} onChange={(e) => setMDesc(e.target.value)} placeholder="Payment memo" />
                  </div>
                  <div className="field">
                    <label>Tax Code</label>
                    <select className="select" value={mTaxCode} onChange={(e) => setMTaxCode(e.target.value)}>
                      <option value="GST">GST (10%)</option>
                      <option value="FRE">FRE (0%)</option>
                      <option value="CAP">CAP (10%)</option>
                      <option value="N-T">N-T (0%)</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setMoneyModal(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Record Transaction</button>
            </div>
          </form>
        </div>
      )}

      {/* New Bank Rule Modal */}
      {showRuleModal && (
        <div className="modal-backdrop" onClick={() => setShowRuleModal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateRule}>
            <div className="modal-head">
              <h2>Create Automated Bank Rule</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowRuleModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field">
                  <label>Rule Name</label>
                  <input className="input" required value={rName} onChange={(e) => setRName(e.target.value)} placeholder="e.g. Bunnings Hardware Auto" />
                </div>
                <div className="field">
                  <label>When Description Contains</label>
                  <input className="input" required value={rMatch} onChange={(e) => setRMatch(e.target.value)} placeholder="e.g. BUNNINGS" />
                </div>
                <div className="field">
                  <label>Direction</label>
                  <select className="select" value={rDir} onChange={(e) => setRDir(e.target.value)}>
                    <option value="spend">Money Out (Spend)</option>
                    <option value="receive">Money In (Receive)</option>
                  </select>
                </div>
                <div className="field">
                  <label>Allocate to Category</label>
                  <select className="select" value={rCat} onChange={(e) => setRCat(e.target.value)}>
                    {AU_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>AU Tax Code</label>
                  <select className="select" value={rTax} onChange={(e) => setRTax(e.target.value)}>
                    <option value="GST">GST (10%)</option>
                    <option value="FRE">FRE (0%)</option>
                    <option value="CAP">CAP (10%)</option>
                    <option value="N-T">N-T (0%)</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowRuleModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save Bank Rule</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
