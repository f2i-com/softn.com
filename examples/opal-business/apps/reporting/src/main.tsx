import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../shared/ui/opal.css';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatAuDate, formatAud, formatCompactAud, formatPercent } from '../../../shared/ui/format';

interface StatementLine {
  code: string;
  name: string;
  section: string;
  amount: number;
  prior_amount: number;
  variance: number;
  variance_pct: number;
}

interface MonthlyCf {
  id: number;
  month_label: string;
  revenue: number;
  expenses: number;
  operating_cash: number;
  investing_cash: number;
  financing_cash: number;
}

interface AgedRow {
  id: number;
  side: string;
  party_name: string;
  current_amt: number;
  days_1_30: number;
  days_31_60: number;
  days_60_plus: number;
}

interface FxPosition {
  id: number;
  currency: string;
  account_label: string;
  foreign_balance: number;
  booked_rate: number;
  current_rate: number;
  booked_aud: number;
  current_aud: number;
  unrealised_gain: number;
  updated_at: string;
}

interface SavedPack {
  id: number;
  pack_name: string;
  basis: string;
  period_label: string;
  includes: string;
  created_at: string;
}

interface StatementsPayload {
  basis: string;
  pnl: {
    income: StatementLine[];
    cogs: StatementLine[];
    expenses: StatementLine[];
    totalIncome: number;
    totalCogs: number;
    grossProfit: number;
    grossMarginPct: number;
    totalExpenses: number;
    netProfit: number;
    netMarginPct: number;
    priorNetProfit: number;
  };
  balanceSheet: {
    assets: StatementLine[];
    liabilities: StatementLine[];
    equity: StatementLine[];
    currentYearEarnings: number;
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    balanced: boolean;
  };
  trialBalance: {
    rows: Array<{ code: string; name: string; section: string; debit: number; credit: number }>;
    totalDebit: number;
    totalCredit: number;
    balanced: boolean;
  };
  cashFlow: {
    monthly: MonthlyCf[];
    operating: number;
    investing: number;
    financing: number;
    netChange: number;
    openingCash: number;
    closingCash: number;
  };
  aged: {
    receivables: AgedRow[];
    payables: AgedRow[];
  };
  fx: {
    positions: FxPosition[];
    totalAudEquivalent: number;
    totalUnrealisedGain: number;
  };
  savedPacks: SavedPack[];
}

type TabKey = 'pnl' | 'balance' | 'cashflow' | 'trial' | 'aged' | 'fx';

function App() {
  const [tab, setTab] = useState<TabKey>('pnl');
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual');
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [data, setData] = useState<StatementsPayload | null>(null);
  const [fxDraft, setFxDraft] = useState<Record<string, string>>({});
  const [packName, setPackName] = useState('');
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast((prev) => (prev?.msg === msg ? null : prev)), 3200);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [rt, st] = await Promise.all([
        apiFetch<RuntimeInfo>('/api/runtime'),
        apiFetch<StatementsPayload>(`/api/statements?basis=${basis}`),
      ]);
      setRuntime(rt);
      setData(st);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [basis, notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleUpdateFx = async (pos: FxPosition) => {
    const val = Number(fxDraft[pos.currency] ?? pos.current_rate);
    try {
      await apiFetch(`/api/fx/${pos.currency}`, { method: 'PATCH', body: { current_rate: val } });
      notify(`Revalued ${pos.currency} at AUD ${val.toFixed(4)}`);
      await loadAll();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };

  const handleSavePack = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!packName.trim()) return;
    try {
      await apiFetch('/api/packs', {
        method: 'POST',
        body: { pack_name: packName, basis: basis === 'cash' ? 'Cash' : 'Accrual' },
      });
      setPackName('');
      notify(`Saved custom advisor pack "${packName}"`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const maxMonthlyVal = data
    ? Math.max(1, ...data.cashFlow.monthly.map((m) => Math.max(m.revenue, m.expenses)))
    : 1;

  return (
    <div className="opal-app">
      <header className="opal-topbar">
        <div className="opal-brand">
          <div className="opal-brand-mark" style={{ background: 'linear-gradient(135deg, #4f46e5, #0d9488)' }}>RP</div>
          <div>
            <h1>Financial Reporting &amp; Multi-Currency</h1>
            <div className="opal-brand-sub">P&amp;L · Balance Sheet · Cash Flow · Trial Balance · Aged AR/AP · Premier FX Revaluation</div>
          </div>
        </div>

        <nav className="opal-tabs">
          <button className={`opal-tab ${tab === 'pnl' ? 'active' : ''}`} onClick={() => setTab('pnl')}>Profit &amp; Loss</button>
          <button className={`opal-tab ${tab === 'balance' ? 'active' : ''}`} onClick={() => setTab('balance')}>Balance Sheet</button>
          <button className={`opal-tab ${tab === 'cashflow' ? 'active' : ''}`} onClick={() => setTab('cashflow')}>Cash Flow</button>
          <button className={`opal-tab ${tab === 'trial' ? 'active' : ''}`} onClick={() => setTab('trial')}>Trial Balance</button>
          <button className={`opal-tab ${tab === 'aged' ? 'active' : ''}`} onClick={() => setTab('aged')}>Aged AR / AP</button>
          <button className={`opal-tab ${tab === 'fx' ? 'active' : ''}`} onClick={() => setTab('fx')}>Multi-Currency FX</button>
        </nav>

        <div className="opal-actions">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP · XDB' : 'Standalone PHP'}
            </span>
          )}
          <div className="filter-pills">
            <button className={`pill-btn ${basis === 'accrual' ? 'active' : ''}`} onClick={() => setBasis('accrual')}>Accrual</button>
            <button className={`pill-btn ${basis === 'cash' ? 'active' : ''}`} onClick={() => setBasis('cash')}>Cash Basis</button>
          </div>
        </div>
      </header>

      <main className="opal-main">
        {data && (
          <>
            <section className="kpi-grid">
              <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #6100a5, #7c3aed)' } as React.CSSProperties}>
                <div className="kpi-label">YTD Total Income ({data.basis})</div>
                <div className="kpi-value">{formatAud(data.pnl.totalIncome)}</div>
                <div className="kpi-sub">Gross Margin: <strong className="text-opal">{formatPercent(data.pnl.grossMarginPct)}</strong></div>
              </div>
              <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #059669, #0d9488)' } as React.CSSProperties}>
                <div className="kpi-label">YTD Net Profit ({data.basis})</div>
                <div className="kpi-value text-success">{formatAud(data.pnl.netProfit)}</div>
                <div className="kpi-sub">Net Margin {formatPercent(data.pnl.netMarginPct)} · Prior {formatCompactAud(data.pnl.priorNetProfit)}</div>
              </div>
              <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #2563eb, #6366f1)' } as React.CSSProperties}>
                <div className="kpi-label">Net Assets / Equity</div>
                <div className="kpi-value">{formatAud(data.balanceSheet.totalEquity)}</div>
                <div className="kpi-sub">Assets {formatCompactAud(data.balanceSheet.totalAssets)} · Balanced: {data.balanceSheet.balanced ? 'Yes' : 'Check'}</div>
              </div>
              <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #d97706, #0d9488)' } as React.CSSProperties}>
                <div className="kpi-label">Foreign Currency Holdings (AUD)</div>
                <div className="kpi-value">{formatAud(data.fx.totalAudEquivalent)}</div>
                <div className="kpi-sub">
                  Unrealised FX:{' '}
                  <strong className={data.fx.totalUnrealisedGain >= 0 ? 'text-success' : 'text-danger'}>
                    {data.fx.totalUnrealisedGain >= 0 ? '+' : ''}{formatAud(data.fx.totalUnrealisedGain)}
                  </strong>
                </div>
              </div>
            </section>

            {tab === 'pnl' && (
              <div className="stack" style={{ gap: 16 }}>
                {/* Monthly Revenue vs Expense SVG Chart */}
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2 className="panel-title">FY2026-27 Monthly Revenue vs Operating Expenses</h2>
                      <div className="panel-subtitle">Live visual performance trend across July – November 2026 (AUD)</div>
                    </div>
                    <div className="row">
                      <span className="badge badge-brand">Revenue</span>
                      <span className="badge badge-opal">Expenses</span>
                    </div>
                  </div>
                  <div className="panel-body">
                    <svg viewBox="0 0 760 190" style={{ width: '100%', height: 185, display: 'block' }}>
                      {[0.25, 0.5, 0.75, 1].map((frac) => (
                        <line key={frac} x1="40" x2="740" y1={160 - frac * 135} y2={160 - frac * 135} stroke="#e4e7f0" strokeDasharray="4 4" />
                      ))}
                      {data.cashFlow.monthly.map((m, idx) => {
                        const cx = 100 + idx * 138;
                        const revH = Math.max(6, (m.revenue / maxMonthlyVal) * 135);
                        const expH = Math.max(6, (m.expenses / maxMonthlyVal) * 135);
                        return (
                          <g key={m.month_label}>
                            <rect x={cx - 34} y={160 - revH} width="30" height={revH} rx="6" fill="#6100a5" />
                            <rect x={cx + 2} y={160 - expH} width="30" height={expH} rx="6" fill="#0d9488" />
                            <text x={cx - 19} y={154 - revH} textAnchor="middle" fontSize="10" fill="#475569" fontWeight="700">
                              {formatCompactAud(m.revenue)}
                            </text>
                            <text x={cx + 17} y={154 - expH} textAnchor="middle" fontSize="10" fill="#0f766e" fontWeight="700">
                              {formatCompactAud(m.expenses)}
                            </text>
                            <text x={cx - 1} y="180" textAnchor="middle" fontSize="12" fill="#334155" fontWeight="700">
                              {m.month_label}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2 className="panel-title">Profit &amp; Loss Statement ({data.basis} Basis)</h2>
                      <div className="panel-subtitle">Harbourview Digital Pty Ltd · 1 Jul 2026 – 22 Nov 2026 vs Prior Period</div>
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Account</th>
                          <th className="right">Current YTD</th>
                          <th className="right">Prior Period</th>
                          <th className="right">Variance ($)</th>
                          <th className="right">Variance (%)</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr><td colSpan={5} className="fw-700 text-brand" style={{ background: '#faf5ff' }}>Income</td></tr>
                        {data.pnl.income.map((r) => (
                          <tr key={r.code}>
                            <td><span className="num muted">{r.code}</span> · {r.name}</td>
                            <td className="right money fw-700">{formatAud(r.amount)}</td>
                            <td className="right money muted">{formatAud(r.prior_amount)}</td>
                            <td className={`right money ${r.variance >= 0 ? 'text-success' : 'text-danger'}`}>{r.variance >= 0 ? '+' : ''}{formatAud(r.variance)}</td>
                            <td className="right num">{r.variance_pct >= 0 ? '+' : ''}{r.variance_pct}%</td>
                          </tr>
                        ))}
                        <tr><td className="fw-700">Total Income</td><td className="right money fw-700">{formatAud(data.pnl.totalIncome)}</td><td colSpan={3}></td></tr>

                        <tr><td colSpan={5} className="fw-700 text-brand" style={{ background: '#faf5ff' }}>Less Cost of Sales</td></tr>
                        {data.pnl.cogs.map((r) => (
                          <tr key={r.code}>
                            <td><span className="num muted">{r.code}</span> · {r.name}</td>
                            <td className="right money">{formatAud(r.amount)}</td>
                            <td className="right money muted">{formatAud(r.prior_amount)}</td>
                            <td className="right money">{formatAud(r.variance)}</td>
                            <td className="right num">{r.variance_pct}%</td>
                          </tr>
                        ))}
                        <tr style={{ background: '#f0fdfa' }}>
                          <td className="fw-700 text-opal">Gross Profit ({formatPercent(data.pnl.grossMarginPct)})</td>
                          <td className="right money fw-700 text-opal">{formatAud(data.pnl.grossProfit)}</td>
                          <td colSpan={3}></td>
                        </tr>

                        <tr><td colSpan={5} className="fw-700 text-brand" style={{ background: '#faf5ff' }}>Less Operating Expenses</td></tr>
                        {data.pnl.expenses.map((r) => (
                          <tr key={r.code}>
                            <td><span className="num muted">{r.code}</span> · {r.name}</td>
                            <td className="right money">{formatAud(r.amount)}</td>
                            <td className="right money muted">{formatAud(r.prior_amount)}</td>
                            <td className="right money">{formatAud(r.variance)}</td>
                            <td className="right num">{r.variance_pct}%</td>
                          </tr>
                        ))}
                        <tr style={{ background: '#f5f0ff' }}>
                          <td className="fw-700" style={{ fontSize: 15 }}>Net Operating Profit ({formatPercent(data.pnl.netMarginPct)})</td>
                          <td className="right money fw-700 text-brand" style={{ fontSize: 16 }}>{formatAud(data.pnl.netProfit)}</td>
                          <td className="right money fw-700 muted">{formatAud(data.pnl.priorNetProfit)}</td>
                          <td colSpan={2}></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {tab === 'balance' && (
              <div className="grid-2">
                <section className="panel">
                  <div className="panel-head">
                    <h2 className="panel-title">Assets</h2>
                    <span className="money fw-700 text-opal">{formatAud(data.balanceSheet.totalAssets)}</span>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        {data.balanceSheet.assets.map((a) => (
                          <tr key={a.code}>
                            <td><strong className="num muted">{a.code}</strong> · {a.name}</td>
                            <td className="right money fw-700">{formatAud(a.amount)}</td>
                          </tr>
                        ))}
                        <tr style={{ background: '#f0fdfa' }}>
                          <td className="fw-700">Total Assets</td>
                          <td className="right money fw-700 text-opal">{formatAud(data.balanceSheet.totalAssets)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <h2 className="panel-title">Liabilities &amp; Equity</h2>
                    <span className="badge badge-success">Balanced</span>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        {data.balanceSheet.liabilities.map((l) => (
                          <tr key={l.code}>
                            <td><strong className="num muted">{l.code}</strong> · {l.name}</td>
                            <td className="right money">{formatAud(l.amount)}</td>
                          </tr>
                        ))}
                        <tr style={{ background: '#faf5ff' }}>
                          <td className="fw-700">Total Liabilities</td>
                          <td className="right money fw-700">{formatAud(data.balanceSheet.totalLiabilities)}</td>
                        </tr>
                        {data.balanceSheet.equity.map((eq) => (
                          <tr key={eq.code}>
                            <td><strong className="num muted">{eq.code}</strong> · {eq.name}</td>
                            <td className="right money">{formatAud(eq.amount)}</td>
                          </tr>
                        ))}
                        <tr>
                          <td><strong>3-9000</strong> · Current Year Earnings ({data.basis})</td>
                          <td className="right money fw-700 text-success">{formatAud(data.balanceSheet.currentYearEarnings)}</td>
                        </tr>
                        <tr style={{ background: '#f0fdfa' }}>
                          <td className="fw-700">Total Liabilities &amp; Equity</td>
                          <td className="right money fw-700 text-brand">
                            {formatAud(data.balanceSheet.totalLiabilities + data.balanceSheet.totalEquity)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {tab === 'cashflow' && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2 className="panel-title">Statement of Cash Flows (Operating · Investing · Financing)</h2>
                    <div className="panel-subtitle">Opening cash bridge to current CommBank + NAB treasury balances.</div>
                  </div>
                </div>
                <div className="panel-body stack">
                  <div className="grid-3">
                    <div className="callout callout-success"><div><strong>Operating Activities</strong><div className="money fw-700" style={{ fontSize: 19 }}>{formatAud(data.cashFlow.operating)}</div></div></div>
                    <div className="callout callout-warning"><div><strong>Investing Activities</strong><div className="money fw-700" style={{ fontSize: 19 }}>{formatAud(data.cashFlow.investing)}</div></div></div>
                    <div className="callout"><div><strong>Financing Activities</strong><div className="money fw-700" style={{ fontSize: 19 }}>{formatAud(data.cashFlow.financing)}</div></div></div>
                  </div>
                  <div className="callout callout-brand">
                    <div>Opening Cash (1 Jul 2026): <strong className="money">{formatAud(data.cashFlow.openingCash)}</strong> · Net Cash Movement: <strong className="money text-success">+{formatAud(data.cashFlow.netChange)}</strong></div>
                    <div className="money fw-700 text-brand" style={{ fontSize: 19 }}>Closing Cash: {formatAud(data.cashFlow.closingCash)}</div>
                  </div>
                </div>
              </section>
            )}

            {tab === 'trial' && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2 className="panel-title">General Ledger Trial Balance</h2>
                    <div className="panel-subtitle">End-of-period audit verification confirming Total Debits equal Total Credits.</div>
                  </div>
                  <span className={`badge ${data.trialBalance.balanced ? 'badge-success' : 'badge-danger'}`}>
                    {data.trialBalance.balanced ? 'Debits = Credits (Balanced)' : 'Check Variance'}
                  </span>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Code</th><th>Account Name</th><th>Section</th><th className="right">Debit</th><th className="right">Credit</th></tr>
                    </thead>
                    <tbody>
                      {data.trialBalance.rows.map((r) => (
                        <tr key={r.code}>
                          <td className="num fw-700 text-brand">{r.code}</td>
                          <td>{r.name}</td>
                          <td><span className="badge badge-neutral">{r.section}</span></td>
                          <td className="right money">{r.debit > 0 ? formatAud(r.debit) : '—'}</td>
                          <td className="right money">{r.credit > 0 ? formatAud(r.credit) : '—'}</td>
                        </tr>
                      ))}
                      <tr style={{ background: '#f5f0ff' }}>
                        <td colSpan={3} className="fw-700">Trial Balance Totals</td>
                        <td className="right money fw-700 text-brand">{formatAud(data.trialBalance.totalDebit)}</td>
                        <td className="right money fw-700 text-brand">{formatAud(data.trialBalance.totalCredit)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {tab === 'aged' && (
              <div className="grid-2">
                <section className="panel">
                  <div className="panel-head"><h2 className="panel-title">Aged Receivables Summary (Debtors)</h2></div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>Customer</th><th className="right">Current</th><th className="right">1–30d</th><th className="right">31–60d</th><th className="right">60+d</th></tr></thead>
                      <tbody>
                        {data.aged.receivables.map((r) => (
                          <tr key={r.id}>
                            <td className="fw-700">{r.party_name}</td>
                            <td className="right money">{formatAud(r.current_amt)}</td>
                            <td className={`right money ${r.days_1_30 > 0 ? 'text-danger fw-700' : ''}`}>{formatAud(r.days_1_30)}</td>
                            <td className="right money">{formatAud(r.days_31_60)}</td>
                            <td className="right money">{formatAud(r.days_60_plus)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head"><h2 className="panel-title">Aged Payables Summary (Creditors)</h2></div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>Supplier</th><th className="right">Current</th><th className="right">1–30d</th><th className="right">31–60d</th><th className="right">60+d</th></tr></thead>
                      <tbody>
                        {data.aged.payables.map((r) => (
                          <tr key={r.id}>
                            <td className="fw-700">{r.party_name}</td>
                            <td className="right money">{formatAud(r.current_amt)}</td>
                            <td className={`right money ${r.days_1_30 > 0 ? 'text-danger fw-700' : ''}`}>{formatAud(r.days_1_30)}</td>
                            <td className="right money">{formatAud(r.days_31_60)}</td>
                            <td className="right money">{formatAud(r.days_60_plus)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {tab === 'fx' && (
              <div className="stack" style={{ gap: 16 }}>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2 className="panel-title">Multi-Currency Exchange Rates &amp; Unrealised FX Gain/Loss</h2>
                      <div className="panel-subtitle">MYOB AccountRight Premier parity — edit spot rates against AUD to run live FX revaluation.</div>
                    </div>
                    <span className="badge badge-brand">Base Currency: AUD</span>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Currency &amp; Account</th>
                          <th className="right">Foreign Balance</th>
                          <th className="right">Booked Rate</th>
                          <th className="right">Spot Rate (AUD)</th>
                          <th className="right">AUD Value</th>
                          <th className="right">Unrealised FX</th>
                          <th className="right">Revalue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.fx.positions.map((pos) => (
                          <tr key={pos.currency}>
                            <td>
                              <span className="badge badge-opal">{pos.currency}</span>{' '}
                              <strong>{pos.account_label}</strong>
                            </td>
                            <td className="right money fw-700">{pos.currency} {pos.foreign_balance.toFixed(2)}</td>
                            <td className="right num muted">{pos.booked_rate.toFixed(4)}</td>
                            <td className="right">
                              <input
                                className="input num"
                                style={{ width: 95, padding: '4px 8px', textAlign: 'right' }}
                                type="number"
                                step="0.001"
                                value={fxDraft[pos.currency] ?? String(pos.current_rate)}
                                onChange={(e) => setFxDraft((p) => ({ ...p, [pos.currency]: e.target.value }))}
                              />
                            </td>
                            <td className="right money fw-700">{formatAud(pos.current_aud)}</td>
                            <td className={`right money fw-700 ${pos.unrealised_gain >= 0 ? 'text-success' : 'text-danger'}`}>
                              {pos.unrealised_gain >= 0 ? '+' : ''}{formatAud(pos.unrealised_gain)}
                            </td>
                            <td className="right">
                              <button className="btn btn-primary btn-xs" onClick={() => void handleUpdateFx(pos)}>Update Rate</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2 className="panel-title">Saved Custom Advisor Report Packs</h2>
                      <div className="panel-subtitle">Share consistent report templates with your accountant or board.</div>
                    </div>
                    <form className="row" onSubmit={handleSavePack}>
                      <input className="input input-sm" placeholder="New report pack name..." value={packName} onChange={(e) => setPackName(e.target.value)} />
                      <button type="submit" className="btn btn-primary btn-sm">Save Pack</button>
                    </form>
                  </div>
                  <div className="panel-body stack">
                    {data.savedPacks.map((pk) => (
                      <div key={pk.id} className="callout">
                        <div>
                          <div className="fw-700">{pk.pack_name}</div>
                          <div className="row-sub">{pk.includes}</div>
                        </div>
                        <div className="row">
                          <span className="badge badge-brand">{pk.basis}</span>
                          <span className="muted">{formatAuDate(pk.created_at)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </>
        )}
      </main>

      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
