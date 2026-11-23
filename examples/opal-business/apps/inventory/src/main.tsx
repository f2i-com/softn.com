import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../shared/ui/opal.css';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatAuDate, formatAud, formatPercent } from '../../../shared/ui/format';

interface InventoryOverview {
  inventoryValuation: number;
  unitsOnHand: number;
  lowStockCount: number;
  activeJobs: number;
  unbilledAmount: number;
  unbilledHours: number;
  jobGrossProfit: number;
}

interface Item {
  id: number;
  sku: string;
  name: string;
  item_type: string;
  location: string;
  buy_price: number;
  retail_price: number;
  trade_price: number;
  wholesale_price: number;
  tax_code: string;
  qty_on_hand: number;
  qty_committed: number;
  reorder_level: number;
  available: number;
  low_stock: boolean;
  stock_value: number;
}

interface StockAdj {
  id: number;
  sku: string;
  item_name: string;
  adj_date: string;
  reason: string;
  location: string;
  qty_delta: number;
  unit_cost: number;
  memo: string;
}

interface Job {
  id: number;
  job_code: string;
  parent_code: string;
  job_name: string;
  customer_name: string;
  status: string;
  budget_income: number;
  actual_income: number;
  budget_cost: number;
  actual_cost: number;
  gross_profit: number;
  margin_pct: number;
}

interface TimeSlip {
  id: number;
  slip_date: string;
  staff_name: string;
  customer_name: string;
  job_code: string;
  activity: string;
  hours: number;
  hourly_rate: number;
  amount: number;
  status: string;
}

type TabKey = 'items' | 'jobs' | 'timebilling' | 'adjustments';

function App() {
  const [tab, setTab] = useState<TabKey>('items');
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [overview, setOverview] = useState<InventoryOverview | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [adjs, setAdjs] = useState<StockAdj[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [slips, setSlips] = useState<TimeSlip[]>([]);
  const [priceTier, setPriceTier] = useState<'retail' | 'trade' | 'wholesale'>('retail');
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  // Modals
  const [adjItem, setAdjItem] = useState<Item | null>(null);
  const [adjDelta, setAdjDelta] = useState('10');
  const [adjReason, setAdjReason] = useState('Supplier Restock');
  const [adjMemo, setAdjMemo] = useState('');

  const [showItemModal, setShowItemModal] = useState(false);
  const [itSku, setItSku] = useState('');
  const [itName, setItName] = useState('');
  const [itLoc, setItLoc] = useState('Sydney HQ');
  const [itBuy, setItBuy] = useState('120');
  const [itRetail, setItRetail] = useState('299');
  const [itQty, setItQty] = useState('15');

  const [showSlipModal, setShowSlipModal] = useState(false);
  const [slStaff, setSlStaff] = useState('Liam O\'Connor');
  const [slJob, setSlJob] = useState('JOB-101');
  const [slAct, setSlAct] = useState('Cloud Architecture & Implementation');
  const [slHrs, setSlHrs] = useState('3.5');
  const [slRate, setSlRate] = useState('220');

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast((prev) => (prev?.msg === msg ? null : prev)), 3200);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [rt, ov, it, ad, jb, sl] = await Promise.all([
        apiFetch<RuntimeInfo>('/api/runtime'),
        apiFetch<InventoryOverview>('/api/overview'),
        apiFetch<{ items: Item[] }>('/api/items'),
        apiFetch<{ adjustments: StockAdj[] }>('/api/adjustments'),
        apiFetch<{ jobs: Job[] }>('/api/jobs'),
        apiFetch<{ timeSlips: TimeSlip[] }>('/api/time-slips'),
      ]);
      setRuntime(rt);
      setOverview(ov);
      setItems(it.items);
      setAdjs(ad.adjustments);
      setJobs(jb.jobs);
      setSlips(sl.timeSlips);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleCreateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/items', {
        method: 'POST',
        body: {
          sku: itSku,
          name: itName,
          location: itLoc,
          buy_price: Number(itBuy),
          retail_price: Number(itRetail),
          qty_on_hand: Number(itQty),
        },
      });
      setShowItemModal(false);
      setItSku('');
      setItName('');
      notify(`Added inventory item ${itSku}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleAdjustStock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjItem) return;
    try {
      await apiFetch(`/api/items/${adjItem.id}/adjust`, {
        method: 'POST',
        body: { qty_delta: Number(adjDelta), reason: adjReason, memo: adjMemo },
      });
      notify(`Adjusted ${adjItem.sku} by ${Number(adjDelta) > 0 ? '+' : ''}${adjDelta} units`);
      setAdjItem(null);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleCreateSlip = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/time-slips', {
        method: 'POST',
        body: {
          staff_name: slStaff,
          job_code: slJob,
          activity: slAct,
          hours: Number(slHrs),
          hourly_rate: Number(slRate),
        },
      });
      setShowSlipModal(false);
      notify(`Logged ${slHrs} billable hrs to ${slJob}`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleBillSlip = async (sl: TimeSlip) => {
    try {
      await apiFetch(`/api/time-slips/${sl.id}/bill`, { method: 'POST', body: {} });
      notify(`Billed ${formatAud(sl.amount)} to ${sl.job_code} (${sl.customer_name})`);
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  return (
    <div className="opal-app">
      <header className="opal-topbar">
        <div className="opal-brand">
          <div className="opal-brand-mark" style={{ background: 'linear-gradient(135deg, #d97706, #ea580c)' }}>IJ</div>
          <div>
            <h1>Inventory, Jobs &amp; Time Billing</h1>
            <div className="opal-brand-sub">Multi-Location Stock · Price Tiers · Sub-Jobs Budgeting · Billable Activity Slips</div>
          </div>
        </div>

        <nav className="opal-tabs">
          <button className={`opal-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>
            Items &amp; Stock <span className="opal-tab-count">{items.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'jobs' ? 'active' : ''}`} onClick={() => setTab('jobs')}>
            Jobs &amp; Profitability <span className="opal-tab-count">{jobs.length}</span>
          </button>
          <button className={`opal-tab ${tab === 'timebilling' ? 'active' : ''}`} onClick={() => setTab('timebilling')}>
            Time Billing <span className="opal-tab-count">{slips.filter((s) => s.status === 'Unbilled').length}</span>
          </button>
          <button className={`opal-tab ${tab === 'adjustments' ? 'active' : ''}`} onClick={() => setTab('adjustments')}>
            Stocktake Log <span className="opal-tab-count">{adjs.length}</span>
          </button>
        </nav>

        <div className="opal-actions">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP · XDB' : 'Standalone PHP'}
            </span>
          )}
          <button className="btn btn-soft btn-sm" onClick={() => setShowSlipModal(true)}>+ Log Time</button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowItemModal(true)}>+ New Item</button>
        </div>
      </header>

      <main className="opal-main">
        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #d97706, #f59e0b)' } as React.CSSProperties}>
              <div className="kpi-label">Inventory Asset Value</div>
              <div className="kpi-value">{formatAud(overview.inventoryValuation)}</div>
              <div className="kpi-sub">{overview.unitsOnHand} units across Sydney, Melbourne &amp; Brisbane</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': overview.lowStockCount > 0 ? 'linear-gradient(90deg, #dc2626, #f97316)' : 'linear-gradient(90deg, #059669, #0d9488)' } as React.CSSProperties}>
              <div className="kpi-label">Low Stock Reorder Alerts</div>
              <div className={`kpi-value ${overview.lowStockCount > 0 ? 'text-danger' : 'text-success'}`}>{overview.lowStockCount} SKUs</div>
              <div className="kpi-sub">Items at or below reorder threshold</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #059669, #0d9488)' } as React.CSSProperties}>
              <div className="kpi-label">Job Gross Profit</div>
              <div className="kpi-value text-success">{formatAud(overview.jobGrossProfit)}</div>
              <div className="kpi-sub">{overview.activeJobs} active jobs &amp; sub-jobs tracked</div>
            </div>
            <div className="kpi-card" style={{ '--kpi-accent': 'linear-gradient(90deg, #6100a5, #7c3aed)' } as React.CSSProperties}>
              <div className="kpi-label">Unbilled WIP Time</div>
              <div className="kpi-value text-brand">{formatAud(overview.unbilledAmount)}</div>
              <div className="kpi-sub">{overview.unbilledHours} billable hrs ready to invoice</div>
            </div>
          </section>
        )}

        {tab === 'items' && (
          <section className="panel">
            <div className="toolbar">
              <div className="row">
                <span className="fw-700">Price Level Tier:</span>
                <div className="filter-pills">
                  {(['retail', 'trade', 'wholesale'] as const).map((tier) => (
                    <button key={tier} className={`pill-btn ${priceTier === tier ? 'active' : ''}`} onClick={() => setPriceTier(tier)}>
                      {tier.charAt(0).toUpperCase() + tier.slice(1)} Pricing
                    </button>
                  ))}
                </div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowItemModal(true)}>+ Add Product / Service</button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU &amp; Item</th>
                    <th>Location</th>
                    <th className="right">Buy Cost</th>
                    <th className="right">Sell ({priceTier})</th>
                    <th className="right">On Hand</th>
                    <th className="right">Committed</th>
                    <th className="right">Available</th>
                    <th className="right">Valuation</th>
                    <th className="right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const sell = priceTier === 'trade' ? it.trade_price : priceTier === 'wholesale' ? it.wholesale_price : it.retail_price;
                    return (
                      <tr key={it.id}>
                        <td>
                          <div className="fw-700 text-brand num">{it.sku}</div>
                          <div>{it.name}</div>
                        </td>
                        <td>
                          <span className="badge badge-neutral">{it.location}</span>
                          <div className="row-sub">{it.item_type} · {it.tax_code}</div>
                        </td>
                        <td className="right money">{it.item_type === 'Inventory' ? formatAud(it.buy_price) : '—'}</td>
                        <td className="right money fw-700">{formatAud(sell)}</td>
                        <td className="right num fw-700">{it.item_type === 'Inventory' ? it.qty_on_hand : '—'}</td>
                        <td className="right num muted">{it.item_type === 'Inventory' ? it.qty_committed : '—'}</td>
                        <td className="right">
                          {it.item_type === 'Inventory' ? (
                            <span className={`badge ${it.low_stock ? 'badge-danger' : 'badge-success'}`}>
                              {it.available} {it.low_stock ? '· Reorder!' : ''}
                            </span>
                          ) : (
                            <span className="badge badge-brand">Service</span>
                          )}
                        </td>
                        <td className="right money">{it.item_type === 'Inventory' ? formatAud(it.stock_value) : '—'}</td>
                        <td className="right">
                          {it.item_type === 'Inventory' && (
                            <button className="btn btn-soft btn-xs" onClick={() => { setAdjItem(it); setAdjDelta('10'); setAdjMemo(''); }}>
                              Adjust Stock
                            </button>
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

        {tab === 'jobs' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Jobs, Sub-Jobs &amp; Budget vs Actual Profitability</h2>
                <div className="panel-subtitle">AccountRight Plus parity — track revenue, costs, and margin per project or sub-job.</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Job Code &amp; Name</th>
                    <th>Customer</th>
                    <th>Status</th>
                    <th className="right">Budget Income</th>
                    <th className="right">Actual Income</th>
                    <th className="right">Actual Cost</th>
                    <th className="right">Gross Profit</th>
                    <th style={{ width: 140 }}>Budget Burn</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => {
                    const pct = j.budget_income > 0 ? Math.min(100, Math.round((j.actual_income / j.budget_income) * 100)) : 0;
                    return (
                      <tr key={j.id}>
                        <td>
                          <div className="fw-700 text-brand">
                            {j.parent_code ? `↳ ${j.job_code}` : j.job_code} · {j.job_name}
                          </div>
                          {j.parent_code && <div className="row-sub">Sub-job of {j.parent_code}</div>}
                        </td>
                        <td>{j.customer_name}</td>
                        <td><span className={`badge ${j.status === 'Completed' ? 'badge-success' : j.status === 'Active' ? 'badge-opal' : 'badge-warning'}`}>{j.status}</span></td>
                        <td className="right money">{formatAud(j.budget_income)}</td>
                        <td className="right money fw-700">{formatAud(j.actual_income)}</td>
                        <td className="right money">{formatAud(j.actual_cost)}</td>
                        <td className={`right money fw-700 ${j.gross_profit >= 0 ? 'text-success' : 'text-danger'}`}>
                          {formatAud(j.gross_profit)}
                          <div className="row-sub">{formatPercent(j.margin_pct)} margin</div>
                        </td>
                        <td>
                          <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                          <div className="row-sub num">{pct}% of budget billed</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'timebilling' && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Time Billing &amp; Billable Activity Slips</h2>
                <div className="panel-subtitle">Convert tracked consulting and technician hours straight into job revenue &amp; client invoices.</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowSlipModal(true)}>+ Record Activity Slip</button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Staff</th>
                    <th>Job &amp; Customer</th>
                    <th>Activity</th>
                    <th className="right">Hours</th>
                    <th className="right">Rate</th>
                    <th className="right">Billable Total</th>
                    <th>Status</th>
                    <th className="right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {slips.map((s) => (
                    <tr key={s.id}>
                      <td>{formatAuDate(s.slip_date)}</td>
                      <td className="fw-700">{s.staff_name}</td>
                      <td>
                        <span className="badge badge-brand">{s.job_code}</span>
                        <div className="row-sub">{s.customer_name}</div>
                      </td>
                      <td>{s.activity}</td>
                      <td className="right num fw-700">{s.hours}h</td>
                      <td className="right money">{formatAud(s.hourly_rate)}/hr</td>
                      <td className="right money fw-700">{formatAud(s.amount)}</td>
                      <td><span className={`badge ${s.status === 'Billed' ? 'badge-success' : 'badge-warning'}`}>{s.status}</span></td>
                      <td className="right">
                        {s.status === 'Unbilled' ? (
                          <button className="btn btn-opal btn-xs" onClick={() => void handleBillSlip(s)}>Bill to Job</button>
                        ) : (
                          <span className="muted">Invoiced</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'adjustments' && (
          <section className="panel">
            <div className="panel-head"><h2 className="panel-title">Inventory Adjustments &amp; Stocktake Ledger</h2></div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>SKU &amp; Item</th>
                    <th>Location</th>
                    <th>Reason</th>
                    <th className="right">Qty Delta</th>
                    <th>Memo</th>
                  </tr>
                </thead>
                <tbody>
                  {adjs.map((a) => (
                    <tr key={a.id}>
                      <td>{formatAuDate(a.adj_date)}</td>
                      <td><strong className="num text-brand">{a.sku}</strong> · {a.item_name}</td>
                      <td>{a.location}</td>
                      <td><span className="badge badge-neutral">{a.reason}</span></td>
                      <td className={`right num fw-700 ${a.qty_delta >= 0 ? 'text-success' : 'text-danger'}`}>
                        {a.qty_delta > 0 ? `+${a.qty_delta}` : a.qty_delta}
                      </td>
                      <td className="muted">{a.memo || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* Adjust Stock Modal */}
      {adjItem && (
        <div className="modal-backdrop" onClick={() => setAdjItem(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleAdjustStock}>
            <div className="modal-head">
              <h2>Adjust Stock · {adjItem.sku} ({adjItem.location})</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdjItem(null)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="callout callout-brand">
                <div><strong>{adjItem.name}</strong> · Current On Hand: <strong>{adjItem.qty_on_hand}</strong> · Committed: <strong>{adjItem.qty_committed}</strong></div>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label>Quantity Change (+ Add / - Remove)</label>
                  <input className="input num" type="number" required value={adjDelta} onChange={(e) => setAdjDelta(e.target.value)} />
                </div>
                <div className="field">
                  <label>Adjustment Reason</label>
                  <select className="select" value={adjReason} onChange={(e) => setAdjReason(e.target.value)}>
                    <option>Supplier Restock</option>
                    <option>Stocktake Count</option>
                    <option>Damaged / Write-off</option>
                    <option>Warehouse Transfer</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label>Notes / Reference</label>
                <input className="input" value={adjMemo} onChange={(e) => setAdjMemo(e.target.value)} placeholder="e.g. PO-000091 delivery received" />
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setAdjItem(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Post Stock Adjustment</button>
            </div>
          </form>
        </div>
      )}

      {/* New Item Modal */}
      {showItemModal && (
        <div className="modal-backdrop" onClick={() => setShowItemModal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateItem}>
            <div className="modal-head">
              <h2>Add Product / Inventory Item</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowItemModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Item SKU</label><input className="input" required value={itSku} onChange={(e) => setItSku(e.target.value)} placeholder="HW-NFC-01" /></div>
                <div className="field"><label>Item Name</label><input className="input" required value={itName} onChange={(e) => setItName(e.target.value)} placeholder="NFC Tap Reader AU" /></div>
                <div className="field">
                  <label>Warehouse Location</label>
                  <select className="select" value={itLoc} onChange={(e) => setItLoc(e.target.value)}>
                    <option>Sydney HQ</option>
                    <option>Melbourne Hub</option>
                    <option>Brisbane Depot</option>
                  </select>
                </div>
                <div className="field"><label>Opening Qty On Hand</label><input className="input num" type="number" value={itQty} onChange={(e) => setItQty(e.target.value)} /></div>
                <div className="field"><label>Buy Cost (Ex GST)</label><input className="input num" type="number" step="0.01" value={itBuy} onChange={(e) => setItBuy(e.target.value)} /></div>
                <div className="field"><label>Retail Price (Ex GST)</label><input className="input num" type="number" step="0.01" value={itRetail} onChange={(e) => setItRetail(e.target.value)} /></div>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowItemModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save Item</button>
            </div>
          </form>
        </div>
      )}

      {/* New Time Slip Modal */}
      {showSlipModal && (
        <div className="modal-backdrop" onClick={() => setShowSlipModal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateSlip}>
            <div className="modal-head">
              <h2>Log Billable Activity Slip</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowSlipModal(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Staff Member</label><input className="input" required value={slStaff} onChange={(e) => setSlStaff(e.target.value)} /></div>
                <div className="field">
                  <label>Linked Job</label>
                  <select className="select" value={slJob} onChange={(e) => setSlJob(e.target.value)}>
                    {jobs.map((j) => <option key={j.job_code} value={j.job_code}>{j.job_code} · {j.job_name}</option>)}
                  </select>
                </div>
                <div className="field"><label>Billable Hours</label><input className="input num" type="number" step="0.25" required value={slHrs} onChange={(e) => setSlHrs(e.target.value)} /></div>
                <div className="field"><label>Hourly Rate (AUD)</label><input className="input num" type="number" step="1" required value={slRate} onChange={(e) => setSlRate(e.target.value)} /></div>
              </div>
              <div className="field"><label>Activity Description</label><input className="input" required value={slAct} onChange={(e) => setSlAct(e.target.value)} /></div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowSlipModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save Time Slip</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
