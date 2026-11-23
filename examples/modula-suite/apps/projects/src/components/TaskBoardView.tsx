import React, { useState } from 'react';
import { formatNumber } from '../../../../shared/ui/format';
import { TASK_STAGES, type Project, type Subtask, type Task } from '../types';

function nextStage(stage: string): string | null {
  const idx = TASK_STAGES.indexOf(stage as (typeof TASK_STAGES)[number]);
  return idx >= 0 && idx < TASK_STAGES.length - 1 ? TASK_STAGES[idx + 1] : null;
}

function prioBadge(p: string): string {
  if (p === 'Urgent') return 'badge-danger';
  if (p === 'High') return 'badge-warning';
  return 'badge-neutral';
}

interface TaskBoardViewProps {
  projects: Project[];
  tasks: Task[];
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onMoveStage: (taskId: number, stage: string) => Promise<void>;
  onStartTimer: (task: Task) => void;
  onOpenLogTime: (task: Task) => void;
  onUpdateSubtasks: (taskId: number, subtasks: Subtask[]) => Promise<void>;
}

export const TaskBoardView: React.FC<TaskBoardViewProps> = ({
  projects,
  tasks,
  selectedProjectId,
  onSelectProject,
  onMoveStage,
  onStartTimer,
  onOpenLogTime,
  onUpdateSubtasks,
}) => {
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const [newSubText, setNewSubText] = useState('');

  const visibleTasks = selectedProjectId === 'all' ? tasks : tasks.filter((t) => String(t.project_id) === selectedProjectId);
  const detailTask = detailTaskId !== null ? tasks.find((t) => t.id === detailTaskId) ?? null : null;

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <label style={{ fontSize: '12.5px', fontWeight: 600 }}>Project:</label>
          <select className="select" value={selectedProjectId} onChange={(e) => onSelectProject(e.target.value)}>
            <option value="all">All Projects ({tasks.length})</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="muted" style={{ fontSize: '12px' }}>Click any card for Subtask Checklist · Click ▶ for live stopwatch</span>
        </div>
      </div>

      <div className="kanban">
        {TASK_STAGES.map((stage) => {
          const list = visibleTasks.filter((t) => t.stage === stage);
          return (
            <div key={stage} className="kanban-col">
              <div className="kanban-col-head">
                <span className="kanban-col-title">{stage} <span className="badge badge-neutral">{list.length}</span></span>
              </div>
              {list.map((t) => {
                const nxt = nextStage(t.stage);
                const subDone = t.subtasks.filter((s) => s.done).length;
                return (
                  <div key={t.id} className="kanban-card" onClick={() => setDetailTaskId(t.id)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
                      <span className={`badge ${prioBadge(t.priority)}`}>{t.priority}</span>
                      <span className="muted" style={{ fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}>
                        {formatNumber(Number(t.logged_hours), 1)}h / {formatNumber(Number(t.estimate_hours), 1)}h
                      </span>
                    </div>
                    <div className="kanban-card-title">{t.title}</div>
                    <div className="kanban-card-sub">{t.project_name} · {t.assignee}</div>
                    {t.subtasks.length > 0 && (
                      <div style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>Checklist: {subDone}/{t.subtasks.length} done</div>
                    )}
                    <div className="kanban-card-foot" onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button type="button" className="btn btn-sm" onClick={() => onStartTimer(t)} title="Start live stopwatch">▶</button>
                        <button type="button" className="btn btn-sm" onClick={() => onOpenLogTime(t)}>+ Time</button>
                      </div>
                      {nxt && <button type="button" className="btn btn-sm btn-primary" onClick={() => void onMoveStage(t.id, nxt)}>{nxt} →</button>}
                    </div>
                  </div>
                );
              })}
              {list.length === 0 && <div className="empty-state" style={{ padding: '16px 8px' }}>Empty</div>}
            </div>
          );
        })}
      </div>

      {detailTask && (
        <div className="modal-backdrop" onClick={() => setDetailTaskId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>{detailTask.title}</h3>
                <div className="muted" style={{ fontSize: '12px' }}>{detailTask.project_name} · {detailTask.assignee} · {detailTask.logged_hours}h / {detailTask.estimate_hours}h</div>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setDetailTaskId(null)}>Close</button>
            </div>
            <div className="modal-body">
              <strong style={{ fontSize: '13px' }}>Subtask Checklist</strong>
              {detailTask.subtasks.length === 0 && <div className="muted" style={{ fontSize: '12.5px' }}>No subtasks yet.</div>}
              {detailTask.subtasks.map((s, idx) => (
                <label key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={s.done}
                    onChange={() => {
                      const next = detailTask.subtasks.map((it, i) => (i === idx ? { ...it, done: !it.done } : it));
                      void onUpdateSubtasks(detailTask.id, next);
                    }}
                  />
                  <span style={{ textDecoration: s.done ? 'line-through' : 'none', color: s.done ? 'var(--ink-muted)' : 'var(--ink)' }}>{s.text}</span>
                </label>
              ))}
              <form
                style={{ display: 'flex', gap: '8px', marginTop: '6px' }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newSubText.trim()) return;
                  await onUpdateSubtasks(detailTask.id, [...detailTask.subtasks, { text: newSubText.trim(), done: false }]);
                  setNewSubText('');
                }}
              >
                <input className="input" style={{ flex: 1 }} placeholder="Add checklist step..." value={newSubText} onChange={(e) => setNewSubText(e.target.value)} />
                <button type="submit" className="btn btn-primary btn-sm">Add</button>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
