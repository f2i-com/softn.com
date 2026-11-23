import React, { useState } from 'react';
import {
  CORE_APPS,
  DEPARTMENTS,
  ODOO_PARITY_MAP,
  VERTICAL_PACKS,
  type DepartmentId,
} from '../data/suiteCatalog';

interface MarketingSiteProps {
  onLaunchWorkspace: (appId?: string, packFile?: string) => void;
}

function fmtUsd(amount: number): string {
  return '$' + Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const MarketingSite: React.FC<MarketingSiteProps> = ({ onLaunchWorkspace }) => {
  const [selectedDept, setSelectedDept] = useState<'all' | DepartmentId>('all');
  const [seatCount, setSeatCount] = useState(25);
  const [odooPlan, setOdooPlan] = useState<'standard' | 'custom'>('custom');

  // Representative published Odoo monthly list rates (USD/user/mo)
  const odooPerSeat = odooPlan === 'standard' ? 31.1 : 46.8;
  const odooAnnual = seatCount * odooPerSeat * 12;
  const odooThreeYear = odooAnnual * 3;
  // Self-hosted Modula container suite: $0 per-user SaaS fee (optional small VPS cost estimate)
  const modulaThreeYear = 0;

  const visibleParity = selectedDept === 'all'
    ? ODOO_PARITY_MAP
    : ODOO_PARITY_MAP.filter((m) => m.department === selectedDept);

  const liveCount = ODOO_PARITY_MAP.filter((m) => m.status === 'live').length;
  const packCount = ODOO_PARITY_MAP.filter((m) => m.status === 'pack').length;

  return (
    <div className="site-wrap">
      <header className="site-nav">
        <div className="site-nav-inner">
          <button type="button" className="brand-mark" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <span className="brand-cube">M</span>
            <span>Modula</span>
            <span className="brand-sub-pill">SoftN Containers</span>
          </button>

          <nav className="nav-links" aria-label="Primary navigation">
            <a href="#apps">Apps ({ODOO_PARITY_MAP.length})</a>
            <a href="#compare">vs Odoo</a>
            <a href="#pricing">Pricing</a>
            <a href="#architecture">Architecture</a>
            <a href="#industries">Industry Packs</a>
          </nav>

          <div className="nav-cta">
            <button type="button" className="hbtn" onClick={() => onLaunchWorkspace()}>
              App Launcher
            </button>
            <button id="launch-workspace-cta" type="button" className="hbtn hbtn-primary" onClick={() => onLaunchWorkspace('modula.crm')}>
              Launch Live Suite →
            </button>
          </div>
        </div>
      </header>

      <section className="hero">
        <div className="hero-eyebrow">
          <span>Open Odoo Alternative</span>
          <span>·</span>
          <strong>{CORE_APPS.length} Live React + PHP 8 + XDB SQLite .softn Apps</strong>
        </div>

        <h1>
          All your business on one platform.{' '}
          <span className="hero-accent">Zero per-seat SaaS lock-in.</span>
        </h1>

        <p className="hero-sub">
          Modula replaces monolithic per-user ERP subscriptions with portable{' '}
          <strong>.softn web containers</strong> hosted inside your own parent application.
          Each module runs <strong>React 18 + PHP 8 + XDB SQLite 3</strong> completely locally
          in <strong>ZIPP WASM</strong> — or scales out on standalone PHP hosting with zero code changes.
        </p>

        <div className="hero-actions">
          <button type="button" className="hbtn hbtn-primary hbtn-lg" onClick={() => onLaunchWorkspace('modula.crm')}>
            Try the Live Parent Workspace →
          </button>
          <button type="button" className="hbtn hbtn-lg" onClick={() => onLaunchWorkspace()}>
            Browse Installed .softn Apps
          </button>
        </div>

        <div className="hero-dock">
          <div className="hero-dock-label">
            Click any module below to boot its isolated .softn container inside the Parent Application
          </div>
          <div className="app-tile-grid">
            {CORE_APPS.map((app) => (
              <button
                key={app.id}
                type="button"
                className="app-tile"
                data-launch-app={app.slug}
                onClick={() => onLaunchWorkspace(app.id)}
              >
                <div className="app-tile-icon" style={{ background: app.color }}>
                  {app.iconText}
                </div>
                <div className="app-tile-name">{app.name}</div>
                <div className="app-tile-sub">{app.odooEquivalents.join(' + ')}</div>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section id="apps" className="section">
        <div className="section-head">
          <h2>Complete Odoo.com Capability Map</h2>
          <p>
            Odoo organizes its platform across 8 functional departments. Modula already covers{' '}
            <strong>{liveCount} core Odoo modules live today</strong> across {CORE_APPS.length} standalone React + PHP + SQLite{' '}
            <code>.softn</code> apps, plus <strong>{packCount} turnkey SoftN Industry Business Packs</strong> you can mount immediately.
          </p>
        </div>

        <div className="dept-pills">
          <button
            type="button"
            className={`dept-pill ${selectedDept === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedDept('all')}
          >
            All Departments ({ODOO_PARITY_MAP.length})
          </button>
          {DEPARTMENTS.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`dept-pill ${selectedDept === d.id ? 'active' : ''}`}
              onClick={() => setSelectedDept(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="parity-grid">
          {visibleParity.map((mod) => (
            <div key={`${mod.department}-${mod.odooName}`} className="parity-card">
              <div className="parity-top">
                <strong style={{ fontSize: '15px' }}>{mod.odooName}</strong>
                {mod.status === 'live' && <span className="pill-live">Live .softn</span>}
                {mod.status === 'pack' && <span className="pill-pack">SoftN Pack</span>}
                {mod.status === 'roadmap' && <span className="pill-roadmap">Roadmap</span>}
              </div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--brand)' }}>
                → {mod.modulaTarget}
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--ink-secondary)', flex: 1 }}>
                {mod.notes}
              </div>
              {mod.launchAppId && (
                <div>
                  <button
                    type="button"
                    className="hbtn hbtn-sm hbtn-primary"
                    onClick={() => onLaunchWorkspace(mod.launchAppId)}
                  >
                    Launch App →
                  </button>
                </div>
              )}
              {mod.packFile && (
                <div>
                  <button
                    type="button"
                    className="hbtn hbtn-sm"
                    onClick={() => onLaunchWorkspace(undefined, mod.packFile)}
                  >
                    Mount Business Pack →
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="section">
        <div className="section-head">
          <h2>Escape the &ldquo;Second App&rdquo; Per-Seat Cliff</h2>
          <p>
            Odoo&apos;s &ldquo;One App Free&rdquo; plan turns into a per-user subscription across your entire company
            the moment you add a second app — and locks Odoo Studio, external APIs, and self-hosting behind the Custom tier.
          </p>
        </div>

        <div className="calc-box">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <strong>Team Size</strong>
                <strong style={{ color: 'var(--brand)', fontSize: '18px' }}>{seatCount} users</strong>
              </div>
              <input
                type="range"
                min={5}
                max={200}
                step={5}
                value={seatCount}
                onChange={(e) => setSeatCount(Number(e.target.value))}
                style={{ width: '100%', accentColor: '#5b21b6' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--ink-muted)' }}>
                <span>5 users</span><span>50</span><span>100</span><span>200 users</span>
              </div>
            </div>

            <div>
              <div style={{ fontWeight: 700, marginBottom: '8px' }}>Compare Against Odoo Plan</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className={`hbtn ${odooPlan === 'standard' ? 'hbtn-primary' : ''}`}
                  onClick={() => setOdooPlan('standard')}
                >
                  Odoo Standard (~$31/user/mo)
                </button>
                <button
                  type="button"
                  className={`hbtn ${odooPlan === 'custom' ? 'hbtn-primary' : ''}`}
                  onClick={() => setOdooPlan('custom')}
                >
                  Odoo Custom + Studio (~$47/user/mo)
                </button>
              </div>
            </div>

            <div style={{ fontSize: '13px', color: 'var(--ink-secondary)', lineHeight: 1.55 }}>
              With Modula on SoftN, every team member gets <strong>all apps</strong>, <strong>SoftN Studio customization</strong>,
              <strong> full SQLite database ownership</strong>, and <strong>self-hosted PHP deployment</strong> with zero per-seat license fees.
            </div>
          </div>

          <div className="calc-stat-grid">
            <div className="calc-stat">
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink-muted)', textTransform: 'uppercase' }}>Odoo Annual Cost</div>
              <div className="calc-num" style={{ color: 'var(--danger)' }}>{fmtUsd(odooAnnual)}/yr</div>
              <div style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>{fmtUsd(odooThreeYear)} over 3 years</div>
            </div>
            <div className="calc-stat">
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink-muted)', textTransform: 'uppercase' }}>Modula License</div>
              <div className="calc-num" style={{ color: 'var(--success)' }}>{fmtUsd(modulaThreeYear)}/yr</div>
              <div style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>Unlimited users · All .softn apps</div>
            </div>
            <div className="calc-stat highlight">
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--brand)', textTransform: 'uppercase' }}>Estimated 3-Year License Savings</div>
              <div className="calc-num" style={{ color: 'var(--brand)' }}>{fmtUsd(odooThreeYear - modulaThreeYear)}</div>
              <div style={{ fontSize: '12.5px', color: 'var(--ink-secondary)' }}>
                Keep 100% of your React UI, PHP 8 backend, and SQLite 3 data portable forever.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="compare" className="section">
        <div className="section-head">
          <h2>How Modula + SoftN Beats Monolithic ERPs</h2>
          <p>Designed from day one to be embedded inside your parent application as isolated, portable microservices.</p>
        </div>

        <div className="compare-table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Odoo Online / Enterprise</th>
                <th>Modula (SoftN v2 Container Suite)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>App Architecture</strong></td>
                <td>Monolithic Python/PostgreSQL server; custom add-ons share one process &amp; schema</td>
                <td><strong>Sandboxed <code>.softn</code> containers</strong> (React 18 + PHP 8 + XDB SQLite) mounted inside any Parent Host</td>
              </tr>
              <tr>
                <td><strong>Local / Offline Execution</strong></td>
                <td>Requires cloud SaaS or Docker/Linux server stack</td>
                <td><strong>Zero-server in-browser execution</strong> via ZIPP WASM Workers (<code>zipp-php.wasm</code> + <code>xdb-wasm.wasm</code>)</td>
              </tr>
              <tr>
                <td><strong>Standalone Server Hosting</strong></td>
                <td>Self-hosting &amp; custom code gated behind Custom tier</td>
                <td><strong>Dual-mode PHP 8 backend:</strong> runs inside ZIPP locally OR standalone PHP + WAL SQLite with zero code changes</td>
              </tr>
              <tr>
                <td><strong>Visual Customization</strong></td>
                <td>Odoo Studio locked to highest tier ($47/user/mo)</td>
                <td><strong>SoftN Studio &amp; Builder</strong> included — edit React/PHP/SQLite visually or with AI</td>
              </tr>
              <tr>
                <td><strong>Database Portability</strong></td>
                <td>Proprietary ORM dump; complex major-version upgrades</td>
                <td><strong>1-click standard SQLite 3 <code>.db</code> export</strong> per app — inspect or migrate anywhere</td>
              </tr>
              <tr>
                <td><strong>Parent App Embedding</strong></td>
                <td>Hard to embed cleanly inside external portals</td>
                <td><strong>Native <code>&lt;softn-app&gt;</code> &amp; <code>mountSoftNContainer()</code></strong> with closed Shadow DOM &amp; keep-alive tabs</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section id="architecture" className="section">
        <div className="section-head">
          <h2>Inside Every Modula <code>.softn</code> App</h2>
          <p>One portable ZIP archive carries the entire full-stack application and switches seamlessly between browser WASM and standalone PHP.</p>
        </div>

        <div className="arch-grid">
          <div className="arch-card">
            <span className="pill-live" style={{ width: 'fit-content' }}>1. Frontend Layer</span>
            <h3>React 18 in ZIPP Lite WASM</h3>
            <p>
              Standard Vite-built React UI inside <code>public/</code> runs in an isolated Web Worker and patches
              a closed Shadow DOM inside the parent application — zero CSS leakage or host coupling.
            </p>
          </div>
          <div className="arch-card">
            <span className="pill-pack" style={{ width: 'fit-content' }}>2. Dual-Mode PHP Backend</span>
            <h3>PHP 8 in ZIPP or Standalone</h3>
            <p>
              <code>backend/index.php</code> runs inside <code>zipp-php.wasm</code> automatically when embedded.
              Need multi-user server scale? Point <code>backendUrl</code> at standalone <code>php -S</code>, Apache, or <code>softn-host-php</code>.
            </p>
          </div>
          <div className="arch-card">
            <span className="pill-live" style={{ width: 'fit-content' }}>3. XDB SQLite 3 Storage</span>
            <h3>Persisted &amp; Exportable SQL</h3>
            <p>
              Standard PHP <code>PDO(&apos;sqlite:app.db&apos;)</code> talks to pure-Rust XDB SQLite WASM persisted in browser
              IndexedDB locally, or WAL SQLite files on a server — with 1-click <code>.db</code> export.
            </p>
          </div>
          <div className="arch-card">
            <span className="pill-pack" style={{ width: 'fit-content' }}>4. Parent Host Shell</span>
            <h3>Embedded Multi-App OS</h3>
            <p>
              The React parent shell provides the Odoo-style 9-dot app grid, keep-alive background tab pausing
              (<code>setActive</code>), custom <code>.softn</code> sideloading, and backend mode switching.
            </p>
          </div>
        </div>
      </section>

      <section id="industries" className="section">
        <div className="section-head">
          <h2>Ready-to-Mount SoftN Vertical Industry Packs</h2>
          <p>
            Beyond the {CORE_APPS.length} core Modula ERP containers, the Parent Workspace can mount SoftN&apos;s existing turnkey
            PHP 8 + XDB SQLite vertical business bundles immediately.
          </p>
        </div>

        <div className="parity-grid">
          {VERTICAL_PACKS.map((pack) => (
            <div key={pack.slug} className="parity-card">
              <div className="parity-top">
                <strong style={{ fontSize: '15px' }}>{pack.name}</strong>
                <span className="pill-pack">{pack.category}</span>
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--ink-secondary)', flex: 1 }}>
                {pack.description}
              </div>
              <div>
                <button
                  type="button"
                  className="hbtn hbtn-sm"
                  onClick={() => onLaunchWorkspace(undefined, pack.file)}
                >
                  Mount in Parent Workspace →
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer style={{ borderTop: '1px solid var(--border)', background: '#ffffff', padding: '28px 24px', textAlign: 'center', fontSize: '13px', color: 'var(--ink-muted)' }}>
        <strong>Modula Business Suite</strong> — Open Odoo.com competitor powered by SoftN v2 Containers (React 18 · PHP 8 · ZIPP WASM · XDB SQLite 3)
      </footer>
    </div>
  );
};
