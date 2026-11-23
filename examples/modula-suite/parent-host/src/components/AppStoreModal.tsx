import { useState } from 'react';
import { CORE_APPS, DEPARTMENTS, type DepartmentId, type ModulaAppDef } from '../data/suiteCatalog';

interface AppStoreModalProps {
  open: boolean;
  installedIds: string[];
  onClose: () => void;
  onLaunch: (app: ModulaAppDef) => void;
  onInstall: (app: ModulaAppDef) => void;
  onUninstall: (app: ModulaAppDef) => void;
  onTriggerUpload: () => void;
}

export function AppStoreModal({
  open,
  installedIds,
  onClose,
  onLaunch,
  onInstall,
  onUninstall,
  onTriggerUpload,
}: AppStoreModalProps) {
  const [dept, setDept] = useState<'all' | DepartmentId>('all');
  const [search, setSearch] = useState('');

  if (!open) return null;

  const q = search.trim().toLowerCase();
  const visible = CORE_APPS.filter((a) => {
    const matchDept = dept === 'all' || a.department === dept;
    const matchQ =
      !q ||
      a.name.toLowerCase().includes(q) ||
      a.tagline.toLowerCase().includes(q) ||
      a.odooEquivalents.some((o) => o.toLowerCase().includes(q));
    return matchDept && matchQ;
  });

  return (
    <div className="store-backdrop" onClick={onClose}>
      <div className="store-modal" onClick={(e) => e.stopPropagation()}>
        <div className="store-head">
          <div>
            <h2 style={{ margin: 0, fontSize: '18px' }}>Modula App Store &amp; Container Manager</h2>
            <div style={{ fontSize: '12.5px', color: 'var(--ink-muted)' }}>
              {CORE_APPS.length} portable React + PHP 8 + XDB SQLite <code>.softn</code> apps — install, launch, or sideload custom bundles.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="hbtn hbtn-sm" onClick={onTriggerUpload}>
              Upload .softn File
            </button>
            <button type="button" className="hbtn hbtn-sm" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="store-body">
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              <button type="button" className={`dept-pill ${dept === 'all' ? 'active' : ''}`} style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => setDept('all')}>
                All ({CORE_APPS.length})
              </button>
              {DEPARTMENTS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`dept-pill ${dept === d.id ? 'active' : ''}`}
                  style={{ padding: '4px 10px', fontSize: '12px' }}
                  onClick={() => setDept(d.id)}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              placeholder="Search modules..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '6px 10px', fontSize: '13px', minWidth: '185px' }}
            />
          </div>

          <div className="store-grid">
            {visible.map((app) => {
              const installed = installedIds.includes(app.id);
              return (
                <div key={app.id} className="store-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div className="app-tile-icon" style={{ background: app.color, width: '38px', height: '38px', fontSize: '13px', borderRadius: '10px' }}>
                      {app.iconText}
                    </div>
                    <div>
                      <strong style={{ fontSize: '14px' }}>{app.name}</strong>
                      <div style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>{app.bundleFile}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: '12.5px', color: 'var(--ink-secondary)', flex: 1 }}>{app.tagline}</div>
                  <div style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
                    SQLite tables: <code>{app.tables.join(', ')}</code>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button type="button" className="hbtn hbtn-sm hbtn-primary" style={{ flex: 1 }} onClick={() => onLaunch(app)}>
                      Launch
                    </button>
                    {installed ? (
                      <button type="button" className="hbtn hbtn-sm" onClick={() => onUninstall(app)}>Remove</button>
                    ) : (
                      <button type="button" className="hbtn hbtn-sm hbtn-teal" onClick={() => onInstall(app)}>Install</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
