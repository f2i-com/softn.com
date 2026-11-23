import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatMoney, getPillTheme } from '../../../shared/ui/format';
import {
  IconBolt,
  IconClose,
  IconPlay,
  IconPlus,
  IconShield,
  IconSparkles,
  IconTrash,
} from '../../../shared/ui/icons';

interface Blueprint {
  id: number;
  name: string;
  prompt: string;
  domain: string;
  tables: Array<{ name: string; fields: string[] }>;
  views: string[];
  automations: string[];
  created_at: string;
}

interface OmniMsg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  blueprint_id: number | null;
  created_at: string;
}

interface FieldAgent {
  id: number;
  name: string;
  output_column: string;
  model_name: string;
  temperature: number;
  web_search: boolean;
  prompt_template: string;
  runs_completed: number;
}

interface AgentRow {
  id: number;
  company: string;
  source_text: string;
  arr_value: number;
  ai_summary: string;
  ai_risk: string;
  ai_category: string;
  ai_next_action: string;
  confidence: number;
  updated_at: string;
}

interface McpSettings {
  mcp_enabled: boolean;
  zero_retention: boolean;
  pause_ai_automations: boolean;
  monthly_credit_cap: number;
  credits_used: number;
}

interface McpLog {
  id: number;
  tool_name: string;
  args_json: string;
  result_preview: string;
  duration_ms: number;
  created_at: string;
}

const AI_PLAYS = [
  {
    title: 'Event & Speaker Operations',
    prompt: 'Create an annual conference and speaker operations hub with sessions, VIP speaker bios, sponsor booths, and travel alerts.',
  },
  {
    title: 'Contract Renewal & Legal Risk',
    prompt: 'Build a legal contract renewal tracker with vendor agreements, auto-renew dates, redline reviews, and AI clause risk scoring.',
  },
  {
    title: 'Customer Feedback Intelligence',
    prompt: 'Create a customer feedback triage base that classifies tickets, extracts sentiment, links to feature themes, and rolls up ARR.',
  },
];

export const App: React.FC = () => {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [tab, setTab] = useState<'omni' | 'agents' | 'mcp'>('omni');
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [messages, setMessages] = useState<OmniMsg[]>([]);
  const [agents, setAgents] = useState<FieldAgent[]>([]);
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [mcpSettings, setMcpSettings] = useState<McpSettings>({
    mcp_enabled: true,
    zero_retention: true,
    pause_ai_automations: true,
    monthly_credit_cap: 50000,
    credits_used: 0,
  });
  const [mcpLogs, setMcpLogs] = useState<McpLog[]>([]);

  const [promptInput, setPromptInput] = useState('');
  const [activeBpId, setActiveBpId] = useState<number | null>(null);
  const [showAddRow, setShowAddRow] = useState(false);
  const [newCompany, setNewCompany] = useState('');
  const [newArr, setNewArr] = useState('65000');
  const [newSource, setNewSource] = useState('');

  const [mcpTool, setMcpTool] = useState('query_agent_rows');
  const [mcpRiskFilter, setMcpRiskFilter] = useState('');
  const [mcpOutput, setMcpOutput] = useState<string>('');

  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((p) => (p === msg ? null : p)), 3000);
  }, []);

  const loadState = useCallback(async () => {
    const [rt, data] = await Promise.all([
      apiFetch<RuntimeInfo>('/api/runtime'),
      apiFetch<{
        blueprints: Blueprint[];
        messages: OmniMsg[];
        agents: FieldAgent[];
        rows: AgentRow[];
        mcpSettings: McpSettings;
        mcpLogs: McpLog[];
      }>('/api/state'),
    ]);
    setRuntime(rt);
    setBlueprints(data.blueprints);
    setMessages(data.messages);
    setAgents(data.agents);
    setRows(data.rows);
    setMcpSettings(data.mcpSettings);
    setMcpLogs(data.mcpLogs);
    setActiveBpId((prev) => (prev && data.blueprints.some((b) => b.id === prev) ? prev : data.blueprints[0]?.id ?? null));
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const activeBp = blueprints.find((b) => b.id === activeBpId) ?? blueprints[0] ?? null;

  const handleGenerateBlueprint = async (text: string) => {
    if (!text.trim()) return;
    const res = await apiFetch<{ blueprintId: number; name: string }>('/api/omni/generate', {
      method: 'POST',
      body: { prompt: text.trim() },
    });
    setPromptInput('');
    await loadState();
    setActiveBpId(res.blueprintId);
    notify(`Omni built "${res.name}" in XDB SQLite`);
  };

  const handleRevertBlueprint = async (id: number) => {
    await apiFetch(`/api/omni/blueprints/${id}`, { method: 'DELETE' });
    await loadState();
    notify('Reverted Omni blueprint');
  };

  const handleRunFieldAgents = async (rowId?: number) => {
    const res = await apiFetch<{ processed: number }>('/api/field-agents/run', {
      method: 'POST',
      body: rowId ? { row_id: rowId } : {},
    });
    await loadState();
    notify(`Field Agents processed ${res.processed} record(s) across 4 AI columns`);
  };

  const handleAddRow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompany.trim() || !newSource.trim()) return;
    await apiFetch('/api/agent-rows', {
      method: 'POST',
      body: { company: newCompany.trim(), arr_value: Number(newArr) || 50000, source_text: newSource.trim() },
    });
    setShowAddRow(false);
    setNewCompany('');
    setNewSource('');
    await loadState();
    notify('Added record — click "Run Field Agents" to analyze it');
  };

  const handleUpdateAgentModel = async (agent: FieldAgent, modelName: string) => {
    await apiFetch(`/api/field-agents/${agent.id}`, {
      method: 'PATCH',
      body: { model_name: modelName },
    });
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, model_name: modelName } : a)));
    notify(`Switched ${agent.name} to ${modelName}`);
  };

  const handleToggleMcpSetting = async (key: keyof Pick<McpSettings, 'mcp_enabled' | 'zero_retention' | 'pause_ai_automations'>) => {
    const next = { ...mcpSettings, [key]: !mcpSettings[key] };
    await apiFetch('/api/mcp/settings', { method: 'PATCH', body: next });
    setMcpSettings(next);
    notify('Updated AI & MCP governance policy');
  };

  const handleCallMcp = async () => {
    try {
      const args = mcpTool === 'query_agent_rows' && mcpRiskFilter ? { risk: mcpRiskFilter } : {};
      const res = await apiFetch<{ tool: string; duration_ms: number; result: unknown }>('/api/mcp/call', {
        method: 'POST',
        body: { tool: mcpTool, args },
      });
      setMcpOutput(JSON.stringify(res, null, 2));
      await loadState();
      notify(`MCP tool ${res.tool} returned in ${res.duration_ms}ms`);
    } catch (err) {
      setMcpOutput(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2));
    }
  };

  return (
    <div className="bg-shell">
      <header className="bg-topbar">
        <div className="bg-topbar-left">
          <div className="bg-brand">
            <div className="bg-brand-badge" style={{ background: 'linear-gradient(135deg,#2563eb,#0ea5e9)' }}>
              <IconSparkles size={15} />
            </div>
            <div>
              <div className="bg-brand-title">Omni AI Builder &amp; Field Agents</div>
              <div className="bg-brand-sub">Conversational app architect, column AI agents &amp; MCP console</div>
            </div>
          </div>

          <div className="bg-segmented">
            <button type="button" className={`bg-seg-btn ${tab === 'omni' ? 'active' : ''}`} onClick={() => setTab('omni')}>
              <IconSparkles size={13} /> Omni App Builder
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'agents' ? 'active' : ''}`} onClick={() => setTab('agents')}>
              <IconBolt size={13} /> Field Agents ({rows.length} rows)
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'mcp' ? 'active' : ''}`} onClick={() => setTab('mcp')}>
              <IconShield size={13} /> MCP &amp; Governance
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
          <span className="pill" style={{ background: '#e0f2fe', color: '#0369a1' }}>
            Local Credits: {mcpSettings.credits_used} / Unlimited
          </span>
        </div>
      </header>

      <div className="bg-body">
        <main className="bg-content">
          {/* TAB 1: OMNI CONVERSATIONAL APP ARCHITECT */}
          {tab === 'omni' && (
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(320px, 430px) minmax(0, 1fr)', minHeight: 0, overflow: 'hidden' }}>
              <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: '#f8fafc', overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', background: '#ffffff' }}>
                  <strong style={{ fontSize: 14.5 }}>Say hello to Omni</strong>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
                    Describe any workflow — Omni designs relational tables, views, Field Agents &amp; paused automations.
                  </div>
                </div>

                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6, background: '#f0f9ff' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#0369a1' }}>
                    1-Click AI Plays
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {AI_PLAYS.map((p) => (
                      <button
                        key={p.title}
                        type="button"
                        className="btn btn-xs"
                        style={{ background: '#ffffff', borderColor: '#bae6fd', color: '#0369a1' }}
                        onClick={() => void handleGenerateBlueprint(p.prompt)}
                      >
                        ✦ {p.title}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                        maxWidth: '90%',
                        padding: '10px 13px',
                        borderRadius: 12,
                        background: m.role === 'user' ? '#111827' : '#ffffff',
                        color: m.role === 'user' ? '#ffffff' : 'var(--ink)',
                        border: m.role === 'user' ? 'none' : '1px solid var(--border)',
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      {m.content}
                    </div>
                  ))}
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleGenerateBlueprint(promptInput);
                  }}
                  style={{ padding: 12, borderTop: '1px solid var(--border)', background: '#ffffff', display: 'flex', gap: 8 }}
                >
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="Build an app to track..."
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                  />
                  <button type="submit" className="btn btn-accent">
                    <IconSparkles size={13} /> Build
                  </button>
                </form>
              </div>

              {/* Generated Blueprint Preview */}
              <div className="bg-scroll-page">
                <div className="bg-scroll-inner" style={{ gap: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {blueprints.map((bp) => (
                        <button
                          key={bp.id}
                          type="button"
                          className={`btn btn-sm ${activeBp?.id === bp.id ? 'btn-primary' : ''}`}
                          onClick={() => setActiveBpId(bp.id)}
                        >
                          {bp.name}
                        </button>
                      ))}
                    </div>
                    {activeBp && blueprints.length > 1 && (
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void handleRevertBlueprint(activeBp.id)}>
                        <IconTrash size={13} /> Undo / Revert Build
                      </button>
                    )}
                  </div>

                  {activeBp && (
                    <>
                      <div className="card card-pad" style={{ background: 'linear-gradient(135deg,#eff6ff 0%,#ffffff 100%)', borderColor: '#bfdbfe' }}>
                        <span className="pill" style={{ background: '#dbeafe', color: '#1d4ed8', marginBottom: 8 }}>
                          {activeBp.domain}
                        </span>
                        <h2 style={{ margin: '4px 0 4px', fontSize: 20, letterSpacing: '-0.02em' }}>{activeBp.name}</h2>
                        <div style={{ fontSize: 13, color: 'var(--ink-secondary)' }}>Prompt: &ldquo;{activeBp.prompt}&rdquo;</div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14 }}>
                        {activeBp.tables.map((t) => (
                          <div key={t.name} className="card">
                            <div className="card-header" style={{ background: '#fafaf9' }}>
                              <strong style={{ fontSize: 13.5 }}>Table: {t.name}</strong>
                              <span className="pill" style={{ background: '#f1f5f9', color: '#475569' }}>{t.fields.length} fields</span>
                            </div>
                            <div className="card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {t.fields.map((f) => (
                                <div key={f} style={{ fontSize: 12.5, padding: '5px 8px', borderRadius: 6, background: f.includes('AI') ? '#f5f3ff' : '#f8fafc', color: f.includes('AI') ? '#6d28d9' : 'var(--ink)', fontWeight: f.includes('AI') ? 650 : 500 }}>
                                  {f.includes('AI') ? '✦ ' : '• '}
                                  {f}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                        <div className="card card-pad">
                          <strong style={{ fontSize: 13.5 }}>Generated Views &amp; Interfaces</strong>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
                            {activeBp.views.map((v) => (
                              <span key={v} className="pill" style={{ background: '#e0f2fe', color: '#0369a1', padding: '4px 10px' }}>
                                {v}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="card card-pad">
                          <strong style={{ fontSize: 13.5 }}>Drafted Automations (Paused for Review)</strong>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                            {activeBp.automations.map((a) => (
                              <div key={a} style={{ fontSize: 12.5, padding: '7px 10px', borderRadius: 7, background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>
                                ⏸ {a}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: FIELD AGENTS STUDIO */}
          {tab === 'agents' && (
            <div className="bg-scroll-page">
              <div className="bg-scroll-inner">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18 }}>Autonomous Column Field Agents</h2>
                    <div style={{ fontSize: 13, color: 'var(--ink-secondary)' }}>
                      Configure multi-model agents directly inside table columns — runs 100% locally in ZIPP PHP WASM with zero data retention.
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="btn btn-sm" onClick={() => setShowAddRow(true)}>
                      <IconPlus size={13} /> Add Unstructured Row
                    </button>
                    <button type="button" className="btn btn-sm btn-accent" onClick={() => void handleRunFieldAgents()}>
                      <IconSparkles size={13} /> Run All Field Agents Across Table
                    </button>
                  </div>
                </div>

                {/* Agent Column Config Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
                  {agents.map((ag) => (
                    <div key={ag.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'linear-gradient(180deg,#fdfbff,#ffffff)', borderColor: '#ddd6fe' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ color: '#5b21b6', fontSize: 13.5 }}>✦ {ag.name}</strong>
                        <span className="pill" style={{ background: '#ede9fe', color: '#6d28d9', fontSize: 10.5 }}>
                          {ag.runs_completed} runs
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ink-secondary)' }}>{ag.prompt_template}</div>
                      <select
                        aria-label={`Model for ${ag.name}`}
                        className="select"
                        style={{ padding: '4px 8px', fontSize: 12 }}
                        value={ag.model_name}
                        onChange={(e) => void handleUpdateAgentModel(ag, e.target.value)}
                      >
                        <option value="BaseGrid Local NLP">BaseGrid Local NLP (Zero-Egress)</option>
                        <option value="Claude 4.5 Sonnet (BYOK)">Claude 4.5 Sonnet (BYOK)</option>
                        <option value="Gemini 2.5 Pro (BYOK)">Gemini 2.5 Pro (BYOK)</option>
                        <option value="GPT-4.1 (BYOK)">GPT-4.1 (BYOK)</option>
                      </select>
                    </div>
                  ))}
                </div>

                {/* Live Dataset with AI Agent Columns */}
                <div className="card" style={{ overflowX: 'auto' }}>
                  <table className="bg-grid-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Raw Notes (Input)</th>
                        <th style={{ color: '#6d28d9' }}>✦ AI Summary</th>
                        <th style={{ color: '#6d28d9' }}>✦ AI Risk</th>
                        <th style={{ color: '#6d28d9' }}>✦ AI Category</th>
                        <th style={{ color: '#6d28d9' }}>✦ AI Next Action</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const riskPill = getPillTheme(r.ai_risk || 'Draft');
                        const catPill = getPillTheme(r.ai_category || 'Draft');
                        return (
                          <tr key={r.id}>
                            <td style={{ padding: '10px 12px', fontWeight: 700, minWidth: 150 }}>
                              {r.company}
                              <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', fontWeight: 500 }}>{formatMoney(r.arr_value)} ARR</div>
                            </td>
                            <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--ink-secondary)', maxWidth: 250 }}>{r.source_text}</td>
                            <td style={{ padding: '10px 12px', fontSize: 12, background: '#fdfbff', maxWidth: 230 }}>
                              {r.ai_summary || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>Pending agent run…</span>}
                            </td>
                            <td style={{ padding: '10px 12px', background: '#fdfbff' }}>
                              {r.ai_risk ? (
                                <span className="pill" style={{ background: riskPill.bg, color: riskPill.fg }}>{r.ai_risk}</span>
                              ) : '—'}
                            </td>
                            <td style={{ padding: '10px 12px', background: '#fdfbff' }}>
                              {r.ai_category ? (
                                <span className="pill" style={{ background: catPill.bg, color: catPill.fg }}>{r.ai_category}</span>
                              ) : '—'}
                            </td>
                            <td style={{ padding: '10px 12px', fontSize: 12, background: '#fdfbff', maxWidth: 220 }}>
                              {r.ai_next_action || '—'}
                              {r.confidence > 0 && (
                                <div style={{ fontSize: 10.5, color: '#6d28d9', fontWeight: 700, marginTop: 3 }}>
                                  Confidence: {r.confidence}%
                                </div>
                              )}
                            </td>
                            <td style={{ padding: '10px 12px' }}>
                              <button type="button" className="btn btn-xs btn-soft" onClick={() => void handleRunFieldAgents(r.id)}>
                                <IconSparkles size={11} /> Run
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: MCP CONSOLE & AI GOVERNANCE */}
          {tab === 'mcp' && (
            <div className="bg-scroll-page">
              <div className="bg-scroll-inner" style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 18 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <strong style={{ fontSize: 15 }}>Admin AI &amp; MCP Governance</strong>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span>Enable Model Context Protocol (MCP) Server</span>
                      <input type="checkbox" checked={mcpSettings.mcp_enabled} onChange={() => void handleToggleMcpSetting('mcp_enabled')} />
                    </label>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span>Zero AI Data Retention &amp; No Model Training</span>
                      <input type="checkbox" checked={mcpSettings.zero_retention} onChange={() => void handleToggleMcpSetting('zero_retention')} />
                    </label>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span>Require Human Review (Pause AI Automations)</span>
                      <input type="checkbox" checked={mcpSettings.pause_ai_automations} onChange={() => void handleToggleMcpSetting('pause_ai_automations')} />
                    </label>
                  </div>

                  <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <strong style={{ fontSize: 14 }}>Recent MCP Tool Invocations ({mcpLogs.length})</strong>
                    {mcpLogs.map((l) => (
                      <div key={l.id} style={{ fontSize: 12, padding: '7px 10px', borderRadius: 7, background: '#f8fafc', border: '1px solid var(--border-subtle)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <strong className="mono">{l.tool_name}</strong>
                          <span style={{ color: 'var(--ink-muted)' }}>{l.duration_ms}ms · {l.created_at}</span>
                        </div>
                        <div style={{ color: 'var(--ink-secondary)', marginTop: 2 }}>{l.result_preview}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <strong style={{ fontSize: 15 }}>Interactive MCP Tool Tester (softn-mcp)</strong>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-secondary)' }}>
                    Connect Claude, Gemini, or local agents to your BaseGrid SQLite bases with permission-scoped tools.
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <select className="select" value={mcpTool} onChange={(e) => setMcpTool(e.target.value)} style={{ flex: 1 }}>
                      <option value="query_agent_rows">query_agent_rows</option>
                      <option value="list_blueprints">list_blueprints</option>
                      <option value="get_schema_summary">get_schema_summary</option>
                    </select>
                    {mcpTool === 'query_agent_rows' && (
                      <select className="select" value={mcpRiskFilter} onChange={(e) => setMcpRiskFilter(e.target.value)}>
                        <option value="">All Risk Levels</option>
                        <option value="High Risk">High Risk Only</option>
                        <option value="Medium">Medium Only</option>
                        <option value="Low Risk">Low Risk Only</option>
                      </select>
                    )}
                    <button type="button" className="btn btn-primary" onClick={() => void handleCallMcp()}>
                      <IconPlay size={12} /> Invoke Tool
                    </button>
                  </div>
                  <pre className="code-block" style={{ minHeight: 260 }}>
                    {mcpOutput || '// Click "Invoke Tool" to call BaseGrid MCP against XDB SQLite'}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {showAddRow && (
        <div className="modal-backdrop" onClick={() => setShowAddRow(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleAddRow(e)}>
            <div className="modal-head">
              <strong>Add Unstructured Record for Field Agents</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowAddRow(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Company / Record Name
                <input className="input" required placeholder="e.g. Meridian Aerospace" value={newCompany} onChange={(e) => setNewCompany(e.target.value)} />
              </label>
              <label className="field-label">
                Estimated ARR ($)
                <input className="input" type="number" value={newArr} onChange={(e) => setNewArr(e.target.value)} />
              </label>
              <label className="field-label">
                Raw Unstructured Notes / Transcript
                <textarea
                  className="textarea"
                  required
                  placeholder="Paste customer call notes, contract text, or support ticket..."
                  value={newSource}
                  onChange={(e) => setNewSource(e.target.value)}
                />
              </label>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowAddRow(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Add Record</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
