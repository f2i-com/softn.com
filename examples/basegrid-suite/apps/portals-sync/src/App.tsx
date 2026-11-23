import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatDateShort, formatNumber, getPillTheme } from '../../../shared/ui/format';
import {
  IconCheck,
  IconClose,
  IconEye,
  IconGlobe,
  IconPlus,
  IconShield,
  IconSync,
} from '../../../shared/ui/icons';

interface Portal {
  id: number;
  name: string;
  slug: string;
  brand_color: string;
  welcome_text: string;
  domain_label: string;
  is_active: boolean;
  created_at: string;
}

interface PortalGuest {
  id: number;
  portal_id: number;
  name: string;
  email: string;
  company: string;
  role: string;
  created_at: string;
}

interface PortalDeliverable {
  id: number;
  portal_id: number;
  title: string;
  milestone: string;
  status: string;
  due_date: string;
  client_approved: boolean;
  client_feedback: string;
  updated_at: string;
}

interface SyncSource {
  id: number;
  name: string;
  provider: string;
  direction: string;
  verified: boolean;
  scale_tier: string;
  records_synced: number;
  status: string;
  last_synced_at: string;
}

interface SyncRun {
  id: number;
  source_id: number;
  source_name: string;
  rows_added: number;
  rows_updated: number;
  duration_ms: number;
  status: string;
  created_at: string;
}

interface RbacPolicy {
  id: number;
  role_name: string;
  can_edit_schema: boolean;
  can_edit_records: boolean;
  can_comment: boolean;
  can_export_csv: boolean;
  can_manage_portals: boolean;
}

interface GovernanceFlags {
  saml_sso: boolean;
  scim_groups: boolean;
  app_sandbox: boolean;
  dlp_guard: boolean;
  data_residency: string;
}

interface AuditLog {
  id: number;
  actor: string;
  category: string;
  action: string;
  target: string;
  created_at: string;
}

export const App: React.FC = () => {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [tab, setTab] = useState<'portals' | 'sync' | 'governance'>('portals');
  const [portals, setPortals] = useState<Portal[]>([]);
  const [guests, setGuests] = useState<PortalGuest[]>([]);
  const [deliverables, setDeliverables] = useState<PortalDeliverable[]>([]);
  const [sources, setSources] = useState<SyncSource[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);
  const [policies, setPolicies] = useState<RbacPolicy[]>([]);
  const [governance, setGovernance] = useState<GovernanceFlags>({
    saml_sso: true,
    scim_groups: true,
    app_sandbox: true,
    dlp_guard: true,
    data_residency: 'Australia (ap-southeast-2)',
  });
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  const [activePortalId, setActivePortalId] = useState<number>(1);
  const [guestPreviewMode, setGuestPreviewMode] = useState(false);
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<number, string>>({});

  // Modals
  const [showNewPortal, setShowNewPortal] = useState(false);
  const [showInviteGuest, setShowInviteGuest] = useState(false);
  const [showAddSync, setShowAddSync] = useState(false);
  const [pName, setPName] = useState('');
  const [pColor, setPColor] = useState('#2563eb');
  const [gName, setGName] = useState('');
  const [gEmail, setGEmail] = useState('');
  const [gRole, setGRole] = useState('Commenter');
  const [sName, setSName] = useState('');
  const [sProvider, setSProvider] = useState('GitHub');
  const [sDir, setSDir] = useState('Two-Way');

  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((p) => (p === msg ? null : p)), 3000);
  }, []);

  const loadState = useCallback(async () => {
    const [rt, data] = await Promise.all([
      apiFetch<RuntimeInfo>('/api/runtime'),
      apiFetch<{
        portals: Portal[];
        guests: PortalGuest[];
        deliverables: PortalDeliverable[];
        sources: SyncSource[];
        syncRuns: SyncRun[];
        policies: RbacPolicy[];
        governance: GovernanceFlags;
        auditLogs: AuditLog[];
      }>('/api/state'),
    ]);
    setRuntime(rt);
    setPortals(data.portals);
    setGuests(data.guests);
    setDeliverables(data.deliverables);
    setSources(data.sources);
    setSyncRuns(data.syncRuns);
    setPolicies(data.policies);
    setGovernance(data.governance);
    setAuditLogs(data.auditLogs);
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const activePortal = portals.find((p) => p.id === activePortalId) ?? portals[0] ?? null;
  const portalGuests = guests.filter((g) => g.portal_id === activePortal?.id);
  const portalDelivs = deliverables.filter((d) => d.portal_id === activePortal?.id);

  const handleCreatePortal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pName.trim()) return;
    const res = await apiFetch<{ portal: { id: number; name: string } }>('/api/portals', {
      method: 'POST',
      body: { name: pName.trim(), brand_color: pColor },
    });
    setShowNewPortal(false);
    setPName('');
    await loadState();
    setActivePortalId(res.portal.id);
    notify(`Created portal "${res.portal.name}"`);
  };

  const handleInviteGuest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePortal || !gName.trim() || !gEmail.trim()) return;
    await apiFetch(`/api/portals/${activePortal.id}/guests`, {
      method: 'POST',
      body: { name: gName.trim(), email: gEmail.trim(), role: gRole },
    });
    setShowInviteGuest(false);
    setGName('');
    setGEmail('');
    await loadState();
    notify(`Invited ${gEmail.trim()} ($0 external guest fee!)`);
  };

  const handleApproveDeliverable = async (d: PortalDeliverable, feedback?: string) => {
    await apiFetch(`/api/deliverables/${d.id}`, {
      method: 'PATCH',
      body: {
        client_approved: true,
        client_feedback: feedback !== undefined ? feedback : d.client_feedback,
        actor: portalGuests[0]?.name ? `${portalGuests[0].name} (Guest)` : 'External Guest',
      },
    });
    await loadState();
    notify(`Approved "${d.title}" & logged to Audit Trail`);
  };

  const handleSyncSource = async (src: SyncSource) => {
    const res = await apiFetch<{ run: { rows_added: number; rows_updated: number; duration_ms: number } }>(
      `/api/sync-sources/${src.id}/sync`,
      { method: 'POST', body: {} }
    );
    await loadState();
    notify(`Synced ${src.name}: +${res.run.rows_added} added, ${res.run.rows_updated} updated (${res.run.duration_ms}ms)`);
  };

  const handleAddSync = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sName.trim()) return;
    await apiFetch('/api/sync-sources', {
      method: 'POST',
      body: { name: sName.trim(), provider: sProvider, direction: sDir },
    });
    setShowAddSync(false);
    setSName('');
    await loadState();
    notify(`Added ${sDir} sync connector`);
  };

  const handleTogglePolicy = async (pol: RbacPolicy, key: keyof Omit<RbacPolicy, 'id' | 'role_name'>) => {
    const next = { ...pol, [key]: !pol[key] };
    setPolicies((prev) => prev.map((p) => (p.id === pol.id ? next : p)));
    await apiFetch(`/api/rbac/${pol.id}`, { method: 'PATCH', body: next });
    await loadState();
    notify(`Updated RBAC policy for ${pol.role_name}`);
  };

  const handleUpdateGov = async (patch: Partial<GovernanceFlags>) => {
    const next = { ...governance, ...patch };
    setGovernance(next);
    await apiFetch('/api/governance', { method: 'PATCH', body: next });
    await loadState();
    notify('Saved enterprise governance policy');
  };

  const totalSyncedRows = sources.reduce((sum, s) => sum + s.records_synced, 0);

  return (
    <div className="bg-shell">
      <header className="bg-topbar">
        <div className="bg-topbar-left">
          <div className="bg-brand">
            <div className="bg-brand-badge" style={{ background: '#0d9488' }}>
              <IconGlobe size={15} />
            </div>
            <div>
              <div className="bg-brand-title">Portals, Connected Sync &amp; Governance</div>
              <div className="bg-brand-sub">Unlimited guest portals, two-way HyperDB sync &amp; RBAC audit trails</div>
            </div>
          </div>

          <div className="bg-segmented">
            <button type="button" className={`bg-seg-btn ${tab === 'portals' ? 'active' : ''}`} onClick={() => setTab('portals')}>
              <IconGlobe size={13} /> External Portals ({portals.length})
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'sync' ? 'active' : ''}`} onClick={() => setTab('sync')}>
              <IconSync size={13} /> Connected Sync ({sources.length})
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'governance' ? 'active' : ''}`} onClick={() => setTab('governance')}>
              <IconShield size={13} /> Governance &amp; Audit ({auditLogs.length})
            </button>
          </div>
        </div>

        <div className="bg-topbar-right">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP 8 + XDB' : 'Standalone PHP'}
            </span>
          )}
        </div>
      </header>

      <div className="bg-body">
        {/* TAB 1: WHITE-LABEL EXTERNAL PORTALS */}
        {tab === 'portals' && (
          <>
            <aside className="bg-rail">
              <div className="bg-rail-section">
                <div className="bg-rail-label">
                  <span>White-Label Portals</span>
                  <span>{portals.length}</span>
                </div>
                {portals.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`bg-rail-item ${activePortal?.id === p.id ? 'active' : ''}`}
                    onClick={() => setActivePortalId(p.id)}
                  >
                    <span style={{ width: 9, height: 9, borderRadius: 99, background: p.brand_color, flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  </button>
                ))}
              </div>
              <div className="bg-rail-section" style={{ borderTop: '1px solid var(--rail-border)' }}>
                <button type="button" className="bg-rail-item" onClick={() => setShowNewPortal(true)}>
                  <IconPlus size={13} /> Create New Portal
                </button>
              </div>
            </aside>

            <main className="bg-content">
              {activePortal && (
                <>
                  <div className="view-toolbar">
                    <div className="view-toolbar-group">
                      <strong style={{ fontSize: 15 }}>{activePortal.name}</strong>
                      <span className="pill mono" style={{ background: '#f1f5f9', color: '#475569' }}>
                        https://{activePortal.domain_label}
                      </span>
                    </div>
                    <div className="view-toolbar-group">
                      <button type="button" className="btn btn-sm" onClick={() => setShowInviteGuest(true)}>
                        <IconPlus size={13} /> Invite Guest ($0)
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${guestPreviewMode ? 'btn-accent' : 'btn-primary'}`}
                        onClick={() => setGuestPreviewMode((v) => !v)}
                      >
                        <IconEye size={13} /> {guestPreviewMode ? 'Exit Guest Preview' : 'Preview as External Guest'}
                      </button>
                    </div>
                  </div>

                  <div className="bg-scroll-page">
                    <div className="bg-scroll-inner" style={{ maxWidth: 1080 }}>
                      {/* Branded Guest Portal Header Banner */}
                      <div
                        className="card"
                        style={{
                          overflow: 'hidden',
                          borderColor: guestPreviewMode ? activePortal.brand_color : 'var(--border)',
                          boxShadow: guestPreviewMode ? 'var(--shadow-md)' : 'var(--shadow-xs)',
                        }}
                      >
                        <div style={{ background: activePortal.brand_color, color: '#ffffff', padding: '22px 24px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                            <span className="pill" style={{ background: 'rgba(255,255,255,0.2)', color: '#ffffff' }}>
                              {guestPreviewMode
                                ? `Signed in as External Guest: ${portalGuests[0]?.email || 'guest@client.example'}`
                                : 'White-Label Portal Branding'}
                            </span>
                            <span style={{ fontSize: 12, opacity: 0.9 }}>{portalGuests.length} authorized guests · $0/mo add-on fee</span>
                          </div>
                          <h2 style={{ margin: '10px 0 4px', fontSize: 21 }}>{activePortal.name}</h2>
                          <p style={{ margin: 0, fontSize: 13.5, opacity: 0.92 }}>{activePortal.welcome_text}</p>
                        </div>

                        <div className="card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                          <strong style={{ fontSize: 14 }}>Scoped Client Deliverables ({portalDelivs.length})</strong>
                          {portalDelivs.map((d) => {
                            const pt = getPillTheme(d.status);
                            return (
                              <div key={d.id} className="card card-pad" style={{ background: '#fafaf9', display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                                  <div>
                                    <strong style={{ fontSize: 14 }}>{d.title}</strong>
                                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                                      {d.milestone} · Due {formatDateShort(d.due_date)}
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span className="pill" style={{ background: pt.bg, color: pt.fg }}>{d.status}</span>
                                    {!d.client_approved && (
                                      <button
                                        type="button"
                                        className="btn btn-sm btn-accent"
                                        onClick={() => void handleApproveDeliverable(d, feedbackDrafts[d.id])}
                                      >
                                        <IconCheck size={13} /> Approve Deliverable
                                      </button>
                                    )}
                                  </div>
                                </div>

                                <div style={{ display: 'flex', gap: 8 }}>
                                  <input
                                    className="input"
                                    style={{ flex: 1 }}
                                    placeholder="Add client sign-off comment..."
                                    value={feedbackDrafts[d.id] ?? d.client_feedback}
                                    onChange={(e) => setFeedbackDrafts((prev) => ({ ...prev, [d.id]: e.target.value }))}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    onClick={() =>
                                      void apiFetch(`/api/deliverables/${d.id}`, {
                                        method: 'PATCH',
                                        body: {
                                          client_feedback: feedbackDrafts[d.id] ?? d.client_feedback,
                                          actor: portalGuests[0]?.name ? `${portalGuests[0].name} (Guest)` : 'Guest',
                                        },
                                      }).then(() => {
                                        void loadState();
                                        notify('Saved guest comment');
                                      })
                                    }
                                  >
                                    Save Note
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {!guestPreviewMode && (
                        <div className="card">
                          <div className="card-header">
                            <span className="card-title">Authorized External Guests ({portalGuests.length})</span>
                            <button type="button" className="btn btn-xs btn-soft" onClick={() => setShowInviteGuest(true)}>
                              + Invite Guest
                            </button>
                          </div>
                          <table className="bg-grid-table" style={{ width: '100%' }}>
                            <thead>
                              <tr>
                                <th>Guest Name</th>
                                <th>Email</th>
                                <th>Company</th>
                                <th>Portal Access Role</th>
                                <th>Added</th>
                              </tr>
                            </thead>
                            <tbody>
                              {portalGuests.map((g) => {
                                const pt = getPillTheme(g.role);
                                return (
                                  <tr key={g.id}>
                                    <td style={{ padding: '9px 12px', fontWeight: 650 }}>{g.name}</td>
                                    <td style={{ padding: '9px 12px' }}>{g.email}</td>
                                    <td style={{ padding: '9px 12px' }}>{g.company}</td>
                                    <td style={{ padding: '9px 12px' }}>
                                      <span className="pill" style={{ background: pt.bg, color: pt.fg }}>{g.role}</span>
                                    </td>
                                    <td style={{ padding: '9px 12px', color: 'var(--ink-muted)' }}>{g.created_at}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </main>
          </>
        )}

        {/* TAB 2: CONNECTED DATA, TWO-WAY SYNC & HYPERDB */}
        {tab === 'sync' && (
          <main className="bg-content">
            <div className="bg-scroll-page">
              <div className="bg-scroll-inner">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 19 }}>Connected Data, Two-Way Sync &amp; HyperDB Scale</h2>
                    <span style={{ fontSize: 13, color: 'var(--ink-secondary)' }}>
                      {formatNumber(totalSyncedRows)} verified records synchronized across bases, SaaS tools &amp; enterprise warehouses.
                    </span>
                  </div>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowAddSync(true)}>
                    <IconPlus size={13} /> Add Sync Source
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 14 }}>
                  {sources.map((src) => {
                    const dirPill = getPillTheme(src.direction === 'Two-Way' ? 'In Progress' : 'Beta');
                    return (
                      <div key={src.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <div>
                            <strong style={{ fontSize: 14.5 }}>{src.name}</strong>
                            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
                              Provider: <strong>{src.provider}</strong> · Tier: {src.scale_tier}
                            </div>
                          </div>
                          <span className="pill" style={{ background: dirPill.bg, color: dirPill.fg }}>{src.direction}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', padding: '10px 12px', borderRadius: 8 }}>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--ink-muted)' }}>Synced Records</div>
                            <strong style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{formatNumber(src.records_synced)}</strong>
                          </div>
                          <button type="button" className="btn btn-sm btn-soft" onClick={() => void handleSyncSource(src)}>
                            <IconSync size={13} /> Sync Now
                          </button>
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', display: 'flex', justifyContent: 'space-between' }}>
                          <span>{src.verified ? '✓ Verified Dataset' : 'Unverified'}</span>
                          <span>Last sync: {src.last_synced_at}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="card">
                  <div className="card-header">
                    <span className="card-title">Sync Execution Log ({syncRuns.length})</span>
                  </div>
                  <table className="bg-grid-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Added</th>
                        <th>Updated</th>
                        <th>Duration</th>
                        <th>Status</th>
                        <th>Timestamp</th>
                      </tr>
                    </thead>
                    <tbody>
                      {syncRuns.map((r) => (
                        <tr key={r.id}>
                          <td style={{ padding: '9px 12px', fontWeight: 650 }}>{r.source_name}</td>
                          <td style={{ padding: '9px 12px', color: '#15803d', fontWeight: 650 }}>+{formatNumber(r.rows_added)}</td>
                          <td style={{ padding: '9px 12px' }}>{formatNumber(r.rows_updated)}</td>
                          <td style={{ padding: '9px 12px' }}>{r.duration_ms}ms</td>
                          <td style={{ padding: '9px 12px' }}>
                            <span className="pill" style={{ background: '#dcfce7', color: '#15803d' }}>{r.status}</span>
                          </td>
                          <td style={{ padding: '9px 12px', color: 'var(--ink-muted)' }}>{r.created_at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </main>
        )}

        {/* TAB 3: GOVERNANCE, RBAC & AUDIT LOG */}
        {tab === 'governance' && (
          <main className="bg-content">
            <div className="bg-scroll-page">
              <div className="bg-scroll-inner">
                <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 16 }}>
                  <div className="card">
                    <div className="card-header">
                      <span className="card-title">Role-Based Access Control (RBAC) Matrix</span>
                    </div>
                    <table className="bg-grid-table" style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th style={{ textAlign: 'center' }}>Schema</th>
                          <th style={{ textAlign: 'center' }}>Records</th>
                          <th style={{ textAlign: 'center' }}>Comment</th>
                          <th style={{ textAlign: 'center' }}>CSV Export</th>
                          <th style={{ textAlign: 'center' }}>Portals</th>
                        </tr>
                      </thead>
                      <tbody>
                        {policies.map((pol) => (
                          <tr key={pol.id}>
                            <td style={{ padding: '9px 12px', fontWeight: 700 }}>{pol.role_name}</td>
                            {(['can_edit_schema', 'can_edit_records', 'can_comment', 'can_export_csv', 'can_manage_portals'] as const).map((k) => (
                              <td key={k} style={{ textAlign: 'center', padding: '9px 8px' }}>
                                <input
                                  type="checkbox"
                                  checked={pol[k]}
                                  onChange={() => void handleTogglePolicy(pol, k)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <strong style={{ fontSize: 15 }}>Enterprise Trust &amp; Data Residency</strong>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span>SAML 2.0 Single Sign-On (SSO)</span>
                      <input type="checkbox" checked={governance.saml_sso} onChange={() => void handleUpdateGov({ saml_sso: !governance.saml_sso })} />
                    </label>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span>SCIM Provisioning &amp; IdP-Synced Groups</span>
                      <input type="checkbox" checked={governance.scim_groups} onChange={() => void handleUpdateGov({ scim_groups: !governance.scim_groups })} />
                    </label>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span>ZIPP Safe-Sandbox Container Isolation</span>
                      <input type="checkbox" checked={governance.app_sandbox} onChange={() => void handleUpdateGov({ app_sandbox: !governance.app_sandbox })} />
                    </label>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span>Data Loss Prevention (DLP) Export Guard</span>
                      <input type="checkbox" checked={governance.dlp_guard} onChange={() => void handleUpdateGov({ dlp_guard: !governance.dlp_guard })} />
                    </label>
                    <label className="field-label">
                      Primary Data Residency Region
                      <select
                        className="select"
                        value={governance.data_residency}
                        onChange={(e) => void handleUpdateGov({ data_residency: e.target.value })}
                      >
                        <option value="Australia (ap-southeast-2)">Australia (ap-southeast-2)</option>
                        <option value="European Union (eu-central-1)">European Union (eu-central-1)</option>
                        <option value="United States (us-east-1)">United States (us-east-1)</option>
                        <option value="Local On-Premise / Browser XDB">Local On-Premise / Browser XDB (100% Sovereign)</option>
                      </select>
                    </label>
                  </div>
                </div>

                <div className="card">
                  <div className="card-header">
                    <span className="card-title">Immutable Security &amp; Activity Audit Trail ({auditLogs.length})</span>
                  </div>
                  <table className="bg-grid-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Category</th>
                        <th>Actor</th>
                        <th>Action</th>
                        <th>Target</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.map((log) => {
                        const pt = getPillTheme(log.category);
                        return (
                          <tr key={log.id}>
                            <td style={{ padding: '9px 12px', color: 'var(--ink-muted)', fontSize: 12 }}>{log.created_at}</td>
                            <td style={{ padding: '9px 12px' }}>
                              <span className="pill" style={{ background: pt.bg, color: pt.fg }}>{log.category}</span>
                            </td>
                            <td style={{ padding: '9px 12px', fontWeight: 650 }}>{log.actor}</td>
                            <td style={{ padding: '9px 12px' }}>{log.action}</td>
                            <td style={{ padding: '9px 12px', color: 'var(--ink-secondary)' }}>{log.target}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </main>
        )}
      </div>

      {/* Modals */}
      {showNewPortal && (
        <div className="modal-backdrop" onClick={() => setShowNewPortal(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreatePortal(e)}>
            <div className="modal-head">
              <strong>Create White-Label External Portal</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowNewPortal(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Portal Name
                <input className="input" required placeholder="e.g. Acme Client Review Portal" value={pName} onChange={(e) => setPName(e.target.value)} />
              </label>
              <label className="field-label">
                Brand Accent Color
                <div style={{ display: 'flex', gap: 8 }}>
                  {['#2563eb', '#6d28d9', '#0d9488', '#ea580c', '#db2777', '#111827'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setPColor(c)}
                      style={{ width: 28, height: 28, borderRadius: 7, background: c, border: pColor === c ? '3px solid #111827' : 'none', cursor: 'pointer' }}
                    />
                  ))}
                </div>
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowNewPortal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create Portal</button>
            </div>
          </form>
        </div>
      )}

      {showInviteGuest && (
        <div className="modal-backdrop" onClick={() => setShowInviteGuest(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleInviteGuest(e)}>
            <div className="modal-head">
              <strong>Invite External Portal Guest ($0 Fee)</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowInviteGuest(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Guest Full Name
                <input className="input" required placeholder="Claire Bennett" value={gName} onChange={(e) => setGName(e.target.value)} />
              </label>
              <label className="field-label">
                Guest Email
                <input className="input" type="email" required placeholder="claire@client.example" value={gEmail} onChange={(e) => setGEmail(e.target.value)} />
              </label>
              <label className="field-label">
                Access Role
                <select className="select" value={gRole} onChange={(e) => setGRole(e.target.value)}>
                  <option value="Viewer">Viewer (Read-only)</option>
                  <option value="Commenter">Commenter &amp; Approver</option>
                  <option value="Editor">Editor (Scoped Records)</option>
                </select>
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowInviteGuest(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Send Portal Invite</button>
            </div>
          </form>
        </div>
      )}

      {showAddSync && (
        <div className="modal-backdrop" onClick={() => setShowAddSync(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleAddSync(e)}>
            <div className="modal-head">
              <strong>Add Connected Sync Source</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowAddSync(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Sync Table Name
                <input className="input" required placeholder="e.g. GitHub Release PRs" value={sName} onChange={(e) => setSName(e.target.value)} />
              </label>
              <label className="field-label">
                Provider
                <select className="select" value={sProvider} onChange={(e) => setSProvider(e.target.value)}>
                  <option value="GitHub">GitHub</option>
                  <option value="Databricks">Databricks (HyperDB)</option>
                  <option value="Snowflake">Snowflake (HyperDB)</option>
                  <option value="Jira">Jira Cloud</option>
                  <option value="Salesforce">Salesforce</option>
                  <option value="Zendesk">Zendesk</option>
                  <option value="Google Calendar">Google Calendar</option>
                </select>
              </label>
              <label className="field-label">
                Sync Direction
                <select className="select" value={sDir} onChange={(e) => setSDir(e.target.value)}>
                  <option value="Two-Way">Two-Way Sync</option>
                  <option value="One-Way">One-Way Mirror</option>
                </select>
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowAddSync(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Connect Source</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
