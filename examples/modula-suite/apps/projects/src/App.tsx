import { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatCompactMoney, formatNumber, formatPercent } from '../../../shared/ui/format';
import { MilestonesView, PortfolioView } from './components/PortfolioAndMilestonesView';
import { TaskBoardView } from './components/TaskBoardView';
import { ProfitabilityView, TimesheetsView } from './components/TimesheetsAndProfitabilityView';
import type { Milestone, Project, ProjectsOverview, Task, Timesheet } from './types';

function fmtTimer(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function App() {
  const [tab, setTab] = useState<'kanban' | 'portfolio' | 'milestones' | 'timesheets' | 'profitability'>('kanban');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [overview, setOverview] = useState<ProjectsOverview | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [timerTask, setTimerTask] = useState<Task | null>(null);
  const [timerSecs, setTimerSecs] = useState(0);

  const [showNewTask, setShowNewTask] = useState(false);
  const [taskForm, setTaskForm] = useState({ project_id: '1', title: '', priority: 'Medium', assignee: 'Alex Rivera', estimate_hours: '6' });
  const [showNewProject, setShowNewProject] = useState(false);
  const [projForm, setProjForm] = useState({ name: '', client_name: '', budget_hours: '60', hourly_rate: '175', cost_rate: '75', lead_name: 'Alex Rivera' });
  const [showNewMilestone, setShowNewMilestone] = useState(false);
  const [msForm, setMsForm] = useState({ project_id: '1', title: '', target_date: '2026-12-15', bill_amount: '10000' });
  const [logModalTask, setLogModalTask] = useState<Task | null>(null);
  const [logHours, setLogHours] = useState('2.0');
  const [logNote, setLogNote] = useState('');
  const [logBillable, setLogBillable] = useState(true);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  useEffect(() => {
    if (!timerTask) return;
    const id = window.setInterval(() => setTimerSecs((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [timerTask]);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, pRes, mRes, tRes, tsRes, rt] = await Promise.all([
        apiFetch<ProjectsOverview>('/api/overview'),
        apiFetch<{ projects: Project[] }>('/api/projects'),
        apiFetch<{ milestones: Milestone[] }>('/api/milestones'),
        apiFetch<{ tasks: Task[] }>('/api/tasks'),
        apiFetch<{ timesheets: Timesheet[] }>('/api/timesheets'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setProjects(pRes.projects);
      setMilestones(mRes.milestones);
      setTasks(tRes.tasks);
      setTimesheets(tsRes.timesheets);
      setRuntime(rt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleStopAndSaveTimer = async () => {
    if (!timerTask) return;
    const hrs = Math.max(0.25, Math.round((timerSecs / 3600) * 4) / 4);
    await apiFetch('/api/timesheets', {
      method: 'POST',
      body: { task_id: timerTask.id, employee_name: timerTask.assignee, hours: hrs, billable: true, note: `Timer session (${fmtTimer(timerSecs)})` },
    });
    setTimerTask(null);
    setTimerSecs(0);
    await loadAll();
    notify(`Logged ${hrs}h from live stopwatch`);
  };

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#2563eb', ['--accent-soft' as string]: '#dbeafe', ['--accent-ink' as string]: '#1e40af' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">PR</div>
          <div>
            <h1>Projects &amp; Timesheets</h1>
            <div className="erp-brand-sub">Kanban Subtasks, Live Timer, Milestones &amp; Project Profitability</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="Projects sections">
          <button type="button" className={`erp-tab ${tab === 'kanban' ? 'active' : ''}`} onClick={() => setTab('kanban')}>Tasks ({tasks.length})</button>
          <button type="button" className={`erp-tab ${tab === 'portfolio' ? 'active' : ''}`} onClick={() => setTab('portfolio')}>Projects ({projects.length})</button>
          <button type="button" className={`erp-tab ${tab === 'milestones' ? 'active' : ''}`} onClick={() => setTab('milestones')}>Milestones ({milestones.length})</button>
          <button type="button" className={`erp-tab ${tab === 'timesheets' ? 'active' : ''}`} onClick={() => setTab('timesheets')}>Timesheets ({timesheets.length})</button>
          <button type="button" className={`erp-tab ${tab === 'profitability' ? 'active' : ''}`} onClick={() => setTab('profitability')}>Profitability</button>
        </nav>

        <div className="erp-actions">
          {tab === 'milestones' ? (
            <button type="button" className="btn btn-primary" onClick={() => setShowNewMilestone(true)}>+ Milestone</button>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setShowNewProject(true)}>+ Project</button>
              <button type="button" className="btn btn-primary" onClick={() => setShowNewTask(true)}>+ Task</button>
            </>
          )}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {timerTask && (
          <div className="alert alert-success">
            <span><strong>● Live Timer Running:</strong> {timerTask.title} ({timerTask.project_name}) — <code style={{ fontSize: '14px', fontWeight: 700 }}>{fmtTimer(timerSecs)}</code></span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" className="btn btn-sm btn-success" onClick={() => void handleStopAndSaveTimer()}>Stop &amp; Log Time</button>
              <button type="button" className="btn btn-sm" onClick={() => { setTimerTask(null); setTimerSecs(0); }}>Discard</button>
            </div>
          </div>
        )}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card"><span className="kpi-label">Active Projects</span><span className="kpi-value">{overview.activeProjects}</span><span className="kpi-sub">{overview.openTasks} open · {overview.doneTasks} done tasks</span></div>
            <div className="kpi-card"><span className="kpi-label">Milestones Reached</span><span className="kpi-value">{overview.milestonesReached} / {overview.milestonesTotal}</span><span className="kpi-sub">Client deliverables tracked</span></div>
            <div className="kpi-card"><span className="kpi-label">Hours Logged</span><span className="kpi-value">{formatNumber(overview.totalHours, 1)} h</span><span className="kpi-sub">{formatNumber(overview.billableHours, 1)} h billable</span></div>
            <div className="kpi-card"><span className="kpi-label">Billable Value &amp; Margin</span><span className="kpi-value" style={{ color: '#059669' }}>{formatCompactMoney(overview.billableRevenue)}</span><span className="kpi-sub">{formatPercent(overview.grossMargin)} margin (cost {formatCompactMoney(overview.laborCost)})</span></div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading projects from PHP + XDB SQLite...</div></div>
        ) : tab === 'kanban' ? (
          <TaskBoardView
            projects={projects}
            tasks={tasks}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            onMoveStage={async (taskId, stage) => { await apiFetch(`/api/tasks/${taskId}/stage`, { method: 'PATCH', body: { stage } }); await loadAll(); notify(`Task moved to ${stage}`); }}
            onStartTimer={(t) => { setTimerTask(t); setTimerSecs(0); }}
            onOpenLogTime={(t) => setLogModalTask(t)}
            onUpdateSubtasks={async (taskId, subtasks) => { await apiFetch(`/api/tasks/${taskId}/subtasks`, { method: 'PATCH', body: { subtasks } }); await loadAll(); }}
          />
        ) : tab === 'portfolio' ? (
          <PortfolioView projects={projects} onOpenBoard={(id) => { setSelectedProjectId(id); setTab('kanban'); }} />
        ) : tab === 'milestones' ? (
          <MilestonesView
            milestones={milestones}
            onToggle={async (id) => { await apiFetch(`/api/milestones/${id}/toggle`, { method: 'PATCH' }); await loadAll(); notify('Milestone updated'); }}
          />
        ) : tab === 'timesheets' ? (
          <TimesheetsView timesheets={timesheets} />
        ) : (
          <ProfitabilityView projects={projects} byEmployee={overview?.byEmployee ?? []} />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula Projects &amp; Timesheets · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showNewTask && (
        <div className="modal-backdrop" onClick={() => setShowNewTask(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/tasks', { method: 'POST', body: { ...taskForm, project_id: Number(taskForm.project_id), estimate_hours: Number(taskForm.estimate_hours) || 4 } });
              setShowNewTask(false);
              setTaskForm({ project_id: projects[0] ? String(projects[0].id) : '1', title: '', priority: 'Medium', assignee: 'Alex Rivera', estimate_hours: '6' });
              await loadAll();
              notify('Task created');
            }}
          >
            <div className="modal-head"><h3>New Task</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewTask(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Project</label><select className="select" value={taskForm.project_id} onChange={(e) => setTaskForm({ ...taskForm, project_id: e.target.value })}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
                <div className="field full"><label>Task Title *</label><input className="input" required value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} /></div>
                <div className="field"><label>Priority</label><select className="select" value={taskForm.priority} onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value })}><option value="Low">Low</option><option value="Medium">Medium</option><option value="High">High</option><option value="Urgent">Urgent</option></select></div>
                <div className="field"><label>Assignee</label><input className="input" value={taskForm.assignee} onChange={(e) => setTaskForm({ ...taskForm, assignee: e.target.value })} /></div>
                <div className="field"><label>Estimate (h)</label><input className="input" type="number" step="0.5" value={taskForm.estimate_hours} onChange={(e) => setTaskForm({ ...taskForm, estimate_hours: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewTask(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create Task</button></div>
          </form>
        </div>
      )}

      {showNewProject && (
        <div className="modal-backdrop" onClick={() => setShowNewProject(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/projects', { method: 'POST', body: { ...projForm, budget_hours: Number(projForm.budget_hours) || 60, hourly_rate: Number(projForm.hourly_rate) || 165, cost_rate: Number(projForm.cost_rate) || 75 } });
              setShowNewProject(false);
              setProjForm({ name: '', client_name: '', budget_hours: '60', hourly_rate: '175', cost_rate: '75', lead_name: 'Alex Rivera' });
              await loadAll();
              notify('Project created');
            }}
          >
            <div className="modal-head"><h3>New Project</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewProject(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Name *</label><input className="input" required value={projForm.name} onChange={(e) => setProjForm({ ...projForm, name: e.target.value })} /></div>
                <div className="field"><label>Client</label><input className="input" value={projForm.client_name} onChange={(e) => setProjForm({ ...projForm, client_name: e.target.value })} /></div>
                <div className="field"><label>Lead</label><input className="input" value={projForm.lead_name} onChange={(e) => setProjForm({ ...projForm, lead_name: e.target.value })} /></div>
                <div className="field"><label>Budget (h)</label><input className="input" type="number" value={projForm.budget_hours} onChange={(e) => setProjForm({ ...projForm, budget_hours: e.target.value })} /></div>
                <div className="field"><label>Bill Rate ($/h)</label><input className="input" type="number" value={projForm.hourly_rate} onChange={(e) => setProjForm({ ...projForm, hourly_rate: e.target.value })} /></div>
                <div className="field"><label>Cost Rate ($/h)</label><input className="input" type="number" value={projForm.cost_rate} onChange={(e) => setProjForm({ ...projForm, cost_rate: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewProject(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
          </form>
        </div>
      )}

      {showNewMilestone && (
        <div className="modal-backdrop" onClick={() => setShowNewMilestone(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/milestones', { method: 'POST', body: { ...msForm, project_id: Number(msForm.project_id), bill_amount: Number(msForm.bill_amount) || 0 } });
              setShowNewMilestone(false);
              setMsForm({ project_id: projects[0] ? String(projects[0].id) : '1', title: '', target_date: '2026-12-15', bill_amount: '10000' });
              await loadAll();
              notify('Milestone added');
            }}
          >
            <div className="modal-head"><h3>Add Milestone</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewMilestone(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Project</label><select className="select" value={msForm.project_id} onChange={(e) => setMsForm({ ...msForm, project_id: e.target.value })}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
                <div className="field full"><label>Title *</label><input className="input" required value={msForm.title} onChange={(e) => setMsForm({ ...msForm, title: e.target.value })} /></div>
                <div className="field"><label>Target Date</label><input className="input" type="date" value={msForm.target_date} onChange={(e) => setMsForm({ ...msForm, target_date: e.target.value })} /></div>
                <div className="field"><label>Billing Value ($)</label><input className="input" type="number" value={msForm.bill_amount} onChange={(e) => setMsForm({ ...msForm, bill_amount: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewMilestone(false)}>Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
          </form>
        </div>
      )}

      {logModalTask && (
        <div className="modal-backdrop" onClick={() => setLogModalTask(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/timesheets', { method: 'POST', body: { task_id: logModalTask.id, employee_name: logModalTask.assignee, hours: Number(logHours) || 1, billable: logBillable, note: logNote } });
              setLogModalTask(null);
              setLogHours('2.0');
              setLogNote('');
              await loadAll();
              notify('Timesheet entry saved');
            }}
          >
            <div className="modal-head"><h3>Log Time — {logModalTask.title}</h3><button type="button" className="btn btn-sm" onClick={() => setLogModalTask(null)}>Cancel</button></div>
            <div className="modal-body">
              <div className="field"><label>Hours *</label><input className="input" type="number" step="0.25" min="0.25" required value={logHours} onChange={(e) => setLogHours(e.target.value)} /></div>
              <div className="field"><label>Work Note</label><textarea className="textarea" value={logNote} onChange={(e) => setLogNote(e.target.value)} /></div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <input type="checkbox" checked={logBillable} onChange={(e) => setLogBillable(e.target.checked)} /> Billable to client
              </label>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setLogModalTask(null)}>Cancel</button><button type="submit" className="btn btn-primary">Save Entry</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
