import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatCompactMoney, formatMoney, formatPercent, getPillTheme } from '../../../shared/ui/format';
import {
  IconChart,
  IconCheck,
  IconClose,
  IconEye,
  IconGlobe,
  IconLayers,
  IconPlus,
  IconTrash,
} from '../../../shared/ui/icons';

interface InterfacePage {
  id: number;
  name: string;
  description: string;
  audience: string;
  accent_color: string;
  is_public: boolean;
  created_at: string;
}

interface WidgetConfig {
  groupBy?: 'department' | 'status' | 'quarter' | 'priority';
  metric?: 'count' | 'budget' | 'projected_arr';
  rowField?: 'department' | 'quarter' | 'priority';
  colField?: 'status' | 'priority' | 'quarter';
}

interface InterfaceWidget {
  id: number;
  page_id: number;
  widget_type: 'kpi_strip' | 'bar_chart' | 'donut_chart' | 'record_review' | 'pivot_table';
  title: string;
  span: 'half' | 'full';
  config: WidgetConfig;
  position: number;
}

interface PortfolioRecord {
  id: number;
  title: string;
  department: string;
  status: string;
  quarter: string;
  owner_name: string;
  budget: number;
  projected_arr: number;
  progress: number;
  approved: boolean;
  priority: string;
  summary: string;
  updated_at: string;
}

const CHART_COLORS = ['#2563eb', '#7c3aed', '#0d9488', '#ea580c', '#db2777', '#059669', '#d97706'];

function aggregate(records: PortfolioRecord[], groupBy: string, metric: string): Array<{ label: string; value: number }> {
  const map = new Map<string, number>();
  for (const r of records) {
    const key = String((r as unknown as Record<string, unknown>)[groupBy] ?? 'Other');
    const inc = metric === 'budget' ? r.budget : metric === 'projected_arr' ? r.projected_arr : 1;
    map.set(key, (map.get(key) ?? 0) + inc);
  }
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

export const App: React.FC = () => {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [pages, setPages] = useState<InterfacePage[]>([]);
  const [widgets, setWidgets] = useState<InterfaceWidget[]>([]);
  const [records, setRecords] = useState<PortfolioRecord[]>([]);
  const [activePageId, setActivePageId] = useState<number>(1);
  const [editMode, setEditMode] = useState(false);
  const [roleView, setRoleView] = useState<'Executive' | 'Editor' | 'Public Read-Only'>('Executive');
  const [deptFilter, setDeptFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [selectedRecordId, setSelectedRecordId] = useState<number>(1);
  const [showNewPage, setShowNewPage] = useState(false);
  const [showAddWidget, setShowAddWidget] = useState(false);
  const [newPageName, setNewPageName] = useState('');
  const [newPageAudience, setNewPageAudience] = useState('Executive');
  const [newWidgetType, setNewWidgetType] = useState<InterfaceWidget['widget_type']>('bar_chart');
  const [newWidgetTitle, setNewWidgetTitle] = useState('ARR by Department');
  const [newWidgetGroup, setNewWidgetGroup] = useState<'department' | 'status' | 'quarter' | 'priority'>('department');
  const [newWidgetMetric, setNewWidgetMetric] = useState<'count' | 'budget' | 'projected_arr'>('projected_arr');
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((p) => (p === msg ? null : p)), 2600);
  }, []);

  const loadState = useCallback(async () => {
    const [rt, data] = await Promise.all([
      apiFetch<RuntimeInfo>('/api/runtime'),
      apiFetch<{ pages: InterfacePage[]; widgets: InterfaceWidget[]; records: PortfolioRecord[] }>('/api/state'),
    ]);
    setRuntime(rt);
    setPages(data.pages);
    setWidgets(data.widgets);
    setRecords(data.records);
    if (data.records.length > 0) {
      setSelectedRecordId((prev) => (data.records.some((r) => r.id === prev) ? prev : data.records[0].id));
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0] ?? null;
  const pageWidgets = useMemo(
    () => widgets.filter((w) => w.page_id === activePage?.id).sort((a, b) => a.position - b.position),
    [widgets, activePage]
  );

  const departments = useMemo(() => ['All', ...Array.from(new Set(records.map((r) => r.department)))], [records]);
  const statuses = useMemo(() => ['All', ...Array.from(new Set(records.map((r) => r.status)))], [records]);

  const filteredRecords = useMemo(
    () =>
      records.filter(
        (r) =>
          (deptFilter === 'All' || r.department === deptFilter) &&
          (statusFilter === 'All' || r.status === statusFilter)
      ),
    [records, deptFilter, statusFilter]
  );

  const selectedRecord = filteredRecords.find((r) => r.id === selectedRecordId) ?? filteredRecords[0] ?? null;
  const canMutate = roleView !== 'Public Read-Only';

  const handlePatchRecord = async (id: number, patch: Partial<PortfolioRecord>) => {
    if (!canMutate) {
      notify('Public Read-Only role cannot modify records.');
      return;
    }
    const res = await apiFetch<{ record: PortfolioRecord }>(`/api/records/${id}`, {
      method: 'PATCH',
      body: patch,
    });
    setRecords((prev) => prev.map((r) => (r.id === id ? res.record : r)));
    notify(`Updated "${res.record.title}" in XDB SQLite`);
  };

  const handleCreatePage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPageName.trim()) return;
    const res = await apiFetch<{ page: { id: number; name: string } }>('/api/pages', {
      method: 'POST',
      body: { name: newPageName.trim(), audience: newPageAudience, accent_color: '#2563eb' },
    });
    await loadState();
    setActivePageId(res.page.id);
    setShowNewPage(false);
    setNewPageName('');
    notify(`Created interface "${res.page.name}"`);
  };

  const handleAddWidget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePage) return;
    await apiFetch(`/api/pages/${activePage.id}/widgets`, {
      method: 'POST',
      body: {
        widget_type: newWidgetType,
        title: newWidgetTitle.trim() || 'Dashboard Block',
        span: newWidgetType === 'kpi_strip' || newWidgetType === 'pivot_table' || newWidgetType === 'record_review' ? 'full' : 'half',
        config: {
          groupBy: newWidgetGroup,
          metric: newWidgetMetric,
          rowField: 'department',
          colField: 'status',
        },
      },
    });
    await loadState();
    setShowAddWidget(false);
    notify('Added widget to Interface');
  };

  const handleToggleSpan = async (w: InterfaceWidget) => {
    const nextSpan = w.span === 'full' ? 'half' : 'full';
    await apiFetch(`/api/widgets/${w.id}`, { method: 'PATCH', body: { span: nextSpan } });
    setWidgets((prev) => prev.map((x) => (x.id === w.id ? { ...x, span: nextSpan } : x)));
  };

  const handleDeleteWidget = async (id: number) => {
    await apiFetch(`/api/widgets/${id}`, { method: 'DELETE' });
    setWidgets((prev) => prev.filter((x) => x.id !== id));
    notify('Removed widget');
  };

  const handleUpdatePivot = async (w: InterfaceWidget, patch: Partial<WidgetConfig>) => {
    const nextCfg = { ...w.config, ...patch };
    setWidgets((prev) => prev.map((x) => (x.id === w.id ? { ...x, config: nextCfg } : x)));
    await apiFetch(`/api/widgets/${w.id}`, { method: 'PATCH', body: { config: nextCfg } });
  };

  const handleTogglePublic = async () => {
    if (!activePage) return;
    const next = !activePage.is_public;
    await apiFetch(`/api/pages/${activePage.id}`, { method: 'PATCH', body: { is_public: next } });
    setPages((prev) => prev.map((p) => (p.id === activePage.id ? { ...p, is_public: next } : p)));
    notify(next ? 'Enabled public read-only interface link' : 'Restricted interface to workspace members');
  };

  const totalBudget = filteredRecords.reduce((s, r) => s + r.budget, 0);
  const totalArr = filteredRecords.reduce((s, r) => s + r.projected_arr, 0);
  const avgProgress = filteredRecords.length
    ? Math.round(filteredRecords.reduce((s, r) => s + r.progress, 0) / filteredRecords.length)
    : 0;
  const approvedCount = filteredRecords.filter((r) => r.approved).length;
  const atRiskCount = filteredRecords.filter((r) => r.status === 'At Risk').length;

  return (
    <div className="bg-shell">
      <header className="bg-topbar">
        <div className="bg-topbar-left">
          <div className="bg-brand">
            <div className="bg-brand-badge" style={{ background: activePage?.accent_color || '#6d28d9' }}>
              <IconChart size={15} />
            </div>
            <div>
              <div className="bg-brand-title">Interface Designer &amp; Reporting</div>
              <div className="bg-brand-sub">Role-specific dashboards, SVG charts &amp; live pivot tables</div>
            </div>
          </div>
        </div>

        <div className="bg-topbar-right">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP 8 + XDB' : 'Standalone PHP'}
            </span>
          )}
          <select
            aria-label="Preview role"
            className="select"
            style={{ padding: '5px 9px', fontSize: 12.5, fontWeight: 600 }}
            value={roleView}
            onChange={(e) => setRoleView(e.target.value as typeof roleView)}
          >
            <option value="Executive">Role: Executive (Full)</option>
            <option value="Editor">Role: Editor</option>
            <option value="Public Read-Only">Role: Public Read-Only</option>
          </select>
          <button
            type="button"
            className={`btn btn-sm ${editMode ? 'btn-accent' : ''}`}
            onClick={() => setEditMode((v) => !v)}
          >
            <IconLayers size={13} /> {editMode ? 'Done Editing' : 'Edit Layout'}
          </button>
          {editMode && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowAddWidget(true)}>
              <IconPlus size={13} /> Add Element
            </button>
          )}
        </div>
      </header>

      <div className="bg-body">
        <aside className="bg-rail">
          <div className="bg-rail-section">
            <div className="bg-rail-label">
              <span>Interfaces</span>
              <span>{pages.length}</span>
            </div>
            {pages.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`bg-rail-item ${activePage?.id === p.id ? 'active' : ''}`}
                onClick={() => setActivePageId(p.id)}
              >
                <span style={{ width: 9, height: 9, borderRadius: 3, background: p.accent_color, flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </button>
            ))}
          </div>

          <div className="bg-rail-section" style={{ borderTop: '1px solid var(--rail-border)' }}>
            <button type="button" className="bg-rail-item" onClick={() => setShowNewPage(true)}>
              <IconPlus size={14} /> New Interface Page
            </button>
          </div>

          {activePage && (
            <div className="bg-rail-section" style={{ marginTop: 'auto', borderTop: '1px solid var(--rail-border)', fontSize: 12 }}>
              <div style={{ padding: '6px 8px', color: 'var(--rail-muted)' }}>
                <div style={{ fontWeight: 700, color: '#fff', marginBottom: 4 }}>Sharing &amp; Permissions</div>
                <div>Audience: {activePage.audience}</div>
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-xs"
                    style={{ width: '100%', background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'rgba(255,255,255,0.2)' }}
                    onClick={() => void handleTogglePublic()}
                  >
                    <IconGlobe size={12} /> {activePage.is_public ? 'Public Link: ON' : 'Public Link: OFF'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </aside>

        <main className="bg-content">
          {/* Global Live Interface Filter Bar */}
          <div className="view-toolbar">
            <div className="view-toolbar-group">
              <strong style={{ fontSize: 15 }}>{activePage?.name}</strong>
              <span className="pill" style={{ background: '#ede9fe', color: '#6d28d9' }}>
                {activePage?.audience}
              </span>
              {roleView === 'Public Read-Only' && (
                <span className="pill" style={{ background: '#fef3c7', color: '#b45309' }}>
                  <IconEye size={11} /> Read-Only Preview
                </span>
              )}
            </div>
            <div className="view-toolbar-group">
              <select className="select" style={{ padding: '4.5px 9px', fontSize: 12.5 }} value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
                {departments.map((d) => <option key={d} value={d}>Dept: {d}</option>)}
              </select>
              <select className="select" style={{ padding: '4.5px 9px', fontSize: 12.5 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                {statuses.map((s) => <option key={s} value={s}>Status: {s}</option>)}
              </select>
              {(deptFilter !== 'All' || statusFilter !== 'All') && (
                <button type="button" className="btn btn-xs btn-ghost" onClick={() => { setDeptFilter('All'); setStatusFilter('All'); }}>
                  Reset filters
                </button>
              )}
            </div>
          </div>

          <div className="bg-scroll-page">
            <div className="bg-scroll-inner">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 16 }}>
                {pageWidgets.map((w) => {
                  const colSpan = w.span === 'full' ? 'span 12' : 'span 6';
                  return (
                    <div
                      key={w.id}
                      className="card"
                      style={{
                        gridColumn: colSpan,
                        outline: editMode ? '2px dashed #93c5fd' : 'none',
                      }}
                    >
                      <div className="card-header">
                        <span className="card-title">{w.title}</span>
                        {editMode && (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button type="button" className="btn btn-xs" onClick={() => void handleToggleSpan(w)}>
                              Width: {w.span === 'full' ? 'Full → Half' : 'Half → Full'}
                            </button>
                            <button type="button" className="btn btn-xs btn-danger" onClick={() => void handleDeleteWidget(w.id)}>
                              <IconTrash size={12} />
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="card-pad">
                        {/* KPI STRIP */}
                        {w.widget_type === 'kpi_strip' && (
                          <div className="kpi-grid">
                            <div className="kpi-card" style={{ background: 'linear-gradient(180deg,#ffffff,#faf5ff)' }}>
                              <span className="kpi-label">Projected ARR Impact</span>
                              <span className="kpi-value" style={{ color: '#6d28d9' }}>{formatCompactMoney(totalArr)}</span>
                              <span className="kpi-sub">Across {filteredRecords.length} initiatives</span>
                            </div>
                            <div className="kpi-card">
                              <span className="kpi-label">Allocated Budget</span>
                              <span className="kpi-value">{formatCompactMoney(totalBudget)}</span>
                              <span className="kpi-sub">ROI multiple: {totalBudget > 0 ? (totalArr / totalBudget).toFixed(1) : '0.0'}x</span>
                            </div>
                            <div className="kpi-card">
                              <span className="kpi-label">Avg Delivery Progress</span>
                              <span className="kpi-value" style={{ color: '#059669' }}>{formatPercent(avgProgress)}</span>
                              <div style={{ height: 6, background: '#e5e7eb', borderRadius: 99, overflow: 'hidden', marginTop: 2 }}>
                                <div style={{ width: `${avgProgress}%`, height: '100%', background: '#059669' }} />
                              </div>
                            </div>
                            <div className="kpi-card">
                              <span className="kpi-label">Exec Approvals &amp; Risks</span>
                              <span className="kpi-value">{approvedCount}/{filteredRecords.length}</span>
                              <span className="kpi-sub" style={{ color: atRiskCount > 0 ? '#dc2626' : '#059669', fontWeight: 600 }}>
                                {atRiskCount > 0 ? `${atRiskCount} initiative flagged At Risk` : 'All initiatives on track'}
                              </span>
                            </div>
                          </div>
                        )}

                        {/* BAR CHART */}
                        {w.widget_type === 'bar_chart' && (() => {
                          const groupBy = w.config.groupBy ?? 'department';
                          const metric = w.config.metric ?? 'budget';
                          const data = aggregate(filteredRecords, groupBy, metric);
                          const maxVal = Math.max(1, ...data.map((d) => d.value));
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                              {data.map((d, i) => {
                                const pct = Math.max(4, Math.round((d.value / maxVal) * 100));
                                return (
                                  <div key={d.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                                      <strong>{d.label}</strong>
                                      <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                                        {metric === 'count' ? `${d.value} items` : formatCompactMoney(d.value)}
                                      </span>
                                    </div>
                                    <div style={{ height: 12, background: '#f1f5f9', borderRadius: 99, overflow: 'hidden' }}>
                                      <div
                                        style={{
                                          width: `${pct}%`,
                                          height: '100%',
                                          borderRadius: 99,
                                          background: CHART_COLORS[i % CHART_COLORS.length],
                                          transition: 'width 0.25s ease',
                                        }}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}

                        {/* DONUT CHART */}
                        {w.widget_type === 'donut_chart' && (() => {
                          const groupBy = w.config.groupBy ?? 'status';
                          const metric = w.config.metric ?? 'count';
                          const data = aggregate(filteredRecords, groupBy, metric);
                          const sum = Math.max(1, data.reduce((s, d) => s + d.value, 0));
                          const radius = 58;
                          const circ = 2 * Math.PI * radius;
                          let offset = 0;

                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
                              <svg width="156" height="156" viewBox="0 0 156 156">
                                <g transform="rotate(-90 78 78)">
                                  {data.map((d, i) => {
                                    const frac = d.value / sum;
                                    const dash = frac * circ;
                                    const curOff = offset;
                                    offset += dash;
                                    return (
                                      <circle
                                        key={d.label}
                                        cx="78"
                                        cy="78"
                                        r={radius}
                                        fill="none"
                                        stroke={CHART_COLORS[i % CHART_COLORS.length]}
                                        strokeWidth="22"
                                        strokeDasharray={`${dash} ${circ - dash}`}
                                        strokeDashoffset={-curOff}
                                      />
                                    );
                                  })}
                                </g>
                                <text x="78" y="75" textAnchor="middle" fontSize="22" fontWeight="800" fill="#111827">
                                  {filteredRecords.length}
                                </text>
                                <text x="78" y="94" textAnchor="middle" fontSize="11" fontWeight="600" fill="#6b7280">
                                  RECORDS
                                </text>
                              </svg>

                              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 160 }}>
                                {data.map((d, i) => (
                                  <div key={d.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                      <span style={{ width: 10, height: 10, borderRadius: 3, background: CHART_COLORS[i % CHART_COLORS.length] }} />
                                      <strong>{d.label}</strong>
                                    </span>
                                    <span style={{ color: 'var(--ink-muted)', fontWeight: 650 }}>
                                      {d.value} ({Math.round((d.value / sum) * 100)}%)
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}

                        {/* RECORD PICKER + LIVE ACTION BUTTONS */}
                        {w.widget_type === 'record_review' && (
                          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) minmax(0, 1fr)', gap: 16 }}>
                            <div style={{ border: '1px solid var(--border)', borderRadius: 9, maxHeight: 330, overflowY: 'auto' }}>
                              {filteredRecords.map((r) => {
                                const pt = getPillTheme(r.status);
                                const active = selectedRecord?.id === r.id;
                                return (
                                  <button
                                    key={r.id}
                                    type="button"
                                    onClick={() => setSelectedRecordId(r.id)}
                                    style={{
                                      width: '100%',
                                      textAlign: 'left',
                                      border: 'none',
                                      borderBottom: '1px solid var(--border-subtle)',
                                      background: active ? '#eff6ff' : '#ffffff',
                                      padding: '10px 12px',
                                      cursor: 'pointer',
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 4,
                                    }}
                                  >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                                      <strong style={{ fontSize: 13 }}>{r.title}</strong>
                                      <span className="pill" style={{ background: pt.bg, color: pt.fg, fontSize: 10.5 }}>{r.status}</span>
                                    </div>
                                    <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>
                                      {r.department} · {r.owner_name} · {formatCompactMoney(r.projected_arr)} ARR
                                    </span>
                                  </button>
                                );
                              })}
                            </div>

                            {selectedRecord && (
                              <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 18, background: '#fafaf9', display: 'flex', flexDirection: 'column', gap: 14 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                                  <div>
                                    <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-muted)' }}>
                                      {selectedRecord.department} · {selectedRecord.quarter} · Owner: {selectedRecord.owner_name}
                                    </div>
                                    <h3 style={{ margin: '3px 0 0', fontSize: 18, letterSpacing: '-0.02em' }}>{selectedRecord.title}</h3>
                                  </div>
                                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                    <button
                                      type="button"
                                      disabled={!canMutate}
                                      className="btn btn-sm btn-accent"
                                      onClick={() => void handlePatchRecord(selectedRecord.id, { approved: true, status: selectedRecord.status === 'At Risk' ? 'In Progress' : selectedRecord.status })}
                                    >
                                      <IconCheck size={13} /> {selectedRecord.approved ? 'Approved ✓' : 'Approve Initiative'}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={!canMutate}
                                      className="btn btn-sm"
                                      onClick={() => void handlePatchRecord(selectedRecord.id, { status: 'Launched', progress: 100, approved: true })}
                                    >
                                      Mark Launched
                                    </button>
                                    <button
                                      type="button"
                                      disabled={!canMutate}
                                      className="btn btn-sm btn-danger"
                                      onClick={() => void handlePatchRecord(selectedRecord.id, { status: 'At Risk' })}
                                    >
                                      Flag At Risk
                                    </button>
                                  </div>
                                </div>

                                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-secondary)', lineHeight: 1.55 }}>
                                  {selectedRecord.summary}
                                </p>

                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                                  <div className="card card-pad" style={{ padding: 12 }}>
                                    <div className="kpi-label">Budget</div>
                                    <strong style={{ fontSize: 17 }}>{formatMoney(selectedRecord.budget)}</strong>
                                  </div>
                                  <div className="card card-pad" style={{ padding: 12 }}>
                                    <div className="kpi-label">Projected ARR</div>
                                    <strong style={{ fontSize: 17, color: '#6d28d9' }}>{formatMoney(selectedRecord.projected_arr)}</strong>
                                  </div>
                                  <div className="card card-pad" style={{ padding: 12 }}>
                                    <div className="kpi-label">Delivery Progress ({selectedRecord.progress}%)</div>
                                    <input
                                      type="range"
                                      min={0}
                                      max={100}
                                      disabled={!canMutate}
                                      value={selectedRecord.progress}
                                      onChange={(e) => void handlePatchRecord(selectedRecord.id, { progress: Number(e.target.value) })}
                                      style={{ width: '100%', accentColor: '#2563eb' }}
                                    />
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* INTERACTIVE PIVOT TABLE EXTENSION */}
                        {w.widget_type === 'pivot_table' && (() => {
                          const rowField = w.config.rowField ?? 'department';
                          const colField = w.config.colField ?? 'status';
                          const metric = w.config.metric ?? 'projected_arr';
                          const rowKeys = Array.from(new Set(filteredRecords.map((r) => String((r as unknown as Record<string, unknown>)[rowField]))));
                          const colKeys = Array.from(new Set(filteredRecords.map((r) => String((r as unknown as Record<string, unknown>)[colField]))));
                          const matrix = new Map<string, number>();
                          let maxCell = 1;
                          for (const r of filteredRecords) {
                            const rk = String((r as unknown as Record<string, unknown>)[rowField]);
                            const ck = String((r as unknown as Record<string, unknown>)[colField]);
                            const k = `${rk}||${ck}`;
                            const v = (matrix.get(k) ?? 0) + (metric === 'budget' ? r.budget : metric === 'projected_arr' ? r.projected_arr : 1);
                            matrix.set(k, v);
                            if (v > maxCell) maxCell = v;
                          }

                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                                <label style={{ fontSize: 12, fontWeight: 650 }}>
                                  Rows:{' '}
                                  <select className="select" style={{ padding: '4px 8px', fontSize: 12 }} value={rowField} onChange={(e) => void handleUpdatePivot(w, { rowField: e.target.value as WidgetConfig['rowField'] })}>
                                    <option value="department">Department</option>
                                    <option value="quarter">Quarter</option>
                                    <option value="priority">Priority</option>
                                  </select>
                                </label>
                                <label style={{ fontSize: 12, fontWeight: 650 }}>
                                  Columns:{' '}
                                  <select className="select" style={{ padding: '4px 8px', fontSize: 12 }} value={colField} onChange={(e) => void handleUpdatePivot(w, { colField: e.target.value as WidgetConfig['colField'] })}>
                                    <option value="status">Status</option>
                                    <option value="priority">Priority</option>
                                    <option value="quarter">Quarter</option>
                                  </select>
                                </label>
                                <label style={{ fontSize: 12, fontWeight: 650 }}>
                                  Summary:{' '}
                                  <select className="select" style={{ padding: '4px 8px', fontSize: 12 }} value={metric} onChange={(e) => void handleUpdatePivot(w, { metric: e.target.value as WidgetConfig['metric'] })}>
                                    <option value="projected_arr">SUM Projected ARR</option>
                                    <option value="budget">SUM Budget</option>
                                    <option value="count">COUNT Records</option>
                                  </select>
                                </label>
                              </div>

                              <div style={{ overflowX: 'auto' }}>
                                <table className="bg-grid-table" style={{ width: '100%', border: '1px solid var(--border)' }}>
                                  <thead>
                                    <tr>
                                      <th>{rowField.toUpperCase()} \ {colField.toUpperCase()}</th>
                                      {colKeys.map((ck) => <th key={ck} style={{ textAlign: 'right' }}>{ck}</th>)}
                                      <th style={{ textAlign: 'right' }}>Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {rowKeys.map((rk) => {
                                      const rowSum = colKeys.reduce((acc, ck) => acc + (matrix.get(`${rk}||${ck}`) ?? 0), 0);
                                      return (
                                        <tr key={rk}>
                                          <td style={{ padding: '9px 12px', fontWeight: 700 }}>{rk}</td>
                                          {colKeys.map((ck) => {
                                            const v = matrix.get(`${rk}||${ck}`) ?? 0;
                                            const alpha = v > 0 ? 0.08 + (v / maxCell) * 0.24 : 0;
                                            return (
                                              <td
                                                key={ck}
                                                style={{
                                                  padding: '9px 12px',
                                                  textAlign: 'right',
                                                  fontVariantNumeric: 'tabular-nums',
                                                  fontWeight: v > 0 ? 650 : 400,
                                                  background: v > 0 ? `rgba(37, 99, 235, ${alpha.toFixed(2)})` : '#ffffff',
                                                }}
                                              >
                                                {v === 0 ? '—' : metric === 'count' ? v : formatCompactMoney(v)}
                                              </td>
                                            );
                                          })}
                                          <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 800, background: '#f8fafc' }}>
                                            {metric === 'count' ? rowSum : formatCompactMoney(rowSum)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </main>
      </div>

      {showNewPage && (
        <div className="modal-backdrop" onClick={() => setShowNewPage(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreatePage(e)}>
            <div className="modal-head">
              <strong>Create Interface Page</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowNewPage(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Interface Name
                <input className="input" required placeholder="e.g. Board Quarterly Review" value={newPageName} onChange={(e) => setNewPageName(e.target.value)} />
              </label>
              <label className="field-label">
                Target Audience
                <select className="select" value={newPageAudience} onChange={(e) => setNewPageAudience(e.target.value)}>
                  <option value="Executive">Executive</option>
                  <option value="Product & Eng">Product &amp; Eng</option>
                  <option value="Sales & RevOps">Sales &amp; RevOps</option>
                  <option value="External Stakeholders">External Stakeholders</option>
                </select>
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowNewPage(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create Interface</button>
            </div>
          </form>
        </div>
      )}

      {showAddWidget && (
        <div className="modal-backdrop" onClick={() => setShowAddWidget(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleAddWidget(e)}>
            <div className="modal-head">
              <strong>Add Interface Element</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowAddWidget(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Element Title
                <input className="input" required value={newWidgetTitle} onChange={(e) => setNewWidgetTitle(e.target.value)} />
              </label>
              <label className="field-label">
                Element Type
                <select className="select" value={newWidgetType} onChange={(e) => setNewWidgetType(e.target.value as InterfaceWidget['widget_type'])}>
                  <option value="bar_chart">Bar Chart</option>
                  <option value="donut_chart">Donut Distribution Chart</option>
                  <option value="kpi_strip">Exec Summary KPI Ribbon</option>
                  <option value="pivot_table">Cross-Tab Pivot Table</option>
                  <option value="record_review">Interactive Record Picker + Actions</option>
                </select>
              </label>
              {(newWidgetType === 'bar_chart' || newWidgetType === 'donut_chart') && (
                <>
                  <label className="field-label">
                    Group Dimension
                    <select className="select" value={newWidgetGroup} onChange={(e) => setNewWidgetGroup(e.target.value as typeof newWidgetGroup)}>
                      <option value="department">Department</option>
                      <option value="status">Status</option>
                      <option value="quarter">Quarter</option>
                      <option value="priority">Priority</option>
                    </select>
                  </label>
                  <label className="field-label">
                    Metric
                    <select className="select" value={newWidgetMetric} onChange={(e) => setNewWidgetMetric(e.target.value as typeof newWidgetMetric)}>
                      <option value="projected_arr">Projected ARR ($)</option>
                      <option value="budget">Budget ($)</option>
                      <option value="count">Record Count</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowAddWidget(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Add Element</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
