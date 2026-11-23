import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SoftNContainerHandle } from '@softn/container';
import { ENTITIES, OPAL_APPS, type CompanyEntity, type OpalAppDef } from '../data/opalCatalog';
import { SoftNAppFrame } from './SoftNAppFrame';
import { MyobComparison } from './MyobComparison';

interface MountedEntry {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  abbr: string;
  gradient: string;
  source: string | Uint8Array;
  bundleFile?: string;
  supportsStandalone: boolean;
}

function NavIcon({ slug }: { slug: string }) {
  const props = { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (slug) {
    case 'dashboard':
      return <svg {...props}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
    case 'sales':
      return <svg {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></svg>;
    case 'purchases':
      return <svg {...props}><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 0 1-8 0" /></svg>;
    case 'banking':
      return <svg {...props}><line x1="3" y1="22" x2="21" y2="22" /><line x1="6" y1="18" x2="6" y2="11" /><line x1="10" y1="18" x2="10" y2="11" /><line x1="14" y1="18" x2="14" y2="11" /><line x1="18" y1="18" x2="18" y2="11" /><polygon points="12 2 20 7 4 7" /></svg>;
    case 'accounting':
      return <svg {...props}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /><line x1="9" y1="7" x2="16" y2="7" /><line x1="9" y1="11" x2="15" y2="11" /></svg>;
    case 'payroll':
      return <svg {...props}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
    case 'inventory':
      return <svg {...props}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>;
    case 'contacts':
      return <svg {...props}><rect x="2" y="4" width="20" height="16" rx="2" /><circle cx="8" cy="11" r="2.2" /><path d="M5 17c.5-2 2-3 3-3s2.5 1 3 3" /><line x1="14" y1="10" x2="19" y2="10" /><line x1="14" y1="14" x2="18" y2="14" /></svg>;
    case 'reporting':
      return <svg {...props}><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>;
    default:
      return <svg {...props}><circle cx="12" cy="12" r="9" /></svg>;
  }
}

const CASH_SERIES = [
  { month: 'Jul', cashIn: 41, cashOut: 24 },
  { month: 'Aug', cashIn: 45, cashOut: 26 },
  { month: 'Sep', cashIn: 48, cashOut: 28 },
  { month: 'Oct', cashIn: 52, cashOut: 29 },
  { month: 'Nov', cashIn: 56, cashOut: 30 },
];

export const WorkspaceShell: React.FC = () => {
  const [entity, setEntity] = useState<CompanyEntity>(ENTITIES[0]);
  const [viewMode, setViewMode] = useState<'dashboard' | 'app' | 'compare'>('dashboard');
  const [mountedApps, setMountedApps] = useState<MountedEntry[]>([]);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [backendMode, setBackendMode] = useState<'zipp' | 'standalone'>('zipp');
  const [standaloneOnline, setStandaloneOnline] = useState<Record<string, boolean>>({});
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const handlesRef = useRef<Map<string, SoftNContainerHandle>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 3200);
  }, []);

  const probeStandalone = useCallback(async () => {
    try {
      const resp = await fetch('/api/standalone-status');
      if (resp.ok) {
        const data = (await resp.json()) as { servers?: Record<string, boolean> };
        if (data.servers) setStandaloneOnline(data.servers);
      }
    } catch {
      // ignore offline
    }
  }, []);

  useEffect(() => {
    void probeStandalone();
  }, [probeStandalone]);

  const openApp = useCallback((app: OpalAppDef) => {
    setMountedApps((prev) => {
      if (prev.some((m) => m.id === app.id)) return prev;
      return [
        ...prev,
        {
          id: app.id,
          slug: app.slug,
          name: app.name,
          shortName: app.shortName,
          abbr: app.abbr,
          gradient: app.gradient,
          source: `/bundles/${app.bundleFile}`,
          bundleFile: app.bundleFile,
          supportsStandalone: true,
        },
      ];
    });
    setActiveAppId(app.id);
    setViewMode('app');
    setShowCreateMenu(false);
  }, []);

  const openSlug = useCallback(
    (slug: string) => {
      const found = OPAL_APPS.find((a) => a.slug === slug || a.id === slug);
      if (found) openApp(found);
    },
    [openApp]
  );

  const closeMountedApp = (appId: string) => {
    setMountedApps((prev) => {
      const next = prev.filter((m) => m.id !== appId);
      if (activeAppId === appId) {
        if (next.length > 0) {
          setActiveAppId(next[next.length - 1].id);
        } else {
          setActiveAppId(null);
          setViewMode('dashboard');
        }
      }
      return next;
    });
  };

  const handleRegisterHandle = useCallback((appId: string, handle: SoftNContainerHandle | null) => {
    if (handle) handlesRef.current.set(appId, handle);
    else handlesRef.current.delete(appId);
  }, []);

  const handleExportSqlite = async () => {
    if (!activeAppId) return;
    const handle = handlesRef.current.get(activeAppId);
    if (!handle) {
      notify('Wait for the container to finish booting first.');
      return;
    }
    try {
      const bytes = await handle.exportDatabase('app');
      if (!bytes || bytes.byteLength === 0) {
        notify('Live XDB SQLite export is available in ZIPP WASM mode.');
        return;
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeAppId.replace(/[^a-z0-9.-]/gi, '_')}.db`;
      a.click();
      URL.revokeObjectURL(url);
      notify(`Exported live XDB SQLite database (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSideloadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const clean = file.name.replace(/\.(softn|zip)$/i, '');
    const id = `custom.${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    setMountedApps((prev) => [
      ...prev.filter((m) => m.id !== id),
      {
        id,
        slug: clean,
        name: clean,
        shortName: clean,
        abbr: clean.slice(0, 2).toUpperCase(),
        gradient: 'linear-gradient(135deg, #334155, #6100a5)',
        source: bytes,
        supportsStandalone: false,
      },
    ]);
    setActiveAppId(id);
    setViewMode('app');
    notify(`Mounted custom SoftN container: ${file.name}`);
  };

  const activeMounted = mountedApps.find((m) => m.id === activeAppId) || null;
  const onlineCount = Object.values(standaloneOnline).filter(Boolean).length;

  return (
    <div className="host-shell">
      {/* MYOB-inspired Obsidian-Plum Left Navigation Sidebar */}
      <aside className="host-sidebar">
        <div className="sidebar-brand" onClick={() => setViewMode('dashboard')}>
          <div className="brand-gem">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <polygon points="12 2 22 9 18 21 6 21 2 9" fill="url(#opalGrad)" stroke="#ffffff" strokeWidth="1.5" />
              <defs>
                <linearGradient id="opalGrad" x1="2" y1="2" x2="22" y2="21">
                  <stop offset="0%" stopColor="#c084fc" />
                  <stop offset="50%" stopColor="#6100a5" />
                  <stop offset="100%" stopColor="#14b8a6" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div>
            <div className="brand-name">Opal Business</div>
            <div className="brand-sub">AU SoftN Accounting Suite</div>
          </div>
        </div>

        {/* Multi-Company Switcher (AccountRight Premier Parity) */}
        <div className="entity-box">
          <label className="entity-label">Active Business File (ABN)</label>
          <select
            className="entity-select"
            value={entity.id}
            onChange={(e) => {
              const found = ENTITIES.find((en) => en.id === e.target.value);
              if (found) {
                setEntity(found);
                notify(`Switched active entity to ${found.name}`);
              }
            }}
          >
            {ENTITIES.map((en) => (
              <option key={en.id} value={en.id}>
                {en.name}
              </option>
            ))}
          </select>
          <div className="entity-meta">ABN {entity.abn} · {entity.fy}</div>
        </div>

        {/* Primary Workspace Navigation */}
        <nav className="sidebar-nav">
          <div className="nav-section-label">Command Centre</div>
          <button
            className={`nav-item ${viewMode === 'dashboard' ? 'active' : ''}`}
            onClick={() => setViewMode('dashboard')}
          >
            <NavIcon slug="dashboard" />
            <span>Business Dashboard</span>
          </button>

          <div className="nav-section-label">SoftN Modules ({OPAL_APPS.length})</div>
          {OPAL_APPS.map((app) => {
            const isMounted = mountedApps.some((m) => m.id === app.id);
            const isActive = viewMode === 'app' && activeAppId === app.id;
            return (
              <button
                key={app.id}
                className={`nav-item ${isActive ? 'active' : ''}`}
                onClick={() => openApp(app)}
              >
                <NavIcon slug={app.slug} />
                <span className="nav-item-label">{app.shortName}</span>
                {isMounted && <span className="nav-live-dot" title="Container live in memory" />}
              </button>
            );
          })}

          {mountedApps.filter((m) => !m.supportsStandalone).length > 0 && (
            <>
              <div className="nav-section-label">Side-Loaded Apps</div>
              {mountedApps
                .filter((m) => !m.supportsStandalone)
                .map((m) => (
                  <button
                    key={m.id}
                    className={`nav-item ${viewMode === 'app' && activeAppId === m.id ? 'active' : ''}`}
                    onClick={() => {
                      setActiveAppId(m.id);
                      setViewMode('app');
                    }}
                  >
                    <NavIcon slug="custom" />
                    <span className="nav-item-label">{m.shortName}</span>
                    <span className="nav-live-dot" />
                  </button>
                ))}
            </>
          )}

          <div className="nav-section-label">Platform &amp; Parity</div>
          <button
            className={`nav-item ${viewMode === 'compare' ? 'active' : ''}`}
            onClick={() => setViewMode('compare')}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <span>MYOB AU Parity Matrix</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <input
            ref={fileInputRef}
            type="file"
            accept=".softn,.zip"
            style={{ display: 'none' }}
            onChange={(e) => void handleSideloadFile(e)}
          />
          <button className="sidebar-upload-btn" onClick={() => fileInputRef.current?.click()}>
            + Side-Load Any .softn App
          </button>
          <div className="sidebar-engine-note">
            Powered by <strong>ZIPP PHP 8 WASM</strong> &amp; <strong>XDB SQLite 3</strong>
          </div>
        </div>
      </aside>

      {/* Right Main Area */}
      <div className="host-main">
        {/* Top Control Bar */}
        <header className="host-topbar">
          <div className="topbar-left">
            <div className="topbar-title-group">
              <div className="topbar-breadcrumb">
                {viewMode === 'dashboard'
                  ? 'Executive Business Overview'
                  : viewMode === 'compare'
                    ? 'MYOB Business Australia Research & Parity'
                    : activeMounted?.name || 'Container'}
              </div>
              <div className="topbar-sub">
                {entity.name} · {entity.basCycle}
              </div>
            </div>
          </div>

          <div className="topbar-right">
            {/* Quick + Create Launcher */}
            <div className="create-dropdown-wrap">
              <button
                className="host-btn host-btn-primary"
                onClick={() => setShowCreateMenu((p) => !p)}
              >
                + Create
              </button>
              {showCreateMenu && (
                <div className="create-dropdown" onMouseLeave={() => setShowCreateMenu(false)}>
                  <div className="create-dropdown-head">Quick Jump to Module</div>
                  {OPAL_APPS.map((a) => (
                    <button key={a.id} className="create-dropdown-item" onClick={() => openApp(a)}>
                      <span className="create-mini-badge" style={{ background: a.gradient }}>{a.abbr}</span>
                      <div>
                        <div className="create-item-title">{a.quickActions[0]?.label || a.name}</div>
                        <div className="create-item-sub">{a.quickActions[0]?.hint} · {a.shortName}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Dual-Mode PHP Runtime Switcher (ZIPP WASM default vs Standalone PHP) */}
            <div className="mode-switcher" title="Switch PHP backend execution between in-browser ZIPP WASM and Standalone PHP 8">
              <button
                className={`mode-btn ${backendMode === 'zipp' ? 'active' : ''}`}
                onClick={() => {
                  setBackendMode('zipp');
                  notify('Using in-browser ZIPP PHP 8 WASM + XDB SQLite 3 (Zero Server)');
                }}
              >
                <span className="dot-teal" /> ZIPP WASM
              </button>
              <button
                className={`mode-btn ${backendMode === 'standalone' ? 'active' : ''}`}
                onClick={() => {
                  void probeStandalone();
                  setBackendMode('standalone');
                  notify(
                    onlineCount > 0
                      ? `Switched to Standalone PHP 8 Host (${onlineCount}/8 servers online)`
                      : 'Standalone PHP selected — run `node examples/opal-business/serve-php.mjs` to start native PHP servers'
                  );
                }}
              >
                <span className={onlineCount > 0 ? 'dot-blue' : 'dot-amber'} /> Standalone PHP
              </button>
            </div>

            {viewMode === 'app' && activeMounted && (
              <div className="active-app-tools">
                <button className="host-btn host-btn-ghost" onClick={() => void handleExportSqlite()}>
                  Export .db
                </button>
                {activeMounted.bundleFile && (
                  <a
                    className="host-btn host-btn-ghost"
                    href={`/bundles/${activeMounted.bundleFile}`}
                    download={activeMounted.bundleFile}
                  >
                    Download .softn
                  </a>
                )}
              </div>
            )}
          </div>
        </header>

        {/* Keep-Alive Running Container Tab Strip */}
        {mountedApps.length > 0 && (
          <div className="running-tabs-bar">
            <button
              className={`running-tab ${viewMode === 'dashboard' ? 'active' : ''}`}
              onClick={() => setViewMode('dashboard')}
            >
              Overview
            </button>
            {mountedApps.map((m) => (
              <div
                key={m.id}
                className={`running-tab ${viewMode === 'app' && activeAppId === m.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveAppId(m.id);
                  setViewMode('app');
                }}
              >
                <span className="running-tab-dot" style={{ background: m.gradient }} />
                <span>{m.shortName}</span>
                <button
                  className="running-tab-close"
                  title="Close container"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeMountedApp(m.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Viewport Stage: Dashboard, Compare View, or Keep-Alive SoftN Containers */}
        <div className="host-stage">
          {viewMode === 'dashboard' && (
            <div className="dash-page">
              {/* Executive Welcome Banner */}
              <section className="dash-hero">
                <div className="dash-hero-left">
                  <div className="hero-eyebrow">AUSTRALIAN CLOUD ACCOUNTING · PORTABLE SOFTN SUITE</div>
                  <h1>Welcome back, {entity.name}</h1>
                  <p>
                    All 8 MYOB Business &amp; AccountRight modules run locally inside isolated{' '}
                    <strong>React + PHP 8 ZIPP WASM + XDB SQLite 3</strong> containers — or connect seamlessly to
                    standalone PHP hosting with zero code changes.
                  </p>
                  <div className="dash-hero-cta">
                    <button className="host-btn host-btn-primary" onClick={() => openSlug('sales')}>
                      Create Tax Invoice
                    </button>
                    <button className="host-btn host-btn-opal" onClick={() => openSlug('accounting')}>
                      Review Q2 AI BAS
                    </button>
                    <button className="host-btn host-btn-glass" onClick={() => setViewMode('compare')}>
                      View MYOB.com.au Parity
                    </button>
                  </div>
                </div>
                <div className="dash-hero-stats">
                  <div className="hero-stat-card">
                    <span>Bank Cash Position</span>
                    <strong>{entity.cashBalance}</strong>
                    <small>4 live AU feeds connected</small>
                  </div>
                  <div className="hero-stat-card">
                    <span>Q2 Est. BAS Payable</span>
                    <strong>{entity.estBas}</strong>
                    <small>Due 28 Feb 2027 · 2 AI flags</small>
                  </div>
                  <div className="hero-stat-card">
                    <span>Open Receivables</span>
                    <strong>{entity.receivables}</strong>
                    <small>1 overdue · reminders enabled</small>
                  </div>
                  <div className="hero-stat-card">
                    <span>Bills To Pay</span>
                    <strong>{entity.payables}</strong>
                    <small>3 receipts waiting in In Tray</small>
                  </div>
                </div>
              </section>

              {/* Cash Flow & ATO Compliance Row */}
              <section className="dash-analytics-grid">
                <div className="host-card">
                  <div className="host-card-head">
                    <div>
                      <h2>Cash In vs Cash Out (FY2026–27)</h2>
                      <p className="host-muted">Monthly operating inflow &amp; outflow snapshot in AUD ($k)</p>
                    </div>
                    <button className="mini-launch-btn" onClick={() => openSlug('reporting')}>
                      Open Full Reports
                    </button>
                  </div>
                  <div className="host-card-body">
                    <svg viewBox="0 0 540 165" style={{ width: '100%', height: 160, display: 'block' }}>
                      {[0.25, 0.5, 0.75, 1].map((f) => (
                        <line key={f} x1="20" x2="520" y1={138 - f * 114} y2={138 - f * 114} stroke="#e4e7f0" strokeDasharray="3 4" />
                      ))}
                      {CASH_SERIES.map((pt, i) => {
                        const x = 68 + i * 96;
                        const hIn = (pt.cashIn / 60) * 114;
                        const hOut = (pt.cashOut / 60) * 114;
                        return (
                          <g key={pt.month}>
                            <rect x={x - 24} y={138 - hIn} width="22" height={hIn} rx="5" fill="#6100a5" />
                            <rect x={x + 2} y={138 - hOut} width="22" height={hOut} rx="5" fill="#0d9488" />
                            <text x={x - 13} y={132 - hIn} textAnchor="middle" fontSize="10" fontWeight="700" fill="#6100a5">${pt.cashIn}k</text>
                            <text x={x + 13} y={132 - hOut} textAnchor="middle" fontSize="10" fontWeight="700" fill="#0d9488">${pt.cashOut}k</text>
                            <text x={x} y="156" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="#475569">{pt.month} 26</text>
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                </div>

                <div className="host-card">
                  <div className="host-card-head">
                    <div>
                      <h2>ATO &amp; Daily Bookkeeping Checklist</h2>
                      <p className="host-muted">One-click jump directly into each SoftN module</p>
                    </div>
                  </div>
                  <div className="host-card-body checklist-stack">
                    <div className="check-row" onClick={() => openSlug('banking')}>
                      <span className="check-pill check-warn">5 to code</span>
                      <div>
                        <div className="check-title">Run Bank Rules &amp; Match CommBank Feed</div>
                        <div className="check-sub">5 unallocated feed lines · 2 smart invoice matches</div>
                      </div>
                      <span className="check-arrow">→</span>
                    </div>
                    <div className="check-row" onClick={() => openSlug('purchases')}>
                      <span className="check-pill check-violet">3 OCR docs</span>
                      <div>
                        <div className="check-title">Convert In Tray Receipts to Supplier Bills</div>
                        <div className="check-sub">Bunnings Trade, Officeworks &amp; Telstra ready</div>
                      </div>
                      <span className="check-arrow">→</span>
                    </div>
                    <div className="check-row" onClick={() => openSlug('accounting')}>
                      <span className="check-pill check-warn">2 AI flags</span>
                      <div>
                        <div className="check-title">Resolve Q2 FY2026–27 AI BAS Tax Anomalies</div>
                        <div className="check-sub">Reclassify fixed asset purchase to CAP (G10)</div>
                      </div>
                      <span className="check-arrow">→</span>
                    </div>
                    <div className="check-row" onClick={() => openSlug('payroll')}>
                      <span className="check-pill check-teal">12% SG</span>
                      <div>
                        <div className="check-title">Pay Super Batch &amp; Process Next Pay Run</div>
                        <div className="check-sub">STP Phase 2 ATO accepted · $2,354.20 Super due</div>
                      </div>
                      <span className="check-arrow">→</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Modular 8-App SoftN Suite Grid */}
              <section className="dash-modules-section">
                <div className="dash-section-head">
                  <div>
                    <h2>Modular SoftN Business Applications</h2>
                    <p className="host-muted">
                      Each card mounts an isolated React 18 + PHP 8 + XDB SQLite 3 <code>.softn</code> bundle inside this parent host.
                    </p>
                  </div>
                </div>
                <div className="modules-grid">
                  {OPAL_APPS.map((app) => {
                    const isMounted = mountedApps.some((m) => m.id === app.id);
                    return (
                      <div key={app.id} className="module-card" onClick={() => openApp(app)}>
                        <div className="module-card-head">
                          <div className="app-chip-icon" style={{ background: app.gradient }}>{app.abbr}</div>
                          <div className="module-tier-pill">{app.myobTierParity}</div>
                        </div>
                        <h3>{app.name}</h3>
                        <p>{app.tagline}</p>
                        <div className="module-tables">
                          {app.tables.slice(0, 3).map((t) => (
                            <span key={t} className="sql-pill">{t}</span>
                          ))}
                          {app.tables.length > 3 && <span className="sql-pill">+{app.tables.length - 3}</span>}
                        </div>
                        <div className="module-card-foot">
                          <span className="bundle-name">{app.bundleFile}</span>
                          <span className={`launch-cta ${isMounted ? 'live' : ''}`}>
                            {isMounted ? 'Resume Live →' : 'Launch App →'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          )}

          {viewMode === 'compare' && (
            <MyobComparison
              onLaunchSlug={openSlug}
              onBackToWorkspace={() => setViewMode('dashboard')}
            />
          )}

          {/* Keep-Alive Mounted SoftN Containers */}
          {mountedApps.map((m) => (
            <SoftNAppFrame
              key={`${m.id}:${backendMode}`}
              appId={m.id}
              source={m.source}
              active={viewMode === 'app' && activeAppId === m.id}
              backendUrl={backendMode === 'standalone' && m.supportsStandalone ? `/standalone/${m.slug}` : undefined}
              onHandleReady={handleRegisterHandle}
            />
          ))}
        </div>
      </div>

      {toast && <div className="host-toast">{toast}</div>}
    </div>
  );
};
