import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { csvEscape, downloadTextFile } from '../../../shared/ui/format';
import {
  IconCalendar,
  IconClose,
  IconDatabase,
  IconDownload,
  IconEye,
  IconFilter,
  IconGallery,
  IconGrid,
  IconInbox,
  IconKanban,
  IconLayers,
  IconList,
  IconPlus,
  IconSearch,
  IconSort,
  IconTimeline,
  IconTrash,
  IconUpload,
} from '../../../shared/ui/icons';
import { buildWorkspaceIndex, resolveFieldValue, synthesizeAiAgentValue } from './formula';
import { CalendarView } from './components/CalendarView';
import { GalleryView } from './components/GalleryView';
import { GridView } from './components/GridView';
import { KanbanView } from './components/KanbanView';
import { InboxView, ListView } from './components/ListInboxViews';
import { RecordDrawer } from './components/RecordDrawer';
import { TimelineView } from './components/TimelineView';
import type {
  BaseSummary,
  BaseWorkspace,
  FieldMeta,
  FieldType,
  FilterRule,
  RecordRow,
  SortRule,
  ViewConfig,
  ViewMeta,
  ViewType,
} from './types';

function ViewIcon({ type, size = 14 }: { type: ViewType; size?: number }) {
  switch (type) {
    case 'kanban': return <IconKanban size={size} />;
    case 'calendar': return <IconCalendar size={size} />;
    case 'gallery': return <IconGallery size={size} />;
    case 'timeline': return <IconTimeline size={size} />;
    case 'list': return <IconList size={size} />;
    case 'inbox': return <IconInbox size={size} />;
    default: return <IconGrid size={size} />;
  }
}

export const App: React.FC = () => {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [bases, setBases] = useState<BaseSummary[]>([]);
  const [activeBaseId, setActiveBaseId] = useState<number>(1);
  const [workspace, setWorkspace] = useState<BaseWorkspace | null>(null);
  const [activeTableId, setActiveTableId] = useState<number | null>(null);
  const [activeViewId, setActiveViewId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [drawerRecordId, setDrawerRecordId] = useState<number | null>(null);

  // Popover toolbars
  const [activePanel, setActivePanel] = useState<null | 'filter' | 'sort' | 'group' | 'fields'>(null);

  // Modals
  const [modal, setModal] = useState<null | 'new-base' | 'new-table' | 'new-field' | 'new-view' | 'import-csv'>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftColor, setDraftColor] = useState('#2563eb');
  const [draftFieldType, setDraftFieldType] = useState<FieldType>('text');
  const [draftChoices, setDraftChoices] = useState('Option A, Option B, Option C');
  const [draftFormula, setDraftFormula] = useState('ROUND({Budget} * 0.15, 0)');
  const [draftTargetTableId, setDraftTargetTableId] = useState<number>(0);
  const [draftViewType, setDraftViewType] = useState<ViewType>('grid');
  const [csvInput, setCsvInput] = useState('');

  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadBases = useCallback(async () => {
    const [rt, bRes] = await Promise.all([
      apiFetch<RuntimeInfo>('/api/runtime'),
      apiFetch<{ bases: BaseSummary[] }>('/api/bases'),
    ]);
    setRuntime(rt);
    setBases(bRes.bases);
    return bRes.bases;
  }, []);

  const loadWorkspace = useCallback(async (baseId: number, keepTableId?: number | null) => {
    const ws = await apiFetch<BaseWorkspace>(`/api/bases/${baseId}/workspace`);
    setWorkspace(ws);
    const tableId =
      keepTableId && ws.tables.some((t) => t.id === keepTableId)
        ? keepTableId
        : ws.tables[0]?.id ?? null;
    setActiveTableId(tableId);
    const tableViews = ws.views.filter((v) => v.table_id === tableId);
    setActiveViewId((prev) => (prev && tableViews.some((v) => v.id === prev) ? prev : tableViews[0]?.id ?? null));
    setSelectedIds([]);
  }, []);

  useEffect(() => {
    void loadBases().then((list) => {
      const firstId = list[0]?.id ?? 1;
      setActiveBaseId(firstId);
      void loadWorkspace(firstId);
    });
  }, [loadBases, loadWorkspace]);

  const idx = useMemo(
    () => buildWorkspaceIndex(workspace?.fields ?? [], workspace?.records ?? []),
    [workspace]
  );

  const tableFields = useMemo(
    () => (workspace?.fields ?? []).filter((f) => f.table_id === activeTableId),
    [workspace, activeTableId]
  );

  const tableViews = useMemo(
    () => (workspace?.views ?? []).filter((v) => v.table_id === activeTableId),
    [workspace, activeTableId]
  );

  const activeView: ViewMeta | null = useMemo(
    () => tableViews.find((v) => v.id === activeViewId) ?? tableViews[0] ?? null,
    [tableViews, activeViewId]
  );

  const activeConfig: ViewConfig = useMemo(() => activeView?.config ?? {}, [activeView]);

  const tableRecords = useMemo(() => {
    const raw = (workspace?.records ?? []).filter((r) => r.table_id === activeTableId);
    const filters = activeConfig.filters ?? [];
    const sorts = activeConfig.sorts ?? [];
    const q = searchQuery.trim().toLowerCase();

    let list = raw.filter((rec) => {
      if (q) {
        const hit = tableFields.some((f) => {
          const val = resolveFieldValue(rec, f, idx);
          return String(val ?? '').toLowerCase().includes(q);
        });
        if (!hit) return false;
      }
      for (const rule of filters) {
        const field = tableFields.find((f) => f.id === rule.fieldId);
        if (!field) continue;
        const rawVal = resolveFieldValue(rec, field, idx);
        const strVal = Array.isArray(rawVal) ? rawVal.join(', ') : String(rawVal ?? '');
        const lower = strVal.toLowerCase();
        const target = rule.value.toLowerCase();
        if (rule.op === 'contains' && !lower.includes(target)) return false;
        if (rule.op === 'equals' && lower !== target) return false;
        if (rule.op === 'not_equals' && lower === target) return false;
        if (rule.op === 'is_empty' && strVal.trim() !== '') return false;
        if (rule.op === 'not_empty' && strVal.trim() === '') return false;
        if (rule.op === 'gt' && !(Number(rawVal) > Number(rule.value))) return false;
        if (rule.op === 'lt' && !(Number(rawVal) < Number(rule.value))) return false;
      }
      return true;
    });

    if (sorts.length > 0) {
      list = [...list].sort((a, b) => {
        for (const s of sorts) {
          const field = tableFields.find((f) => f.id === s.fieldId);
          if (!field) continue;
          const va = resolveFieldValue(a, field, idx);
          const vb = resolveFieldValue(b, field, idx);
          const na = Number(va);
          const nb = Number(vb);
          let cmp = 0;
          if (Number.isFinite(na) && Number.isFinite(nb) && String(va) !== '' && String(vb) !== '') {
            cmp = na - nb;
          } else {
            cmp = String(va ?? '').localeCompare(String(vb ?? ''));
          }
          if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }
    return list;
  }, [workspace, activeTableId, activeConfig, searchQuery, tableFields, idx]);

  const updateViewConfig = async (patch: Partial<ViewConfig>) => {
    if (!activeView) return;
    const nextCfg: ViewConfig = { ...activeConfig, ...patch };
    setWorkspace((prev) =>
      prev
        ? {
            ...prev,
            views: prev.views.map((v) => (v.id === activeView.id ? { ...v, config: nextCfg } : v)),
          }
        : prev
    );
    await apiFetch(`/api/views/${activeView.id}`, {
      method: 'PATCH',
      body: { config: nextCfg },
    });
  };

  const handlePatchCell = async (recordId: number, fieldId: number, value: unknown) => {
    const res = await apiFetch<{ record: RecordRow }>(`/api/records/${recordId}`, {
      method: 'PATCH',
      body: { cells: { [String(fieldId)]: value }, actor: 'Maya Lin' },
    });
    setWorkspace((prev) =>
      prev
        ? {
            ...prev,
            records: prev.records.map((r) => (r.id === recordId ? res.record : r)),
          }
        : prev
    );
  };

  const handleAddRecord = async (extraCells: Record<string, unknown> = {}) => {
    if (!activeTableId) return;
    const primary = tableFields.find((f) => f.is_primary);
    const cells: Record<string, unknown> = { ...extraCells };
    if (primary && !cells[String(primary.id)]) {
      cells[String(primary.id)] = `New item #${tableRecords.length + 1}`;
    }
    const res = await apiFetch<{ record: RecordRow }>(`/api/tables/${activeTableId}/records`, {
      method: 'POST',
      body: { cells, created_by: 'Maya Lin' },
    });
    setWorkspace((prev) => (prev ? { ...prev, records: [...prev.records, res.record] } : prev));
    notify('Added record to XDB SQLite');
  };

  const handleDuplicateRecord = async (recordId: number) => {
    const res = await apiFetch<{ record: RecordRow }>(`/api/records/${recordId}/duplicate`, {
      method: 'POST',
      body: {},
    });
    setWorkspace((prev) => (prev ? { ...prev, records: [...prev.records, res.record] } : prev));
    setDrawerRecordId(res.record.id);
    notify('Duplicated record');
  };

  const handleDeleteRecord = async (recordId: number) => {
    await apiFetch(`/api/records/${recordId}`, { method: 'DELETE' });
    setWorkspace((prev) =>
      prev ? { ...prev, records: prev.records.filter((r) => r.id !== recordId) } : prev
    );
    setSelectedIds((prev) => prev.filter((id) => id !== recordId));
    if (drawerRecordId === recordId) setDrawerRecordId(null);
    notify('Deleted record');
  };

  const handleBulkDelete = async () => {
    for (const id of selectedIds) {
      await apiFetch(`/api/records/${id}`, { method: 'DELETE' });
    }
    const delSet = new Set(selectedIds);
    setWorkspace((prev) =>
      prev ? { ...prev, records: prev.records.filter((r) => !delSet.has(r.id)) } : prev
    );
    setSelectedIds([]);
    notify(`Deleted ${delSet.size} records`);
  };

  const handleRunAiField = async (record: RecordRow, field: FieldMeta) => {
    const synthesized = synthesizeAiAgentValue(record, field, idx);
    await handlePatchCell(record.id, field.id, synthesized);
    notify(`AI Field Agent updated "${field.name}"`);
  };

  const handleDeleteField = async (field: FieldMeta) => {
    await apiFetch(`/api/fields/${field.id}`, { method: 'DELETE' });
    setWorkspace((prev) =>
      prev ? { ...prev, fields: prev.fields.filter((f) => f.id !== field.id) } : prev
    );
    notify(`Removed field "${field.name}"`);
  };

  const handleCreateBase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftName.trim()) return;
    const res = await apiFetch<{ base: BaseSummary }>('/api/bases', {
      method: 'POST',
      body: { name: draftName.trim(), description: draftDesc.trim(), color: draftColor },
    });
    await loadBases();
    setActiveBaseId(res.base.id);
    await loadWorkspace(res.base.id);
    setModal(null);
    setDraftName('');
    setDraftDesc('');
    notify(`Created base "${res.base.name}"`);
  };

  const handleCreateTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftName.trim()) return;
    const res = await apiFetch<{ table: { id: number; name: string } }>(`/api/bases/${activeBaseId}/tables`, {
      method: 'POST',
      body: { name: draftName.trim(), description: draftDesc.trim() },
    });
    await loadWorkspace(activeBaseId, res.table.id);
    setModal(null);
    setDraftName('');
    setDraftDesc('');
    notify(`Created table "${res.table.name}"`);
  };

  const handleCreateField = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTableId || !draftName.trim()) return;
    const options: Record<string, unknown> = {};
    if (draftFieldType === 'single_select' || draftFieldType === 'multi_select') {
      options.choices = draftChoices.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (draftFieldType === 'formula') {
      options.formula = draftFormula.trim();
    } else if (draftFieldType === 'currency') {
      options.symbol = '$';
    } else if (draftFieldType === 'rating') {
      options.max = 5;
    } else if (draftFieldType === 'link') {
      options.targetTableId = draftTargetTableId || workspace?.tables[0]?.id || activeTableId;
    } else if (draftFieldType === 'ai_agent') {
      options.prompt = `Summarize key status and actions for {${tableFields[0]?.name || 'Name'}}`;
      options.mode = 'summary';
    }
    const res = await apiFetch<{ field: FieldMeta }>(`/api/tables/${activeTableId}/fields`, {
      method: 'POST',
      body: { name: draftName.trim(), field_type: draftFieldType, options },
    });
    setWorkspace((prev) => (prev ? { ...prev, fields: [...prev.fields, res.field] } : prev));
    setModal(null);
    setDraftName('');
    notify(`Added field "${res.field.name}" (${res.field.field_type})`);
  };

  const handleCreateView = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTableId || !draftName.trim()) return;
    const defaultSelect = tableFields.find((f) => f.field_type === 'single_select');
    const defaultDates = tableFields.filter((f) => f.field_type === 'date');
    const config: ViewConfig = {
      rowHeight: 'medium',
      groupFieldId: defaultSelect?.id,
      statusFieldId: defaultSelect?.id,
      dateFieldId: defaultDates[0]?.id,
      startFieldId: defaultDates[0]?.id,
      endFieldId: defaultDates[1]?.id ?? defaultDates[0]?.id,
    };
    const res = await apiFetch<{ view: ViewMeta }>(`/api/tables/${activeTableId}/views`, {
      method: 'POST',
      body: { name: draftName.trim(), view_type: draftViewType, config },
    });
    setWorkspace((prev) => (prev ? { ...prev, views: [...prev.views, res.view] } : prev));
    setActiveViewId(res.view.id);
    setModal(null);
    setDraftName('');
    notify(`Created ${draftViewType} view "${res.view.name}"`);
  };

  const handleExportCsv = () => {
    const header = tableFields.map((f) => csvEscape(f.name)).join(',');
    const lines = tableRecords.map((rec) =>
      tableFields
        .map((f) => {
          const val = resolveFieldValue(rec, f, idx);
          return csvEscape(Array.isArray(val) ? val.join('; ') : val);
        })
        .join(',')
    );
    const tableName = workspace?.tables.find((t) => t.id === activeTableId)?.name || 'table';
    downloadTextFile(`${tableName.toLowerCase().replace(/\s+/g, '-')}.csv`, [header, ...lines].join('\n'), 'text/csv;charset=utf-8');
    notify(`Exported ${tableRecords.length} rows to CSV`);
  };

  const handleImportCsv = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTableId || !csvInput.trim()) return;
    const lines = csvInput.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      notify('Include a header row and at least one data row.');
      return;
    }
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const fieldMap = headers.map((h) => tableFields.find((f) => f.name.toLowerCase() === h) ?? null);
    const primary = tableFields.find((f) => f.is_primary);
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      const cells: Record<string, unknown> = {};
      cols.forEach((val, colIdx) => {
        const f = fieldMap[colIdx] ?? (colIdx === 0 ? primary : null);
        if (!f) return;
        cells[String(f.id)] = ['number', 'currency', 'percent'].includes(f.field_type)
          ? Number(val.replace(/[$,%\s]/g, '')) || 0
          : val;
      });
      if (Object.keys(cells).length > 0) rows.push(cells);
    }
    const res = await apiFetch<{ imported: number; records: RecordRow[] }>(`/api/tables/${activeTableId}/import-csv`, {
      method: 'POST',
      body: { rows },
    });
    setWorkspace((prev) => (prev ? { ...prev, records: [...prev.records, ...res.records] } : prev));
    setModal(null);
    setCsvInput('');
    notify(`Imported ${res.imported} records into XDB SQLite`);
  };

  const switchBase = (id: number) => {
    setActiveBaseId(id);
    setDrawerRecordId(null);
    void loadWorkspace(id);
  };

  const switchTable = (id: number) => {
    setActiveTableId(id);
    setSelectedIds([]);
    setDrawerRecordId(null);
    const views = (workspace?.views ?? []).filter((v) => v.table_id === id);
    setActiveViewId(views[0]?.id ?? null);
  };

  const defaultSelectField =
    tableFields.find((f) => f.id === activeConfig.groupFieldId) ??
    tableFields.find((f) => f.id === activeConfig.statusFieldId) ??
    tableFields.find((f) => f.field_type === 'single_select') ??
    null;
  const dateFields = tableFields.filter((f) => f.field_type === 'date');
  const primaryDateField =
    tableFields.find((f) => f.id === activeConfig.dateFieldId) ?? dateFields[0] ?? null;
  const startDateField =
    tableFields.find((f) => f.id === activeConfig.startFieldId) ?? dateFields[0] ?? null;
  const endDateField =
    tableFields.find((f) => f.id === activeConfig.endFieldId) ?? dateFields[1] ?? dateFields[0] ?? null;
  const coverField =
    tableFields.find((f) => f.id === activeConfig.coverFieldId) ??
    tableFields.find((f) => f.field_type === 'attachment') ??
    null;
  const checkField =
    tableFields.find((f) => f.id === activeConfig.checkFieldId) ??
    tableFields.find((f) => f.field_type === 'checkbox') ??
    null;

  const drawerRecord = workspace?.records.find((r) => r.id === drawerRecordId) ?? null;

  return (
    <div className="bg-shell">
      {/* Top Base Header */}
      <header className="bg-topbar">
        <div className="bg-topbar-left">
          <div className="bg-brand">
            <div className="bg-brand-badge" style={{ background: workspace?.base.color || '#6d28d9' }}>
              {workspace?.base.icon || 'BG'}
            </div>
            <div>
              <div className="bg-brand-title">{workspace?.base.name || 'BaseGrid Bases'}</div>
              <div className="bg-brand-sub">
                {workspace?.tables.length ?? 0} relational tables · {workspace?.records.length ?? 0} total records
              </div>
            </div>
          </div>

          <select
            aria-label="Switch base"
            className="select"
            value={activeBaseId}
            onChange={(e) => switchBase(Number(e.target.value))}
            style={{ fontWeight: 650, maxWidth: 220 }}
          >
            {bases.map((b) => (
              <option key={b.id} value={b.id}>
                Base: {b.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setDraftName('');
              setDraftDesc('');
              setModal('new-base');
            }}
          >
            <IconPlus size={13} /> New Base
          </button>
        </div>

        <div className="bg-topbar-right">
          {runtime && (
            <span className={`runtime-pill ${runtime.mode === 'standalone-php' ? 'standalone' : ''}`}>
              <span className="runtime-dot" />
              {runtime.mode === 'zipp-wasm' ? 'ZIPP PHP 8 + XDB SQLite' : 'Standalone PHP + WAL SQLite'}
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setCsvInput(`${tableFields[0]?.name || 'Name'},${tableFields[1]?.name || 'Status'}\nQ1 Partner Program,Planning\nCustomer Telemetry API,In Progress`);
              setModal('import-csv');
            }}
          >
            <IconUpload size={13} /> Import CSV
          </button>
          <button type="button" className="btn btn-sm" onClick={handleExportCsv}>
            <IconDownload size={13} /> Export CSV
          </button>
        </div>
      </header>

      {/* Table Tabs Bar */}
      <div className="table-tabs-bar">
        {(workspace?.tables ?? []).map((t) => {
          const count = (workspace?.records ?? []).filter((r) => r.table_id === t.id).length;
          return (
            <button
              key={t.id}
              type="button"
              className={`table-tab ${activeTableId === t.id ? 'active' : ''}`}
              onClick={() => switchTable(t.id)}
            >
              <IconDatabase size={13} />
              <span>{t.name}</span>
              <span className="table-tab-count">{count}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="table-tab"
          style={{ color: 'var(--accent)' }}
          onClick={() => {
            setDraftName('');
            setDraftDesc('');
            setModal('new-table');
          }}
        >
          <IconPlus size={13} /> Add Table
        </button>
      </div>

      {/* Main Split Workspace: Dark Views Sidebar + View Canvas */}
      <div className="bg-body">
        <aside className="bg-rail">
          <div className="bg-rail-section">
            <div className="bg-rail-label">
              <span>Saved Views</span>
              <span>{tableViews.length}</span>
            </div>
            {tableViews.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`bg-rail-item ${activeView?.id === v.id ? 'active' : ''}`}
                onClick={() => setActiveViewId(v.id)}
              >
                <ViewIcon type={v.view_type} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
              </button>
            ))}
          </div>

          <div className="bg-rail-section" style={{ borderTop: '1px solid var(--rail-border)', marginTop: 'auto' }}>
            <div className="bg-rail-label">
              <span>Create a View</span>
            </div>
            {([
              ['grid', 'Grid View'],
              ['kanban', 'Kanban Board'],
              ['calendar', 'Calendar'],
              ['gallery', 'Gallery'],
              ['timeline', 'Timeline / Gantt'],
              ['list', 'List View'],
              ['inbox', 'Review Inbox'],
            ] as Array<[ViewType, string]>).map(([vType, label]) => (
              <button
                key={vType}
                type="button"
                className="bg-rail-item"
                style={{ padding: '6px 10px', fontSize: 12.5 }}
                onClick={() => {
                  setDraftViewType(vType);
                  setDraftName(`${label} ${tableViews.length + 1}`);
                  setModal('new-view');
                }}
              >
                <ViewIcon type={vType} size={13} />
                <span>+ {label}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="bg-content">
          {/* View Control Toolbar */}
          <div className="view-toolbar">
            <div className="view-toolbar-group">
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, marginRight: 4 }}>
                {activeView && <ViewIcon type={activeView.view_type} />}
                {activeView?.name || 'Grid'}
              </strong>

              <button
                type="button"
                className={`btn btn-sm ${activePanel === 'fields' || (activeConfig.hiddenFieldIds?.length ?? 0) > 0 ? 'btn-soft' : ''}`}
                onClick={() => setActivePanel((p) => (p === 'fields' ? null : 'fields'))}
              >
                <IconEye size={13} /> Hide fields
                {(activeConfig.hiddenFieldIds?.length ?? 0) > 0 ? ` (${activeConfig.hiddenFieldIds!.length})` : ''}
              </button>

              <button
                type="button"
                className={`btn btn-sm ${activePanel === 'filter' || (activeConfig.filters?.length ?? 0) > 0 ? 'btn-soft' : ''}`}
                onClick={() => setActivePanel((p) => (p === 'filter' ? null : 'filter'))}
              >
                <IconFilter size={13} /> Filter
                {(activeConfig.filters?.length ?? 0) > 0 ? ` (${activeConfig.filters!.length})` : ''}
              </button>

              <button
                type="button"
                className={`btn btn-sm ${activePanel === 'group' || activeConfig.groupBy ? 'btn-soft' : ''}`}
                onClick={() => setActivePanel((p) => (p === 'group' ? null : 'group'))}
              >
                <IconLayers size={13} /> Group
              </button>

              <button
                type="button"
                className={`btn btn-sm ${activePanel === 'sort' || (activeConfig.sorts?.length ?? 0) > 0 ? 'btn-soft' : ''}`}
                onClick={() => setActivePanel((p) => (p === 'sort' ? null : 'sort'))}
              >
                <IconSort size={13} /> Sort
                {(activeConfig.sorts?.length ?? 0) > 0 ? ` (${activeConfig.sorts!.length})` : ''}
              </button>

              {activeView?.view_type === 'grid' && (
                <select
                  aria-label="Row height"
                  className="select"
                  style={{ padding: '4.5px 8px', fontSize: 12 }}
                  value={activeConfig.rowHeight ?? 'medium'}
                  onChange={(e) =>
                    void updateViewConfig({ rowHeight: e.target.value as 'compact' | 'medium' | 'tall' })
                  }
                >
                  <option value="compact">Row: Compact</option>
                  <option value="medium">Row: Medium</option>
                  <option value="tall">Row: Tall</option>
                </select>
              )}
            </div>

            <div className="view-toolbar-group">
              {selectedIds.length > 0 && (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => void handleBulkDelete()}>
                  <IconTrash size={13} /> Delete ({selectedIds.length})
                </button>
              )}
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <span style={{ position: 'absolute', left: 9, color: '#9ca3af', pointerEvents: 'none' }}>
                  <IconSearch size={13} />
                </span>
                <input
                  className="input"
                  style={{ paddingLeft: 28, paddingTop: 5, paddingBottom: 5, width: 190 }}
                  placeholder="Search records..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setDraftName('');
                  setDraftFieldType('text');
                  setModal('new-field');
                }}
              >
                <IconPlus size={13} /> Field
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void handleAddRecord()}>
                <IconPlus size={13} /> Record
              </button>
            </div>
          </div>

          {/* Expandable View Config Bars */}
          {activePanel === 'fields' && (
            <div className="popover-bar">
              <strong style={{ fontSize: 12 }}>Visible Fields:</strong>
              {tableFields.map((f) => {
                const hidden = (activeConfig.hiddenFieldIds ?? []).includes(f.id);
                return (
                  <button
                    key={f.id}
                    type="button"
                    disabled={f.is_primary}
                    className={`btn btn-xs ${hidden ? '' : 'btn-soft'}`}
                    onClick={() => {
                      const prev = activeConfig.hiddenFieldIds ?? [];
                      const next = hidden ? prev.filter((id) => id !== f.id) : [...prev, f.id];
                      void updateViewConfig({ hiddenFieldIds: next });
                    }}
                  >
                    {hidden ? '○' : '●'} {f.name}
                  </button>
                );
              })}
            </div>
          )}

          {activePanel === 'filter' && (
            <div className="popover-bar">
              <strong style={{ fontSize: 12 }}>Filters:</strong>
              {(activeConfig.filters ?? []).map((rule, i) => (
                <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fff', border: '1px solid var(--border)', borderRadius: 7, padding: '3px 6px' }}>
                  <select
                    className="select"
                    style={{ padding: '2px 5px', fontSize: 12 }}
                    value={rule.fieldId}
                    onChange={(e) => {
                      const next = [...(activeConfig.filters ?? [])];
                      next[i] = { ...rule, fieldId: Number(e.target.value) };
                      void updateViewConfig({ filters: next });
                    }}
                  >
                    {tableFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                  <select
                    className="select"
                    style={{ padding: '2px 5px', fontSize: 12 }}
                    value={rule.op}
                    onChange={(e) => {
                      const next = [...(activeConfig.filters ?? [])];
                      next[i] = { ...rule, op: e.target.value as FilterRule['op'] };
                      void updateViewConfig({ filters: next });
                    }}
                  >
                    <option value="contains">contains</option>
                    <option value="equals">equals</option>
                    <option value="not_equals">not equals</option>
                    <option value="gt">&gt;</option>
                    <option value="lt">&lt;</option>
                    <option value="not_empty">is not empty</option>
                    <option value="is_empty">is empty</option>
                  </select>
                  {rule.op !== 'is_empty' && rule.op !== 'not_empty' && (
                    <input
                      className="input"
                      style={{ padding: '2px 6px', width: 110, fontSize: 12 }}
                      value={rule.value}
                      onChange={(e) => {
                        const next = [...(activeConfig.filters ?? [])];
                        next[i] = { ...rule, value: e.target.value };
                        void updateViewConfig({ filters: next });
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => {
                      const next = (activeConfig.filters ?? []).filter((_, idx2) => idx2 !== i);
                      void updateViewConfig({ filters: next });
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-xs btn-soft"
                onClick={() => {
                  const first = tableFields[1] ?? tableFields[0];
                  if (!first) return;
                  void updateViewConfig({
                    filters: [...(activeConfig.filters ?? []), { fieldId: first.id, op: 'contains', value: '' }],
                  });
                }}
              >
                + Add condition
              </button>
              {(activeConfig.filters?.length ?? 0) > 0 && (
                <button type="button" className="btn btn-xs btn-ghost" onClick={() => void updateViewConfig({ filters: [] })}>
                  Clear all
                </button>
              )}
            </div>
          )}

          {activePanel === 'group' && (
            <div className="popover-bar">
              <strong style={{ fontSize: 12 }}>Group records by:</strong>
              <select
                className="select"
                style={{ padding: '4px 8px', fontSize: 12 }}
                value={activeConfig.groupBy ?? ''}
                onChange={(e) => void updateViewConfig({ groupBy: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">None (Flat)</option>
                {tableFields.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          )}

          {activePanel === 'sort' && (
            <div className="popover-bar">
              <strong style={{ fontSize: 12 }}>Sort by:</strong>
              {(activeConfig.sorts ?? []).map((s, i) => (
                <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fff', border: '1px solid var(--border)', borderRadius: 7, padding: '3px 6px' }}>
                  <select
                    className="select"
                    style={{ padding: '2px 5px', fontSize: 12 }}
                    value={s.fieldId}
                    onChange={(e) => {
                      const next = [...(activeConfig.sorts ?? [])];
                      next[i] = { ...s, fieldId: Number(e.target.value) };
                      void updateViewConfig({ sorts: next });
                    }}
                  >
                    {tableFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                  <select
                    className="select"
                    style={{ padding: '2px 5px', fontSize: 12 }}
                    value={s.dir}
                    onChange={(e) => {
                      const next = [...(activeConfig.sorts ?? [])];
                      next[i] = { ...s, dir: e.target.value as SortRule['dir'] };
                      void updateViewConfig({ sorts: next });
                    }}
                  >
                    <option value="asc">A → Z / Low → High</option>
                    <option value="desc">Z → A / High → Low</option>
                  </select>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => void updateViewConfig({ sorts: (activeConfig.sorts ?? []).filter((_, k) => k !== i) })}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-xs btn-soft"
                onClick={() => {
                  const f = tableFields[0];
                  if (!f) return;
                  void updateViewConfig({ sorts: [...(activeConfig.sorts ?? []), { fieldId: f.id, dir: 'asc' }] });
                }}
              >
                + Add sort
              </button>
            </div>
          )}

          {/* Active View Canvas */}
          {(!activeView || activeView.view_type === 'grid') && (
            <GridView
              fields={tableFields}
              records={tableRecords}
              idx={idx}
              config={activeConfig}
              selectedIds={selectedIds}
              onToggleSelect={(id) =>
                setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
              }
              onToggleSelectAll={() =>
                setSelectedIds((prev) => (prev.length === tableRecords.length ? [] : tableRecords.map((r) => r.id)))
              }
              onPatchCell={handlePatchCell}
              onOpenRecord={(rec) => setDrawerRecordId(rec.id)}
              onAddRecord={() => handleAddRecord()}
              onOpenAddField={() => {
                setDraftName('');
                setDraftFieldType('text');
                setModal('new-field');
              }}
              onRunAiField={handleRunAiField}
              onChangeSummaryAgg={(fieldId, agg) =>
                void updateViewConfig({
                  summaryAgg: { ...(activeConfig.summaryAgg ?? {}), [String(fieldId)]: agg },
                })
              }
              onDeleteField={(f) => void handleDeleteField(f)}
            />
          )}

          {activeView?.view_type === 'kanban' && (
            <KanbanView
              fields={tableFields}
              records={tableRecords}
              idx={idx}
              groupField={defaultSelectField}
              onMoveRecord={(recId, fieldId, stage) => handlePatchCell(recId, fieldId, stage)}
              onOpenRecord={(rec) => setDrawerRecordId(rec.id)}
              onAddRecordWithStage={(fieldId, stage) => handleAddRecord({ [String(fieldId)]: stage })}
            />
          )}

          {activeView?.view_type === 'calendar' && (
            <CalendarView
              fields={tableFields}
              records={tableRecords}
              idx={idx}
              dateField={primaryDateField}
              statusField={defaultSelectField}
              onOpenRecord={(rec) => setDrawerRecordId(rec.id)}
              onAddRecordOnDate={(dateFieldId, isoDate) => handleAddRecord({ [String(dateFieldId)]: isoDate })}
            />
          )}

          {activeView?.view_type === 'gallery' && (
            <GalleryView
              fields={tableFields}
              records={tableRecords}
              idx={idx}
              statusField={defaultSelectField}
              coverField={coverField}
              onOpenRecord={(rec) => setDrawerRecordId(rec.id)}
            />
          )}

          {activeView?.view_type === 'timeline' && (
            <TimelineView
              records={tableRecords}
              idx={idx}
              startField={startDateField}
              endField={endDateField}
              statusField={defaultSelectField}
              onOpenRecord={(rec) => setDrawerRecordId(rec.id)}
            />
          )}

          {activeView?.view_type === 'list' && (
            <ListView
              fields={tableFields}
              records={tableRecords}
              idx={idx}
              groupField={defaultSelectField}
              checkField={checkField}
              onPatchCell={handlePatchCell}
              onOpenRecord={(rec) => setDrawerRecordId(rec.id)}
              onAddRecord={() => handleAddRecord()}
            />
          )}

          {activeView?.view_type === 'inbox' && (
            <InboxView
              fields={tableFields}
              records={tableRecords}
              idx={idx}
              statusField={defaultSelectField}
              onPatchCell={handlePatchCell}
            />
          )}
        </main>
      </div>

      {/* Record Expander Drawer */}
      {drawerRecord && (
        <RecordDrawer
          record={drawerRecord}
          fields={tableFields}
          idx={idx}
          onClose={() => setDrawerRecordId(null)}
          onPatchCell={handlePatchCell}
          onDuplicate={handleDuplicateRecord}
          onDelete={handleDeleteRecord}
          onRunAiField={handleRunAiField}
        />
      )}

      {/* Modals */}
      {modal === 'new-base' && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateBase(e)}>
            <div className="modal-head">
              <strong>Create Relational Base</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setModal(null)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Base Name
                <input className="input" required placeholder="e.g. Vendor Procurement Hub" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
              </label>
              <label className="field-label">
                Description
                <input className="input" placeholder="What workflow does this base power?" value={draftDesc} onChange={(e) => setDraftDesc(e.target.value)} />
              </label>
              <label className="field-label">
                Accent Color
                <div style={{ display: 'flex', gap: 8 }}>
                  {['#2563eb', '#6d28d9', '#ea580c', '#0d9488', '#db2777', '#059669'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setDraftColor(c)}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 7,
                        background: c,
                        border: draftColor === c ? '3px solid #111827' : '2px solid transparent',
                        cursor: 'pointer',
                      }}
                    />
                  ))}
                </div>
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create Base</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'new-table' && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateTable(e)}>
            <div className="modal-head">
              <strong>Add Table to {workspace?.base.name}</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setModal(null)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Table Name
                <input className="input" required placeholder="e.g. Milestones, Bugs, Assets" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
              </label>
              <label className="field-label">
                Description
                <input className="input" placeholder="Optional table notes" value={draftDesc} onChange={(e) => setDraftDesc(e.target.value)} />
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create Table</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'new-field' && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateField(e)}>
            <div className="modal-head">
              <strong>Add Field Column</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setModal(null)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Field Name
                <input className="input" required placeholder="e.g. Target Revenue, Reviewer, ROI Score" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
              </label>
              <label className="field-label">
                Field Type
                <select className="select" value={draftFieldType} onChange={(e) => setDraftFieldType(e.target.value as FieldType)}>
                  <option value="text">Single line text</option>
                  <option value="long_text">Long text</option>
                  <option value="single_select">Single select (pills)</option>
                  <option value="multi_select">Multiple select</option>
                  <option value="number">Number</option>
                  <option value="currency">Currency ($)</option>
                  <option value="percent">Percent (%)</option>
                  <option value="checkbox">Checkbox</option>
                  <option value="date">Date</option>
                  <option value="rating">Star Rating (1–5)</option>
                  <option value="url">URL</option>
                  <option value="email">Email</option>
                  <option value="link">Link to another table</option>
                  <option value="formula">Formula (fx)</option>
                  <option value="ai_agent">AI Field Agent</option>
                </select>
              </label>
              {(draftFieldType === 'single_select' || draftFieldType === 'multi_select') && (
                <label className="field-label">
                  Choices (comma-separated)
                  <input className="input" value={draftChoices} onChange={(e) => setDraftChoices(e.target.value)} />
                </label>
              )}
              {draftFieldType === 'formula' && (
                <label className="field-label">
                  Formula Expression (use {'{Field Name}'})
                  <input className="input mono" value={draftFormula} onChange={(e) => setDraftFormula(e.target.value)} />
                </label>
              )}
              {draftFieldType === 'link' && (
                <label className="field-label">
                  Link Target Table
                  <select className="select" value={draftTargetTableId || workspace?.tables[0]?.id || 0} onChange={(e) => setDraftTargetTableId(Number(e.target.value))}>
                    {(workspace?.tables ?? []).map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Add Field</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'new-view' && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateView(e)}>
            <div className="modal-head">
              <strong>Create Saved View</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setModal(null)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                View Name
                <input className="input" required value={draftName} onChange={(e) => setDraftName(e.target.value)} />
              </label>
              <label className="field-label">
                Layout Type
                <select className="select" value={draftViewType} onChange={(e) => setDraftViewType(e.target.value as ViewType)}>
                  <option value="grid">Grid View</option>
                  <option value="kanban">Kanban Board</option>
                  <option value="calendar">Calendar</option>
                  <option value="gallery">Gallery</option>
                  <option value="timeline">Timeline / Gantt</option>
                  <option value="list">List View</option>
                  <option value="inbox">Review Inbox</option>
                </select>
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create View</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'import-csv' && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleImportCsv(e)}>
            <div className="modal-head">
              <strong>Import CSV into Table</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setModal(null)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <span style={{ fontSize: 12.5, color: 'var(--ink-secondary)' }}>
                Paste CSV rows whose header columns match your table field names (e.g.{' '}
                <strong>{tableFields.slice(0, 3).map((f) => f.name).join(', ')}</strong>).
              </span>
              <textarea
                className="textarea mono"
                style={{ minHeight: 150, fontSize: 12 }}
                value={csvInput}
                onChange={(e) => setCsvInput(e.target.value)}
              />
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Import Rows</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
