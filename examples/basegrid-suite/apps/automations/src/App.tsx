import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatMoney, getPillTheme } from '../../../shared/ui/format';
import {
  IconBolt,
  IconClose,
  IconDatabase,
  IconHistory,
  IconPlay,
  IconPlus,
  IconSparkles,
  IconTrash,
} from '../../../shared/ui/icons';

interface Automation {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  trigger_type: string;
  trigger_config: { field?: string; op?: string; value?: string; endpoint?: string };
  run_count: number;
  last_run_at: string;
  created_at: string;
}

interface AutomationStep {
  id: number;
  automation_id: number;
  step_type: 'update_record' | 'ai_enrich' | 'send_slack' | 'send_email' | 'send_webhook';
  label: string;
  config: Record<string, unknown>;
  position: number;
}

interface WorkflowRecord {
  id: number;
  title: string;
  status: string;
  priority: string;
  owner_name: string;
  amount: number;
  escalated: boolean;
  ai_note: string;
  updated_at: string;
}

interface AutomationRun {
  id: number;
  automation_id: number;
  automation_name: string;
  record_id: number | null;
  record_title: string;
  status: string;
  duration_ms: number;
  trace: Array<{ step: string; type: string; outcome: string }>;
  created_at: string;
}

interface OutboxItem {
  id: number;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  automation_name: string;
  created_at: string;
}

export const App: React.FC = () => {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [steps, setSteps] = useState<AutomationStep[]>([]);
  const [records, setRecords] = useState<WorkflowRecord[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [activeId, setActiveId] = useState<number>(1);
  const [tab, setTab] = useState<'flow' | 'sandbox' | 'runs'>('flow');
  const [testRecordId, setTestRecordId] = useState<number>(1);

  const [showNewAuto, setShowNewAuto] = useState(false);
  const [showAddStep, setShowAddStep] = useState(false);
  const [newAutoName, setNewAutoName] = useState('');
  const [newStepType, setNewStepType] = useState<AutomationStep['step_type']>('send_slack');
  const [newStepLabel, setNewStepLabel] = useState('Post Slack Alert');
  const [newStepRecipient, setNewStepRecipient] = useState('#ops-alerts');
  const [newStepBody, setNewStepBody] = useState('Record {title} ({status}) updated by {owner_name}.');

  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((p) => (p === msg ? null : p)), 3200);
  }, []);

  const loadState = useCallback(async () => {
    const [rt, data] = await Promise.all([
      apiFetch<RuntimeInfo>('/api/runtime'),
      apiFetch<{
        automations: Automation[];
        steps: AutomationStep[];
        records: WorkflowRecord[];
        runs: AutomationRun[];
        outbox: OutboxItem[];
      }>('/api/state'),
    ]);
    setRuntime(rt);
    setAutomations(data.automations);
    setSteps(data.steps);
    setRecords(data.records);
    setRuns(data.runs);
    setOutbox(data.outbox);
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const activeAuto = automations.find((a) => a.id === activeId) ?? automations[0] ?? null;
  const activeSteps = useMemo(
    () => steps.filter((s) => s.automation_id === activeAuto?.id).sort((a, b) => a.position - b.position),
    [steps, activeAuto]
  );

  const handleToggleEnabled = async (auto: Automation) => {
    const next = !auto.enabled;
    await apiFetch(`/api/automations/${auto.id}`, { method: 'PATCH', body: { enabled: next } });
    setAutomations((prev) => prev.map((a) => (a.id === auto.id ? { ...a, enabled: next } : a)));
    notify(next ? `Enabled "${auto.name}"` : `Paused "${auto.name}" for review`);
  };

  const handleTestRun = async () => {
    if (!activeAuto) return;
    const res = await apiFetch<{ ok: boolean; run: { id: number; duration_ms: number } }>(
      `/api/automations/${activeAuto.id}/run`,
      { method: 'POST', body: { record_id: testRecordId } }
    );
    await loadState();
    notify(`Executed "${activeAuto.name}" in ${res.run.duration_ms}ms (Run #${res.run.id})`);
  };

  const handleCreateAuto = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAutoName.trim()) return;
    const res = await apiFetch<{ automation: { id: number; name: string } }>('/api/automations', {
      method: 'POST',
      body: { name: newAutoName.trim() },
    });
    await loadState();
    setActiveId(res.automation.id);
    setShowNewAuto(false);
    setNewAutoName('');
    notify(`Created "${res.automation.name}" (Paused for safety review)`);
  };

  const handleAddStep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeAuto) return;
    const config: Record<string, unknown> =
      newStepType === 'update_record'
        ? { priority: 'P0', escalated: 1 }
        : newStepType === 'ai_enrich'
          ? { template: newStepBody }
          : { recipient: newStepRecipient, subject: `Automation: {title}`, body: newStepBody };
    await apiFetch(`/api/automations/${activeAuto.id}/steps`, {
      method: 'POST',
      body: { step_type: newStepType, label: newStepLabel.trim() || 'Action Step', config },
    });
    await loadState();
    setShowAddStep(false);
    notify('Added action step to workflow');
  };

  const handleDeleteStep = async (id: number) => {
    await apiFetch(`/api/steps/${id}`, { method: 'DELETE' });
    setSteps((prev) => prev.filter((s) => s.id !== id));
    notify('Removed action step');
  };

  const handleMutateSandboxRecord = async (rec: WorkflowRecord, patch: Partial<WorkflowRecord>) => {
    const res = await apiFetch<{ firedAutomations: string[] }>(`/api/workflow-records/${rec.id}`, {
      method: 'PATCH',
      body: patch,
    });
    await loadState();
    if (res.firedAutomations.length > 0) {
      notify(`Triggered ${res.firedAutomations.length} automation(s): ${res.firedAutomations.join(', ')}`);
    } else {
      notify(`Updated "${rec.title}"`);
    }
  };

  const totalRuns = automations.reduce((s, a) => s + a.run_count, 0);

  return (
    <div className="bg-shell">
      <header className="bg-topbar">
        <div className="bg-topbar-left">
          <div className="bg-brand">
            <div className="bg-brand-badge" style={{ background: '#7c3aed' }}>
              <IconBolt size={15} />
            </div>
            <div>
              <div className="bg-brand-title">Automations &amp; Workflow Engine</div>
              <div className="bg-brand-sub">Unlimited local &amp; self-hosted runs — zero monthly caps</div>
            </div>
          </div>

          <div className="bg-segmented">
            <button type="button" className={`bg-seg-btn ${tab === 'flow' ? 'active' : ''}`} onClick={() => setTab('flow')}>
              <IconBolt size={13} /> Flow Builder
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'sandbox' ? 'active' : ''}`} onClick={() => setTab('sandbox')}>
              <IconDatabase size={13} /> Live Trigger Table
            </button>
            <button type="button" className={`bg-seg-btn ${tab === 'runs' ? 'active' : ''}`} onClick={() => setTab('runs')}>
              <IconHistory size={13} /> Run History ({runs.length}) &amp; Outbox ({outbox.length})
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
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowNewAuto(true)}>
            <IconPlus size={13} /> New Automation
          </button>
        </div>
      </header>

      <div className="bg-body">
        <aside className="bg-rail">
          <div className="bg-rail-section">
            <div className="bg-rail-label">
              <span>Workflows ({automations.length})</span>
              <span>{totalRuns} runs</span>
            </div>
            {automations.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`bg-rail-item ${activeAuto?.id === a.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveId(a.id);
                  setTab('flow');
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 99, background: a.enabled ? '#22c55e' : '#f59e0b', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                <span className="bg-rail-count">{a.run_count}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="bg-content">
          {/* TAB 1: VISUAL FLOW BUILDER */}
          {tab === 'flow' && activeAuto && (
            <>
              <div className="view-toolbar">
                <div className="view-toolbar-group">
                  <strong style={{ fontSize: 15 }}>{activeAuto.name}</strong>
                  <span
                    className="pill"
                    style={{
                      background: activeAuto.enabled ? '#dcfce7' : '#fef3c7',
                      color: activeAuto.enabled ? '#15803d' : '#b45309',
                    }}
                  >
                    {activeAuto.enabled ? 'Active' : 'Paused for Review'}
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => void handleToggleEnabled(activeAuto)}>
                    {activeAuto.enabled ? 'Pause' : 'Turn On'}
                  </button>
                </div>

                <div className="view-toolbar-group">
                  <select
                    aria-label="Test record"
                    className="select"
                    style={{ padding: '4.5px 8px', fontSize: 12.5, maxWidth: 230 }}
                    value={testRecordId}
                    onChange={(e) => setTestRecordId(Number(e.target.value))}
                  >
                    {records.map((r) => (
                      <option key={r.id} value={r.id}>
                        Test on: {r.title}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-sm btn-accent" onClick={() => void handleTestRun()}>
                    <IconPlay size={12} /> Test &amp; Run Live
                  </button>
                </div>
              </div>

              <div className="bg-scroll-page">
                <div className="flow-canvas">
                  {/* TRIGGER NODE */}
                  <div className="flow-node trigger">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span className="pill" style={{ background: '#dbeafe', color: '#1d4ed8' }}>
                        <IconBolt size={11} /> TRIGGER
                      </span>
                      <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>
                        {activeAuto.run_count} total executions
                      </span>
                    </div>
                    <strong style={{ fontSize: 14.5 }}>
                      {activeAuto.trigger_type === 'webhook_received'
                        ? `When webhook received at ${activeAuto.trigger_config.endpoint || '/api/hooks/inbound'}`
                        : `When record matches: ${activeAuto.trigger_config.field || 'status'} ${activeAuto.trigger_config.op || 'equals'} "${activeAuto.trigger_config.value || ''}"`}
                    </strong>
                    <div style={{ fontSize: 12.5, color: 'var(--ink-secondary)', marginTop: 4 }}>
                      {activeAuto.description}
                    </div>
                  </div>

                  {/* ACTION NODES */}
                  {activeSteps.map((step, i) => (
                    <React.Fragment key={step.id}>
                      <div className="flow-connector" />
                      <div className="flow-node action">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span className="pill" style={{ background: '#ede9fe', color: '#6d28d9' }}>
                            {step.step_type === 'ai_enrich' ? <IconSparkles size={11} /> : null}
                            ACTION {i + 1} · {step.step_type.replace('_', ' ').toUpperCase()}
                          </span>
                          <button type="button" className="btn btn-xs btn-ghost" onClick={() => void handleDeleteStep(step.id)}>
                            <IconTrash size={12} />
                          </button>
                        </div>
                        <strong style={{ fontSize: 14 }}>{step.label}</strong>
                        <pre className="code-block" style={{ marginTop: 8, fontSize: 11.5, padding: '8px 10px' }}>
                          {JSON.stringify(step.config, null, 2)}
                        </pre>
                      </div>
                    </React.Fragment>
                  ))}

                  <div className="flow-connector" />
                  <button type="button" className="btn btn-soft" onClick={() => setShowAddStep(true)}>
                    <IconPlus size={14} /> Add Action Step
                  </button>
                </div>
              </div>
            </>
          )}

          {/* TAB 2: LIVE TRIGGER SANDBOX TABLE */}
          {tab === 'sandbox' && (
            <div className="bg-scroll-page">
              <div className="bg-scroll-inner">
                <div>
                  <h2 style={{ margin: 0, fontSize: 18 }}>Live Trigger Sandbox</h2>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ink-secondary)' }}>
                    Change any record&apos;s Status below (for example, flip a row to <strong>At Risk</strong> or <strong>Launched</strong>) — matching Active automations execute immediately in PHP 8 + XDB SQLite!
                  </p>
                </div>

                <div className="card" style={{ overflowX: 'auto' }}>
                  <table className="bg-grid-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Record</th>
                        <th>Status (Change to Trigger)</th>
                        <th>Priority</th>
                        <th>Owner</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                        <th>Escalated</th>
                        <th>AI / Automation Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r) => {
                        const pt = getPillTheme(r.priority);
                        return (
                          <tr key={r.id}>
                            <td style={{ padding: '10px 12px', fontWeight: 650 }}>{r.title}</td>
                            <td style={{ padding: '8px 12px' }}>
                              <select
                                className="select"
                                style={{ padding: '4px 8px', fontSize: 12.5 }}
                                value={r.status}
                                onChange={(e) => void handleMutateSandboxRecord(r, { status: e.target.value })}
                              >
                                {['Planning', 'In Progress', 'In Review', 'At Risk', 'Launched'].map((st) => (
                                  <option key={st} value={st}>{st}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: '10px 12px' }}>
                              <span className="pill" style={{ background: pt.bg, color: pt.fg }}>{r.priority}</span>
                            </td>
                            <td style={{ padding: '10px 12px' }}>{r.owner_name}</td>
                            <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                              {formatMoney(r.amount)}
                            </td>
                            <td style={{ padding: '10px 12px' }}>
                              {r.escalated ? (
                                <span className="pill" style={{ background: '#fee2e2', color: '#b91c1c' }}>Escalated!</span>
                              ) : (
                                <span style={{ color: 'var(--ink-muted)', fontSize: 12 }}>Normal</span>
                              )}
                            </td>
                            <td style={{ padding: '10px 12px', fontSize: 12, color: '#4c1d95', maxWidth: 280 }}>{r.ai_note}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: RUN HISTORY & OUTBOX */}
          {tab === 'runs' && (
            <div className="bg-scroll-page">
              <div className="bg-scroll-inner" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 18 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 17 }}>Execution Run History ({runs.length})</h2>
                  {runs.map((run) => (
                    <div key={run.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong>Run #{run.id} · {run.automation_name}</strong>
                        <span className="pill" style={{ background: '#dcfce7', color: '#15803d' }}>
                          {run.status} · {run.duration_ms}ms
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                        Target: <strong>{run.record_title}</strong> · {run.created_at}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {run.trace.map((t, idx2) => (
                          <div key={idx2} style={{ fontSize: 12, background: '#f8fafc', padding: '6px 9px', borderRadius: 6, border: '1px solid var(--border-subtle)' }}>
                            <strong>{t.step}</strong>: <span style={{ color: 'var(--ink-secondary)' }}>{t.outcome}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 17 }}>Notification Outbox ({outbox.length})</h2>
                  {outbox.map((msg) => {
                    const pt = getPillTheme(msg.channel);
                    return (
                      <div key={msg.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span className="pill" style={{ background: pt.bg, color: pt.fg }}>
                            {msg.channel} → {msg.recipient}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{msg.created_at}</span>
                        </div>
                        <strong style={{ fontSize: 13.5 }}>{msg.subject}</strong>
                        <div style={{ fontSize: 12.5, color: 'var(--ink-secondary)' }}>{msg.body}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {showNewAuto && (
        <div className="modal-backdrop" onClick={() => setShowNewAuto(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleCreateAuto(e)}>
            <div className="modal-head">
              <strong>Create Automation Workflow</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowNewAuto(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Automation Name
                <input className="input" required placeholder="e.g. Auto-Notify Finance on Approval" value={newAutoName} onChange={(e) => setNewAutoName(e.target.value)} />
              </label>
              <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                New automations start <strong>Paused for Review</strong> so you can test them safely before turning them on.
              </span>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowNewAuto(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create Automation</button>
            </div>
          </form>
        </div>
      )}

      {showAddStep && (
        <div className="modal-backdrop" onClick={() => setShowAddStep(false)}>
          <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleAddStep(e)}>
            <div className="modal-head">
              <strong>Add Action Step</strong>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowAddStep(false)}><IconClose size={15} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                Action Type
                <select className="select" value={newStepType} onChange={(e) => setNewStepType(e.target.value as AutomationStep['step_type'])}>
                  <option value="send_slack">Send Slack Message</option>
                  <option value="send_email">Send Email Notification</option>
                  <option value="send_webhook">Dispatch Webhook</option>
                  <option value="update_record">Update Record Fields</option>
                  <option value="ai_enrich">Run AI Summary / Triage Step</option>
                </select>
              </label>
              <label className="field-label">
                Step Label
                <input className="input" required value={newStepLabel} onChange={(e) => setNewStepLabel(e.target.value)} />
              </label>
              {newStepType !== 'update_record' && newStepType !== 'ai_enrich' && (
                <label className="field-label">
                  Recipient / Channel / Webhook URL
                  <input className="input" value={newStepRecipient} onChange={(e) => setNewStepRecipient(e.target.value)} />
                </label>
              )}
              {newStepType !== 'update_record' && (
                <label className="field-label">
                  Message Template (supports {'{title}'}, {'{status}'}, {'{owner_name}'}, {'{amount}'})
                  <textarea className="textarea" value={newStepBody} onChange={(e) => setNewStepBody(e.target.value)} />
                </label>
              )}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setShowAddStep(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Add Action</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
