import React from 'react';
import { MYOB_COMPARISON, OPAL_APPS } from '../data/opalCatalog';

interface MyobComparisonProps {
  onLaunchSlug: (slug: string) => void;
  onBackToWorkspace: () => void;
}

export const MyobComparison: React.FC<MyobComparisonProps> = ({
  onLaunchSlug,
  onBackToWorkspace,
}) => {
  return (
    <div className="compare-page">
      <div className="compare-hero">
        <div>
          <div className="hero-eyebrow">MYOB.COM.AU RESEARCH &amp; ARCHITECTURE PARITY</div>
          <h1>Everything in MYOB Business &amp; AccountRight — Modularized as Portable SoftN Apps</h1>
          <p>
            Instead of locking your ledger, payroll, and BAS history inside a proprietary cloud subscription
            ($315/yr to $210/mo), <strong>Opal Business</strong> splits the entire Australian business stack into{' '}
            <strong>8 sandboxed full-stack <code>.softn</code> apps</strong> (React 18 + PHP 8 + XDB SQLite 3)
            hosted inside your own parent application. Run zero-server in the browser via{' '}
            <strong>ZIPP WASM</strong>, or point any module at standalone PHP 8 hosting with zero code changes.
          </p>
        </div>
        <div className="compare-hero-actions">
          <button className="host-btn host-btn-primary" onClick={onBackToWorkspace}>
            Return to Business Workspace
          </button>
          <button className="host-btn host-btn-opal" onClick={() => onLaunchSlug('sales')}>
            Launch Sales &amp; Invoicing
          </button>
        </div>
      </div>

      <section className="compare-pillars">
        <div className="pillar-card">
          <div className="pillar-badge">Zero Server Default</div>
          <h3>ZIPP PHP 8 + XDB SQLite 3 in Browser</h3>
          <p>
            Each SoftN module executes real PHP 8 PDO scripts inside an isolated <code>zipp-php.wasm</code>{' '}
            WebAssembly Worker backed by IndexedDB-persisted XDB SQLite 3. Works offline inside your parent app.
          </p>
        </div>
        <div className="pillar-card">
          <div className="pillar-badge pillar-badge-teal">Standalone PHP Ready</div>
          <h3>Identical PHP Backend on Any Server</h3>
          <p>
            When hosted externally on <code>php -S</code>, Apache, or <code>softn-host-php</code>, the exact same{' '}
            <code>backend/index.php</code> switches to WAL SQLite 3 automatically with zero rewrites.
          </p>
        </div>
        <div className="pillar-card">
          <div className="pillar-badge pillar-badge-violet">100% Australian Built</div>
          <h3>GST, AI BAS, Stage 3 PAYG &amp; 12% Super</h3>
          <p>
            Native ABR Mod-89 ABN validation, ATO BAS labels (G1–G11, 1A, 1B, W1, W2), STP Phase 2
            disaggregated pay runs, 12% Superannuation Guarantee, TPAR contractors, and Premier Multi-Currency FX.
          </p>
        </div>
      </section>

      <section className="host-card">
        <div className="host-card-head">
          <div>
            <h2>MYOB Business Australia Plans vs Opal Business on SoftN</h2>
            <p className="host-muted">Mapped directly from www.myob.com.au product tiers (Solo, Business Lite, Business Pro, AccountRight Plus &amp; Premier).</p>
          </div>
        </div>
        <div className="compare-table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th>Capability</th>
                <th>MYOB Solo</th>
                <th>Business Lite</th>
                <th>Business Pro</th>
                <th>AccountRight Plus</th>
                <th>AccountRight Premier</th>
                <th className="opal-col">Opal Business (SoftN)</th>
                <th>Open App</th>
              </tr>
            </thead>
            <tbody>
              {MYOB_COMPARISON.map((row) => (
                <tr key={row.capability}>
                  <td className="cap-cell">{row.capability}</td>
                  <td>{row.myobSolo}</td>
                  <td>{row.myobLite}</td>
                  <td>{row.myobPro}</td>
                  <td>{row.arPlus}</td>
                  <td>{row.arPremier}</td>
                  <td className="opal-col-cell">{row.opalSoftn}</td>
                  <td>
                    {row.opalModule !== 'All 8 Apps' ? (
                      <button
                        className="mini-launch-btn"
                        onClick={() => onLaunchSlug(row.opalModule)}
                      >
                        Open
                      </button>
                    ) : (
                      <span className="pill-included">All 8</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="host-card">
        <div className="host-card-head">
          <div>
            <h2>The 8 Portable <code>.softn</code> Containers in Opal Business</h2>
            <p className="host-muted">Every app is a self-contained React 18 + PHP 8 + XDB SQLite archive you can embed, export, or deploy independently.</p>
          </div>
        </div>
        <div className="compare-apps-grid">
          {OPAL_APPS.map((app) => (
            <div key={app.id} className="compare-app-card">
              <div className="compare-app-top">
                <div className="app-chip-icon" style={{ background: app.gradient }}>{app.abbr}</div>
                <div>
                  <div className="compare-app-title">{app.name}</div>
                  <div className="compare-app-sub">{app.bundleFile} · {app.myobTierParity}</div>
                </div>
              </div>
              <ul className="compare-list">
                {app.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              <div className="compare-app-foot">
                <span className="tables-tag">{app.tables.length} SQLite tables</span>
                <button className="mini-launch-btn" onClick={() => onLaunchSlug(app.slug)}>
                  Launch Container
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
