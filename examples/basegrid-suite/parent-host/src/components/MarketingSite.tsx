import React, { useState } from 'react';
import {
  AIRTABLE_PARITY_MAP,
  BASEGRID_APPS,
  CATEGORIES,
  type CapabilityCategory,
} from '../data/suiteCatalog';

interface MarketingSiteProps {
  onLaunchWorkspace: (appId?: string) => void;
}

function fmtUsd(amount: number): string {
  return '$' + Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const MarketingSite: React.FC<MarketingSiteProps> = ({ onLaunchWorkspace }) => {
  const [selectedCat, setSelectedCat] = useState<'all' | CapabilityCategory>('all');
  const [seatCount, setSeatCount] = useState(35);
  const [tier, setTier] = useState<'team' | 'business'>('business');
  const [includePortals, setIncludePortals] = useState(true);
  const [activePillar, setActivePillar] = useState(0);

  // Published Airtable annual-billed list pricing ($20 Team / $45 Business + $120-$150/mo Portals add-on)
  const perSeat = tier === 'team' ? 20 : 45;
  const portalMonthly = includePortals ? (tier === 'team' ? 120 : 150) : 0;
  const airtableAnnual = (seatCount * perSeat + portalMonthly) * 12;
  const airtableThreeYear = airtableAnnual * 3;

  const visibleParity =
    selectedCat === 'all'
      ? AIRTABLE_PARITY_MAP
      : AIRTABLE_PARITY_MAP.filter((m) => m.category === selectedCat);

  const PILLARS = [
    {
      num: '01',
      title: 'Relational Bases & 7 Views',
      subtitle: 'Grid, Kanban, Calendar, Gallery, Timeline/Gantt, List & Inbox on one XDB SQLite core.',
      bg: '#fff1e6',
      accent: '#ea580c',
      appId: 'basegrid.bases',
      cta: 'Open Bases & Views Studio →',
      previewRows: [
        { name: 'Helios Robotics', badge: 'Tier 1', stage: 'Series C', metric: '$42M ARR', risk: 'Low Risk' },
        { name: 'Northstar Media', badge: 'Tier 1', stage: 'Enterprise', metric: '$128M ARR', risk: 'Migration' },
        { name: 'Vanguard Retail', badge: 'Tier 1', stage: 'Enterprise', metric: '$210M ARR', risk: 'High Risk' },
      ],
    },
    {
      num: '02',
      title: 'Interfaces, Forms & Pivots',
      subtitle: 'Turn tables into executive dashboards, SVG charts, conditional intake forms & cross-tab pivots.',
      bg: '#f3eeff',
      accent: '#6d28d9',
      appId: 'basegrid.interfaces',
      cta: 'Open Interface Designer →',
      previewRows: [
        { name: 'Executive Portfolio', badge: 'Public Link', stage: 'Executive', metric: '$3.77M ARR', risk: 'Approved' },
        { name: 'Product Intake Form', badge: 'Conditional', stage: 'Live Form', metric: '6 fields', risk: 'Open' },
        { name: 'Cross-Tab Pivot', badge: 'Heatmap', stage: 'Operations', metric: 'Dept × Status', risk: 'Live' },
      ],
    },
    {
      num: '03',
      title: 'Omni AI, Field Agents & Automations',
      subtitle: 'Build bases from prompts, run autonomous column agents locally & fire unlimited PHP automations.',
      bg: '#eaf5ff',
      accent: '#0284c7',
      appId: 'basegrid.ai-omni',
      cta: 'Open Omni AI & Agents →',
      previewRows: [
        { name: 'Omni Architect', badge: 'AI Plays', stage: '3 Tables', metric: 'Undo Ready', risk: 'Local NLP' },
        { name: 'Column Field Agents', badge: '4 Columns', stage: 'Zero Retention', metric: '95% Conf.', risk: 'Active' },
        { name: 'Workflow Engine', badge: 'Paused Guard', stage: 'SQLite Tx', metric: 'Unlimited Runs', risk: 'Succeeded' },
      ],
    },
    {
      num: '04',
      title: 'Portals, Two-Way Sync & Governance',
      subtitle: 'White-label client portals ($0 guest fees), HyperDB warehouse sync, RBAC & immutable audit logs.',
      bg: '#e7faf5',
      accent: '#0d9488',
      appId: 'basegrid.portals-sync',
      cta: 'Open Portals & Sync →',
      previewRows: [
        { name: 'Northstar Portal', badge: '$0 Guest Fee', stage: 'White-Label', metric: 'Live Preview', risk: 'Active' },
        { name: 'Snowflake HyperDB', badge: '100M Scale', stage: 'Verified', metric: '4.82M rows', risk: 'Synced' },
        { name: 'RBAC & Audit Trail', badge: 'SAML + SCIM', stage: 'AU / EU / Local', metric: 'Immutable', risk: 'Enforced' },
      ],
    },
  ];

  const curPillar = PILLARS[activePillar];

  return (
    <div className="site-wrap">
      {/* Top Announcement Strip (Airtable-inspired) */}
      <div className="promo-bar">
        <span>
          <strong>BaseGrid on SoftN v2:</strong> 6 modular React 18 + PHP 8 + XDB SQLite apps running locally in ZIPP WASM — or standalone PHP with zero code changes.
        </span>
        <button type="button" className="promo-link" onClick={() => onLaunchWorkspace('basegrid.bases')}>
          Launch live workspace →
        </button>
      </div>

      {/* Primary Header */}
      <header className="site-nav">
        <div className="site-nav-inner">
          <button type="button" className="brand-mark" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <span className="brand-logo" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <rect x="2" y="2" width="11" height="11" rx="3" fill="#2563eb" />
                <rect x="15" y="2" width="11" height="11" rx="3" fill="#f97316" />
                <rect x="2" y="15" width="11" height="11" rx="3" fill="#0d9488" />
                <rect x="15" y="15" width="11" height="11" rx="3" fill="#6d28d9" />
              </svg>
            </span>
            <span>BaseGrid</span>
            <span className="brand-sub-pill">SoftN Suite</span>
          </button>

          <nav className="nav-links" aria-label="Primary navigation">
            <a href="#platform">Platform</a>
            <a href="#parity">vs Airtable ({AIRTABLE_PARITY_MAP.length})</a>
            <a href="#pricing">Pricing Savings</a>
            <a href="#architecture">Dual-Mode PHP</a>
          </nav>

          <div className="nav-cta">
            <button type="button" className="hbtn" onClick={() => onLaunchWorkspace()}>
              Workspace Home
            </button>
            <button id="launch-workspace-cta" type="button" className="hbtn hbtn-dark" onClick={() => onLaunchWorkspace('basegrid.bases')}>
              Launch Live Suite →
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="hero">
        <div className="hero-eyebrow">
          <span>Open Airtable Alternative</span>
          <span>·</span>
          <strong>6 Portable React + PHP 8 + XDB SQLite .softn Apps</strong>
        </div>

        <h1>
          All your bases, workflows &amp; AI agents—
          <span className="hero-accent">embedded inside your own app.</span>
        </h1>

        <p className="hero-sub">
          BaseGrid recreates Airtable&apos;s relational spreadsheet-database, 7 interactive views, Interface Designer,
          conditional Forms, Automations, Omni Field Agents, and White-Label Portals as modular{' '}
          <strong>.softn containers</strong>. Each app runs <strong>React 18 + PHP 8 + XDB SQLite 3</strong> locally
          inside <strong>ZIPP WASM</strong> — or connects straight to standalone native PHP hosting with zero code edits.
        </p>

        <div className="hero-actions">
          <button type="button" className="hbtn hbtn-dark hbtn-lg" onClick={() => onLaunchWorkspace('basegrid.bases')}>
            Open Live Parent Workspace →
          </button>
          <button type="button" className="hbtn hbtn-lg" onClick={() => onLaunchWorkspace()}>
            Explore All 6 .softn Apps
          </button>
        </div>

        {/* Interactive 6-App Container Dock */}
        <div className="hero-dock">
          <div className="hero-dock-label">
            Click any modular SoftN app below to boot its isolated React + PHP + XDB SQLite container inside the Parent Workspace
          </div>
          <div className="app-tile-grid">
            {BASEGRID_APPS.map((app) => (
              <button
                key={app.id}
                type="button"
                className="app-tile"
                data-launch-app={app.slug}
                onClick={() => onLaunchWorkspace(app.id)}
              >
                <div className="app-tile-top">
                  <div className="app-tile-icon" style={{ background: app.color }}>
                    {app.iconText}
                  </div>
                  <span className="app-tile-bundle">{app.bundleFile}</span>
                </div>
                <div className="app-tile-name">{app.name}</div>
                <div className="app-tile-sub">{app.tagline}</div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 4-Stage Airtable-Inspired Pastel Showcase */}
      <section id="platform" className="section">
        <div className="section-head">
          <h2>Four Pillars of Modern Connected Data — 100% Portable</h2>
          <p>
            Every core capability showcased on <code>airtable.com</code> is implemented as a real, interactive,
            SQLite-persisted SoftN container you can embed inside your own parent application.
          </p>
        </div>

        <div className="pillar-tabs">
          {PILLARS.map((p, i) => (
            <button
              key={p.num}
              type="button"
              className={`pillar-tab ${activePillar === i ? 'active' : ''}`}
              onClick={() => setActivePillar(i)}
            >
              <span className="pillar-num">{p.num}</span>
              <span>{p.title}</span>
            </button>
          ))}
        </div>

        <div className="pastel-stage" style={{ background: curPillar.bg }}>
          <div className="pastel-stage-info">
            <span className="stage-num-pill" style={{ background: curPillar.accent }}>
              {curPillar.num} · Live Container
            </span>
            <h3>{curPillar.title}</h3>
            <p>{curPillar.subtitle}</p>
            <div>
              <button
                type="button"
                className="hbtn hbtn-dark"
                onClick={() => onLaunchWorkspace(curPillar.appId)}
              >
                {curPillar.cta}
              </button>
            </div>
          </div>

          <div className="stage-mockup">
            <div className="stage-mock-rail">
              <div className="mock-dot-row">
                <span /><span /><span />
              </div>
              <div className="mock-rail-item active">Active Workspace</div>
              <div className="mock-rail-item">Saved Views</div>
              <div className="mock-rail-item">XDB SQLite 3</div>
              <div className="mock-rail-item">ZIPP PHP 8</div>
            </div>
            <div className="stage-mock-main">
              <div className="mock-head-row">
                <strong>{curPillar.title}</strong>
                <span className="mock-live-tag">● Live SQLite</span>
              </div>
              {curPillar.previewRows.map((row) => (
                <div key={row.name} className="mock-data-row">
                  <strong>{row.name}</strong>
                  <span className="mock-pill">{row.badge}</span>
                  <span className="mock-muted">{row.stage}</span>
                  <strong className="mock-metric">{row.metric}</strong>
                  <span className="mock-pill-soft">{row.risk}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Complete Airtable.com Capability Parity Map */}
      <section id="parity" className="section">
        <div className="section-head">
          <h2>Complete Airtable.com Capability Parity Map</h2>
          <p>
            Every major feature across Airtable&apos;s Free, Team, Business, and Enterprise Scale tiers mapped directly
            to a running BaseGrid <code>.softn</code> app.
          </p>
        </div>

        <div className="dept-pills">
          <button
            type="button"
            className={`dept-pill ${selectedCat === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedCat('all')}
          >
            All Capabilities ({AIRTABLE_PARITY_MAP.length})
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`dept-pill ${selectedCat === c.id ? 'active' : ''}`}
              onClick={() => setSelectedCat(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="parity-grid">
          {visibleParity.map((item) => (
            <div key={item.airtableFeature} className="parity-card">
              <div className="parity-top">
                <strong style={{ fontSize: 15 }}>{item.airtableFeature}</strong>
                <span className="pill-live">Live .softn</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
                <span style={{ fontWeight: 700, color: '#2563eb' }}>→ {item.baseGridTarget}</span>
                <span style={{ color: 'var(--ink-muted)' }}>Airtable: {item.airtableTier}</span>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-secondary)', flex: 1, lineHeight: 1.5 }}>
                {item.notes}
              </div>
              <div>
                <button
                  type="button"
                  className="hbtn hbtn-sm hbtn-dark"
                  onClick={() => onLaunchWorkspace(item.launchAppId)}
                >
                  Launch Container →
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing Savings Calculator */}
      <section id="pricing" className="section">
        <div className="section-head">
          <h2>Escape Per-Seat &amp; Portals Add-On Lock-In</h2>
          <p>
            Airtable charges <strong>$20–$45/editor/month</strong> plus <strong>$120–$150+/mo for Portals</strong> and
            metered AI credit packs, while capping records and monthly automation runs. BaseGrid runs in your own
            parent app or PHP host with <strong>$0 per-seat fees</strong> and full SQLite ownership.
          </p>
        </div>

        <div className="calc-box">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <strong>Active Editors / Collaborators</strong>
                <strong style={{ color: '#2563eb', fontSize: 18 }}>{seatCount} seats</strong>
              </div>
              <input
                type="range"
                min={5}
                max={250}
                step={5}
                value={seatCount}
                onChange={(e) => setSeatCount(Number(e.target.value))}
                style={{ width: '100%', accentColor: '#2563eb' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-muted)' }}>
                <span>5 seats</span><span>75</span><span>150</span><span>250 seats</span>
              </div>
            </div>

            <div>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Compare Against Airtable Plan</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`hbtn ${tier === 'team' ? 'hbtn-dark' : ''}`}
                  onClick={() => setTier('team')}
                >
                  Airtable Team ($20/seat/mo)
                </button>
                <button
                  type="button"
                  className={`hbtn ${tier === 'business' ? 'hbtn-dark' : ''}`}
                  onClick={() => setTier('business')}
                >
                  Airtable Business ($45/seat/mo)
                </button>
              </div>
            </div>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={includePortals}
                onChange={(e) => setIncludePortals(e.target.checked)}
              />
              Include External Portals Add-on (+${tier === 'team' ? 120 : 150}/mo)
            </label>
          </div>

          <div className="calc-stat-grid">
            <div className="calc-stat">
              <div className="calc-label">Airtable Annual Cost</div>
              <div className="calc-num" style={{ color: '#dc2626' }}>{fmtUsd(airtableAnnual)}/yr</div>
              <div className="calc-sub">{fmtUsd(airtableThreeYear)} over 3 years</div>
            </div>
            <div className="calc-stat" style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>
              <div className="calc-label" style={{ color: '#15803d' }}>BaseGrid on SoftN</div>
              <div className="calc-num" style={{ color: '#059669' }}>$0/seat</div>
              <div className="calc-sub" style={{ color: '#15803d', fontWeight: 600 }}>
                Save {fmtUsd(airtableThreeYear)} over 3 years
              </div>
            </div>
            <div className="calc-stat" style={{ gridColumn: '1 / -1', background: '#fafaf9' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ fontSize: 13, color: 'var(--ink-secondary)' }}>
                  <strong>Included out of the box:</strong> Unlimited bases, Gantt/Timeline, Interface Designer,
                  unlimited automations, local Field Agents, White-Label Portals &amp; portable SQLite <code>.db</code> exports.
                </div>
                <button type="button" className="hbtn hbtn-dark" onClick={() => onLaunchWorkspace('basegrid.bases')}>
                  Start Building Now →
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Dual-Mode Architecture */}
      <section id="architecture" className="section">
        <div className="section-head">
          <h2>Same PHP 8 + XDB SQLite Code — Embedded in ZIPP or Standalone PHP</h2>
          <p>
            Every BaseGrid app ships as a single self-contained <code>.softn</code> archive designed to be mounted
            internally inside your parent application, while scaling transparently to standalone PHP servers.
          </p>
        </div>

        <div className="arch-grid">
          <div className="arch-card" style={{ borderTop: '3px solid #059669' }}>
            <span className="pill-live">Default Embedded Mode (Zero Server)</span>
            <h3>In-Browser ZIPP PHP 8 WASM + XDB SQLite 3</h3>
            <p>
              When mounted inside your Parent Application via <code>mountSoftNContainer()</code>, each app&apos;s React
              UI runs inside <code>zipp-javascript-lite.wasm</code> while every <code>fetch(&apos;/api/...&apos;)</code>{' '}
              routes directly to <code>backend/index.php</code> inside an isolated <code>zipp-php.wasm</code> Worker
              persisted to IndexedDB via <code>xdb-wasm.wasm</code>.
            </p>
          </div>
          <div className="arch-card" style={{ borderTop: '3px solid #2563eb' }}>
            <span className="pill-blue">Optional Multi-User Server Mode</span>
            <h3>Standalone Native PHP 8 + WAL SQLite</h3>
            <p>
              Ready to host an app by itself or share one multi-user database across a company? Point{' '}
              <code>backendUrl</code> at <code>php -S</code>, Apache, Nginx+FPM, or <code>softn-host-php</code>{' '}
              (run <code>node examples/basegrid-suite/serve-php.mjs</code>) and the exact same PHP backend switches
              automatically to a WAL SQLite file with zero code edits.
            </p>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="site-footer-inner">
          <strong>BaseGrid — Open Airtable Alternative on SoftN v2 Web Containers</strong>
          <span>React 18 · PHP 8 (ZIPP WASM / Standalone) · XDB SQLite 3 · Closed Shadow DOM Sandbox</span>
        </div>
      </footer>
    </div>
  );
};
