import React, { useEffect, useRef, useState } from 'react';
import { useAIStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import type { ChatMessage } from '../../types/studio';
import type { AgentRunRecord, LiveReply, RunEntry } from '../../lib/agent/types';
import type { LineDiff } from '../../lib/agent/diff';
import { runEffective } from '../../lib/agent/budget';
import {
  answerAgentQuestion,
  continueAgentRun,
  continueInterruptedRun,
  interruptionReason,
  isRunLive,
  revertAgentRun,
  stopAgentRun,
  undoAgentStep,
  wasInterrupted,
} from '../../lib/agent/runAgent';

type IconName = React.ComponentProps<typeof Icon>['name'];

const TOOL_LABEL: Record<string, { done: string; doing: string; icon: IconName }> = {
  list_files: { done: 'Listed files', doing: 'Listing files', icon: 'folder' },
  read_file: { done: 'Read', doing: 'Reading', icon: 'file' },
  search_files: { done: 'Searched', doing: 'Searching', icon: 'search' },
  write_file: { done: 'Wrote', doing: 'Writing', icon: 'edit' },
  edit_file: { done: 'Edited', doing: 'Editing', icon: 'edit' },
  delete_file: { done: 'Deleted', doing: 'Deleting', icon: 'trash' },
  rename_file: { done: 'Renamed', doing: 'Renaming', icon: 'copy' },
  check_app: { done: 'Checked', doing: 'Checking', icon: 'zap' },
  inspect_preview: { done: 'Inspected', doing: 'Inspecting', icon: 'eye' },
  run_app_function: { done: 'Ran', doing: 'Running', icon: 'play' },
  lookup_components: { done: 'Looked up', doing: 'Looking up', icon: 'components' },
  read_docs: { done: 'Read the guide', doing: 'Reading the guide', icon: 'info' },
  update_plan: { done: 'Updated the plan', doing: 'Updating the plan', icon: 'target' },
  ask_user: { done: 'Asked you', doing: 'Asking you', icon: 'info' },
  finish: { done: 'Finished', doing: 'Finishing', icon: 'check' },
};

/** Rows whose subject is words (a question, a count), not a path or a name in code. */
const PROSE_SUBJECT = new Set(['update_plan', 'ask_user', 'finish', 'read_docs']);

const STATUS_TEXT: Record<AgentRunRecord['status'], string> = {
  running: 'Building',
  waiting: 'Waiting for you',
  paused: 'Paused',
  stopped: 'Stopped',
  finished: 'Finished',
  failed: 'Stopped early',
};

function formatTokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function DiffView({ diff }: { diff: LineDiff }) {
  return (
    <div className="st-run-diff">
      <div className="st-run-diff-head">
        <span className="st-run-path">{diff.path}</span>
        <span className="st-run-diff-count">+{diff.added} −{diff.removed}</span>
      </div>
      <pre className="st-run-diff-body" aria-label={`Changes to ${diff.path}`}>
        {diff.lines.map(([kind, text], i) => (
          <span key={i} className="st-run-diff-line" data-kind={kind === '+' ? 'add' : kind === '-' ? 'del' : kind === '…' ? 'fold' : 'same'}>
            <span className="st-run-diff-mark" aria-hidden="true">{kind === '…' ? '⋯' : kind}</span>
            {kind === '+' ? <span className="st-visually-hidden">added: </span> : kind === '-' ? <span className="st-visually-hidden">removed: </span> : null}
            {text || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

function StepRow({ entry, run, message, busy }: { entry: Extract<RunEntry, { kind: 'tool' }>; run: AgentRunRecord; message: ChatMessage; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const label = TOOL_LABEL[entry.name] ?? { done: entry.name, doing: entry.name, icon: 'terminal' as IconName };
  const history = useVFSStore((s) => s.history);
  const canUndo = Boolean(entry.transactionId && !entry.undone && !busy && history.some((e) => e.transactionId === entry.transactionId));
  const hasDetail = Boolean(entry.diff?.length || entry.check || entry.result);
  // A row waiting on the person is not the machine running: no mint spinner.
  const waiting = entry.status === 'running' && run.status === 'waiting' && run.question?.callId === entry.id;
  const verb = waiting ? (entry.name === 'ask_user' ? 'Asked you' : 'Waiting for you') : entry.status === 'running' ? `${label.doing}…` : entry.auto ? 'Automatic check' : label.done;
  const checkFailed = entry.check && !entry.check.ok;
  const detailId = `run-step-${entry.id}`;
  return (
    <li className="st-run-step" data-status={entry.status} data-auto={entry.auto || undefined}>
      <div className="st-run-row">
        <button
          type="button"
          className="st-run-toggle"
          aria-expanded={hasDetail ? open : undefined}
          aria-controls={hasDetail ? detailId : undefined}
          disabled={!hasDetail}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="st-run-icon" aria-hidden="true">
            {waiting ? <Icon name="clock" size={13} /> : entry.status === 'running' ? <span className="st-run-spinner" /> : <Icon name={entry.status === 'error' ? 'alert-circle' : label.icon} size={13} />}
          </span>
          <span className="st-run-verb">{verb}</span>
          {entry.subject && <span className={`st-run-subject${PROSE_SUBJECT.has(entry.name) ? ' is-text' : ''}`}>{entry.subject}</span>}
          {entry.diff?.[0] && entry.status === 'ok' && (
            <span className="st-run-delta" aria-label={`${entry.diff[0].added} lines added, ${entry.diff[0].removed} removed`}>
              +{entry.diff[0].added} −{entry.diff[0].removed}
            </span>
          )}
          {entry.check && <span className={`st-run-badge${checkFailed ? ' is-error' : ''}`}>{entry.check.ok ? 'passed' : `${entry.check.errors.length} error${entry.check.errors.length === 1 ? '' : 's'}`}</span>}
          {entry.status === 'error' && !entry.check && <span className="st-run-badge is-error">failed</span>}
          {entry.undone && <span className="st-run-badge">undone</span>}
          {hasDetail && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="st-run-chevron" />}
        </button>
        {canUndo && (
          <button
            type="button"
            className="st-btn st-btn-ghost st-btn-xs"
            title="Put back the files this step changed"
            aria-label={`Undo: ${verb} ${entry.subject}`}
            onClick={() => {
              const result = undoAgentStep(run.id, message.id, entry.id);
              setNotice(result.ok ? null : result.reason);
            }}
          >
            <Icon name="undo" size={12} /> Undo
          </button>
        )}
      </div>
      {notice && <p className="st-run-notice" role="alert">{notice}</p>}
      {open && hasDetail && (
        <div className="st-run-detail" id={detailId}>
          {entry.check && (
            <div className="st-run-check">
              {entry.check.errors.length > 0 && (
                <ul className="st-run-errors">
                  {entry.check.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
              {entry.check.warnings.length > 0 && (
                <ul className="st-run-warnings">
                  {entry.check.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
              {entry.check.ok && <p className="st-run-ok">No errors{entry.check.page ? ` in ${entry.check.page}` : ''}{entry.check.renderedHeadless ? '; it rendered.' : '.'}</p>}
              {entry.check.rendered && <p className="st-run-rendered">Rendered: {entry.check.rendered}</p>}
            </div>
          )}
          {entry.diff?.map((d) => <DiffView key={d.path} diff={d} />)}
          {!entry.check && !entry.diff?.length && entry.result && <pre className="st-run-result">{entry.result}</pre>}
        </div>
      )}
    </li>
  );
}

/**
 * A reply still arriving: its text so far, and a row per tool call as soon as
 * the call's name is known. The row's subject fills in once its path (or
 * name, page, topic) has arrived whole. The real rows replace these when
 * the reply is complete.
 */
function LiveRows({ reply }: { reply: LiveReply }) {
  return (
    <>
      {reply.text && <li className="st-run-text is-live" data-live="text">{reply.text}</li>}
      {reply.calls.map((call) => {
        const label = TOOL_LABEL[call.name] ?? { done: call.name, doing: call.name, icon: 'terminal' as IconName };
        return (
          <li key={call.id} className="st-run-step" data-status="running" data-live="call">
            <div className="st-run-row">
              <span className="st-run-toggle">
                <span className="st-run-icon" aria-hidden="true"><span className="st-run-spinner" /></span>
                <span className="st-run-verb">{label.doing}…</span>
                {call.subject && <span className={`st-run-subject${PROSE_SUBJECT.has(call.name) ? ' is-text' : ''}`}>{call.subject}</span>}
              </span>
            </div>
          </li>
        );
      })}
    </>
  );
}

function AskBox({ run }: { run: AgentRunRecord }) {
  const [answer, setAnswer] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const question = run.question!;
  useEffect(() => {
    inputRef.current?.focus();
  }, [question.callId]);
  if (question.confirm) {
    return (
      <div className="st-run-ask" role="group" aria-labelledby={`ask-${run.id}`}>
        <p id={`ask-${run.id}`} className="st-run-ask-q">{question.question}</p>
        <div className="st-run-actions">
          <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => void answerAgentQuestion(run.id, true)}>Allow</button>
          <button type="button" className="st-btn st-btn-sm" onClick={() => void answerAgentQuestion(run.id, false)}>Decline</button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="st-run-ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (!answer.trim()) return;
        void answerAgentQuestion(run.id, answer);
        setAnswer('');
      }}
    >
      <label htmlFor={`ask-${run.id}`} className="st-run-ask-q">{question.question}</label>
      <textarea
        id={`ask-${run.id}`}
        ref={inputRef}
        className="st-run-ask-input"
        rows={2}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Your answer"
      />
      <div className="st-run-actions">
        <button type="submit" className="st-btn st-btn-primary st-btn-sm" disabled={!answer.trim()}>Send answer</button>
      </div>
    </form>
  );
}

/**
 * Whether a saved run record has the shape the timeline reads. A record cut
 * short by a failed save, or written by another version, is shown as a note
 * rather than taking the chat down with it.
 */
export function isReadableRun(run: unknown): run is AgentRunRecord {
  const r = run as Partial<AgentRunRecord> | null;
  return Boolean(
    r && typeof r === 'object' && typeof r.id === 'string' && typeof r.status === 'string' &&
      Array.isArray(r.entries) && Array.isArray(r.plan) && Array.isArray(r.transactions) &&
      typeof r.steps === 'number' && typeof r.maxSteps === 'number' && r.tokens && typeof r.tokens === 'object',
  );
}

export function RunTimeline({ message }: { message: ChatMessage }) {
  const run = message.run!;
  const agentState = useAIStore((s) => s.agentState);
  const currentStep = useAIStore((s) => s.currentStep);
  const history = useVFSStore((s) => s.history);
  const [notice, setNotice] = useState<string | null>(null);
  const live = isRunLive(run.id);
  // A run saved mid-way by an earlier session cannot be driven from here.
  // A run saved mid-way by a page that has since reloaded: its conversation is gone, its record is not.
  const interrupted = wasInterrupted(run);
  const status: AgentRunRecord['status'] = interrupted ? 'stopped' : run.status;
  const running = status === 'running';
  const busy = agentState === 'building';
  const canContinue = ((live && (status === 'stopped' || status === 'failed' || status === 'paused')) || interrupted) && !busy;
  const revertable = !run.reverted && run.transactions.some((t) => history.some((e) => e.transactionId === t));
  const plan = run.plan;
  const done = plan.filter((p) => p.status === 'done').length;
  const reason = interrupted ? `${interruptionReason(run)} Continue starts a new run from its request, its plan and the files as they are now.` : run.reason;

  return (
    <section className="st-run" data-state={status} aria-label="Agent run">
      <header className="st-run-head">
        <span className="st-run-state" data-state={status}>
          {running ? <span className="st-live">{STATUS_TEXT[status]}</span> : <span>{STATUS_TEXT[status]}</span>}
        </span>
        <span className="st-run-counts">
          <span title="Tool calls in this run">{run.steps}/{run.maxSteps} steps</span>
          <span aria-hidden="true"> · </span>
          <span
            title={`${run.tokens.input.toLocaleString()} in${run.tokens.cached ? ` (${run.tokens.cached.toLocaleString()} read from the provider's cache)` : ''}, ${run.tokens.output.toLocaleString()} out; ${runEffective(run.tokens).toLocaleString()} effective of a ${run.tokenBudget.toLocaleString()}-token run budget`}
          >
            {formatTokens(run.tokens.input + run.tokens.output)} tokens
            {run.tokens.cached ? <span className="st-run-cached"> ({formatTokens(run.tokens.cached)} cached)</span> : null}
          </span>
          {run.protocol === 'text' && <span className="st-run-proto" title="This model does not take tool calls natively, so they travel as text">text tools</span>}
        </span>
      </header>
      {/* Status for assistive technology: the state and what the agent is doing, not every row. */}
      <p className="st-visually-hidden" role="status" aria-live="polite">
        {running ? `Agent ${currentStep || 'working'}` : `Agent run ${STATUS_TEXT[status].toLowerCase()}`}
      </p>

      {run.continues && <p className="st-run-reason">Continues the run above, which stopped when the page reloaded.</p>}
      {plan.length > 0 && (
        <div className="st-run-plan">
          <div className="st-run-plan-head">Plan <span className="st-run-plan-count">{done}/{plan.length}</span></div>
          <ol>
            {plan.map((item, i) => (
              <li key={i} data-status={item.status}>
                <span className="st-run-plan-mark" aria-hidden="true">
                  {item.status === 'done' ? <Icon name="check" size={11} /> : item.status === 'active' ? <span className="st-run-plan-dot" /> : null}
                </span>
                <span className="st-visually-hidden">{item.status === 'done' ? 'Done: ' : item.status === 'active' ? 'In progress: ' : 'To do: '}</span>
                {item.text}
              </li>
            ))}
          </ol>
        </div>
      )}

      <ol className="st-run-steps" aria-label="Steps" aria-live="off">
        {run.entries.filter((entry) => !(entry.kind === 'tool' && entry.name === 'finish' && entry.status === 'ok')).map((entry) =>
          entry.kind === 'text' ? (
            <li key={entry.id} className="st-run-text">{entry.text}</li>
          ) : (
            <StepRow key={entry.id} entry={entry} run={run} message={message} busy={busy} />
          ),
        )}
        {running && live && run.live && <LiveRows reply={run.live} />}
        {running && currentStep && !(live && run.live && (run.live.text || run.live.calls.length > 0)) && (
          <li className="st-run-now" aria-hidden="true">
            <span className="st-run-spinner" /> {currentStep}
            {live && run.live?.thinking && (run.live.thinkingTokens ?? 0) > 0 && (
              <span className="st-run-thinking"> reasoning, about {formatTokens(run.live.thinkingTokens ?? 0)} tokens so far</span>
            )}
          </li>
        )}
      </ol>

      {status === 'waiting' && run.question && live && <AskBox run={run} />}

      {run.summary && status === 'finished' && (
        <div className="st-run-summary">
          <div className="st-run-summary-head"><Icon name="check" size={13} /> Done</div>
          <p>{run.summary}</p>
        </div>
      )}
      {reason && status !== 'running' && status !== 'finished' && <p className={`st-run-reason${status === 'failed' ? ' is-error' : ''}`}>{reason}</p>}
      {notice && <p className="st-run-notice" role="alert">{notice}</p>}

      {(running || canContinue || revertable) && (
        <div className="st-run-actions">
          {running && (
            <button type="button" className="st-btn st-btn-sm" onClick={() => stopAgentRun(run.id)}>
              <Icon name="pause" size={13} /> Stop
            </button>
          )}
          {canContinue && (
            <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => void (interrupted ? continueInterruptedRun(message.id) : continueAgentRun(run.id))}>
              <Icon name="play" size={13} /> {status === 'paused' ? 'Resume' : 'Continue'}
            </button>
          )}
          {revertable && !running && (
            <button
              type="button"
              className="st-btn st-btn-sm st-run-revert"
              title="Put back every file this run changed"
              onClick={() => {
                const result = revertAgentRun(message.id);
                setNotice(result.ok ? `Reverted ${result.paths.length} file(s).` : result.reason);
              }}
            >
              <Icon name="undo" size={13} /> Revert run
            </button>
          )}
        </div>
      )}
      {run.reverted && <p className="st-run-reason">This run was reverted.</p>}
    </section>
  );
}
