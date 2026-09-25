/**
 * The agent loop: the model calls tools until the request is done.
 *
 *   request → reply (text + tool calls) → run each call → results back
 *   → (after a step that changed files) an automatic check → request …
 *
 * It ends when the model calls finish; pauses for ask_user, for a
 * confirmation Studio asks on its behalf, or for a network failure that
 * outlasted the retries; and stops on Stop, at the step cap, at the token
 * budget, or when the same failure keeps coming back. A paused or stopped
 * run keeps its conversation and can be continued.
 *
 * Replies stream where the provider can (stream.ts): the timeline shows the
 * text as it arrives and a row for each tool call as soon as its name is
 * known. A provider that refuses streaming, or sends a stream that cannot be
 * read, is asked again without it, and that is remembered per provider and
 * model like the tool protocol is.
 *
 * Every write is its own VFS transaction (executeTool.ts), so the run can be
 * reverted in one click and each step undone on its own. The run's record —
 * plan, timeline, counters — lives on its chat message, so it is saved with
 * the project and shown by the chat.
 */

import { AIProviderError, resolveModel } from '../aiProvider';
import { useAIStore } from '../../stores/aiStore';
import { useVFSStore } from '../../stores/vfsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { AIFailure, ProviderConfig } from '../../types/studio';
import type { SuppliedFiles } from '../changeset';
import { browserEnvironment, formatCheckReport, type AgentEnvironment } from './appCheck';
import { executeTool, type ToolOutcome } from './executeTool';
import { addUsage, cacheWeights, effectiveTokens, runEffective, type CacheWeights } from './budget';
import { holdPageForRun, releasePageForRun, wasInBackground } from './keepAlive';
import { buildAgentSystemPrompt, buildProjectContext } from './prompt';
import {
  canStream,
  encodeText,
  isToolsRejection,
  nativeProtocol,
  parseTextToolCalls,
  sendAgentRequest,
  streamFallback,
  type AgentReply,
  type StreamMode,
} from './protocol';
import { liveSubject, liveTextCalls, type StreamSink } from './stream';
import { WRITE_TOOLS } from './tools';
import type { AgentRunRecord, AgentToolCall, AgentToolResult, AgentTurn, CheckReport, LiveReply, PendingQuestion, RunEntry, ToolProtocol } from './types';

/** Deletes a run may make before it asks. */
export const FREE_DELETES = 3;
/**
 * How often the conversation is compacted, in steps. Between compactions it
 * only grows, so each request repeats the last one byte for byte and a
 * provider's prompt cache (or a local server's KV cache) serves all of it;
 * compacting rewrites old turns, and everything after the first rewritten one
 * is read afresh once. Compacting every step, as this once did, rewrote an
 * older turn each time and so re-sent the last ten steps uncached on every
 * request.
 */
const COMPACT_EVERY = 8;
/** How many steps a long read stays in the conversation, at the least, before a compaction may shorten it. */
const KEEP_READS_FOR = 6;
/** A reply's text longer than this is shortened once it is old. */
const LONG_TEXT_CHARS = 1_500;
/** Past this estimated size, the conversation is compacted now, and harder. */
const CONTEXT_SOFT_LIMIT_TOKENS = 60_000;
/** The same failure this many times in a row ends the run. */
const REPEAT_LIMIT = 3;
const RATE_LIMIT_RETRIES = 3;
/** How often a streaming reply is shown: often enough to read as live, rarely enough not to re-render per token. */
const LIVE_FLUSH_MS = 60;

const COMPACTABLE = new Set(['read_file', 'search_files', 'list_files', 'inspect_preview', 'run_app_function', 'lookup_components', 'read_docs']);

let environment: AgentEnvironment = browserEnvironment;
/** Swap how checks render and functions run (tests). */
export function setAgentEnvironment(next: AgentEnvironment | null): void {
  environment = next ?? browserEnvironment;
}

/** Waits the loop makes (retry back-off); replaceable in tests. */
let sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
export function setAgentSleep(fn: ((ms: number, signal?: AbortSignal) => Promise<void>) | null): void {
  sleep = fn ?? ((ms, signal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  }));
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface PendingCalls {
  calls: AgentToolCall[];
  index: number;
  results: Array<AgentToolResult & { step: number }>;
  wrote: boolean;
  checkedAfterWrite: boolean;
  finishSummary?: string;
}

/** A reply being streamed: what has arrived so far. */
interface LiveState {
  protocol: ToolProtocol;
  raw: string;
  thinking: boolean;
  thinkingChars: number;
  calls: Map<number, { id: string; name: string; args: string }>;
  /** Anything at all arrived: the request reached the model, and costs tokens. */
  received: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RunController {
  id: string;
  messageId: string;
  provider: ProviderConfig;
  kind: 'build' | 'edit';
  turns: AgentTurn[];
  /** Per tool result id: the step it was made at and its tool, for compaction. */
  resultSteps: Map<string, { step: number; name: string; check: boolean }>;
  seen: SuppliedFiles;
  pending: PendingCalls | null;
  abort: AbortController | null;
  /** False once the run was discarded (project switch): nothing it does after that may land. */
  alive: boolean;
  requests: number;
  deletes: number;
  approvedDeletes: number;
  nudged: boolean;
  repairNext: boolean;
  lastCheckSignature: string | null;
  sameCheckFailures: number;
  lastToolError: string | null;
  sameToolErrors: number;
  truncations: number;
  /**
   * The system prompt per protocol, built once per run: the project tree it
   * carries is as of the run's start (list_files shows it now), so the prompt
   * stays a stable prefix from request to request.
   */
  systems: Partial<Record<ToolProtocol, string>>;
  /** The reply being streamed, if one is. */
  live: LiveState | null;
  /** What cached tokens count as on this provider (budget.ts). */
  weights: CacheWeights;
  /** The last request's whole prompt, and whether the provider said it used its cache for it. */
  lastInput: number;
  cacheSeen: boolean;
  /** The step the conversation was last compacted at. */
  compactedAt: number;
}

const controllers = new Map<string, RunController>();
let activeRunId: string | null = null;

/** Whether a run can be driven further in this session (it has a live controller). */
export function isRunLive(runId: string): boolean {
  return controllers.has(runId) && controllers.get(runId)!.alive;
}

export function activeAgentRunId(): string | null {
  return activeRunId;
}

// ---------------------------------------------------------------------------
// The record on the chat message
// ---------------------------------------------------------------------------

function record(ctl: RunController): AgentRunRecord | undefined {
  return useAIStore.getState().messages.find((m) => m.id === ctl.messageId)?.run;
}

function patch(ctl: RunController, update: (run: AgentRunRecord) => AgentRunRecord): void {
  if (!ctl.alive) return;
  useAIStore.getState().replaceMessage(ctl.messageId, (message) => {
    if (!message.run) return message;
    const run = update(message.run);
    const tokens = run.tokens;
    return {
      ...message,
      run,
      content: run.summary ?? message.content,
      tokens: { input: tokens.input, output: tokens.output },
      transactionId: run.transactions.at(-1) ?? message.transactionId,
    };
  });
}

function addEntry(ctl: RunController, entry: RunEntry): void {
  patch(ctl, (run) => ({ ...run, entries: [...run.entries, entry] }));
}

function updateEntry(ctl: RunController, id: string, update: Partial<Extract<RunEntry, { kind: 'tool' }>>): void {
  patch(ctl, (run) => ({ ...run, entries: run.entries.map((e) => (e.id === id && e.kind === 'tool' ? { ...e, ...update } : e)) }));
}

function setStatus(ctl: RunController, status: AgentRunRecord['status'], reason?: string, extra: Partial<AgentRunRecord> = {}): void {
  const ending = status === 'finished' || status === 'failed' || status === 'stopped';
  patch(ctl, (run) => ({
    ...run,
    status,
    reason,
    question: status === 'waiting' ? run.question : undefined,
    // A reply shown as arriving is only shown while the run runs.
    live: status === 'running' ? run.live : undefined,
    ...(ending ? { endedAt: Date.now() } : { endedAt: undefined }),
    ...extra,
  }));
  const ai = useAIStore.getState();
  if (status === 'running') {
    ai.setAgentState('building');
  } else if (activeRunId === ctl.id) {
    ai.setAgentState('idle');
    ai.setCurrentStep('');
  }
  // While a run works or waits on the person, the page is held: a reload or a discarded tab would end it.
  if (!ctl.alive) return;
  if (status === 'running' || status === 'waiting') holdPageForRun(ctl.id);
  else releasePageForRun(ctl.id);
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The chat so far as the run's opening turns: earlier requests and what came of them, then the new request. */
function openingTurns(): AgentTurn[] {
  const messages = useAIStore.getState().messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-12);
  const turns: AgentTurn[] = [];
  for (const m of messages) {
    const text = (m.run?.summary ?? m.content ?? '').trim();
    if (!text) continue;
    if (m.role === 'user') turns.push({ role: 'user', text });
    else turns.push({ role: 'assistant', text: `(An earlier run in this project.) ${text}`, calls: [] });
  }
  while (turns.length > 0 && turns[0].role !== 'user') turns.shift();
  return turns;
}

function describeFailure(err: unknown): AIFailure {
  const at = Date.now();
  if (err instanceof AIProviderError) {
    switch (err.kind) {
      case 'timeout':
        return { kind: 'timeout', message: `${err.message} A slower provider may need a longer request timeout (Settings).`, at };
      case 'rate-limited':
        return { kind: 'rate-limited', message: err.message, retryAfterMs: err.retryAfterMs, at };
      case 'network':
        return { kind: 'network', message: err.message, at };
      case 'invalid-response':
        return { kind: 'invalid-response', message: err.message, at };
      case 'cancelled':
        return { kind: 'cancelled', message: err.message, at };
      case 'no-model':
        return { kind: 'setup', message: err.message, at };
      default:
        return { kind: 'provider', message: `${err.message} Check your API key and provider settings.`, at };
    }
  }
  return { kind: 'provider', message: err instanceof Error ? err.message : String(err), at };
}

export interface StartOptions {
  /** A new app from a brief: the first request may use the architect model. */
  kind?: 'build' | 'edit';
  /** Pick up a run a reload cut short: its record, and the note the new run starts from. */
  continuing?: { run: AgentRunRecord; note: string };
}

/** The last thing the person asked, which a run records so a later session can pick it up. */
function latestRequest(): string | undefined {
  return [...useAIStore.getState().messages].reverse().find((m) => m.role === 'user')?.content;
}

/** The statuses a run saved by an earlier page can be left in when the page went away mid-run. */
export function wasInterrupted(run: AgentRunRecord): boolean {
  return !isRunLive(run.id) && !run.continuedBy && (run.status === 'running' || run.status === 'waiting' || run.status === 'paused');
}

/** Why a run found interrupted stopped, in the person's words. */
export function interruptionReason(run: AgentRunRecord): string {
  return wasInBackground(run.id)
    ? 'This run stopped because the page reloaded while the tab was in the background (the browser may have discarded it). Its changes are kept.'
    : 'This run stopped because the page reloaded (or the project was closed while it ran). Its changes are kept.';
}

/**
 * What a run that picks up an interrupted one is told: the request, the plan
 * as far as it got, and the steps it took. The files as they are now open the
 * conversation, as they do for every run.
 */
export function continuationNote(run: AgentRunRecord): string {
  const plan = run.plan.length > 0 ? `Its plan, as far as it got:\n${run.plan.map((p) => `- [${p.status}] ${p.text}`).join('\n')}` : 'It had not made a plan yet.';
  const tools = run.entries.filter((e): e is Extract<RunEntry, { kind: 'tool' }> => e.kind === 'tool');
  const shown = tools.slice(-25);
  const steps = shown.map((e) => `- ${e.auto ? 'automatic check' : e.name}${e.subject ? ` ${e.subject}` : ''} — ${e.status === 'running' ? 'did not finish' : e.status}${e.status === 'error' && e.result ? `: ${e.result.split('\n')[0].slice(0, 160)}` : ''}${e.undone ? ' (undone)' : ''}`);
  const question = run.status === 'waiting' && run.question ? `\nIt was waiting for the person to answer: ${run.question.question}` : '';
  return [
    `This continues a run that stopped when the page reloaded, after ${run.steps} step(s); everything it wrote is kept.`,
    `The request was: ${run.request ?? '(see the conversation above)'}`,
    plan,
    tools.length > 0 ? `What it did${tools.length > shown.length ? ` (the last ${shown.length} of ${tools.length} steps)` : ''}:\n${steps.join('\n')}` : 'It had not changed anything yet.',
    `${question}\nThe project as it is now is in the first message. Read what you need, check the app, finish what is left of the plan, and call finish.`.trim(),
  ].join('\n\n');
}

/**
 * Continue a run a reload cut short. Its conversation died with the page, so
 * a new run starts from the request, the plan and the steps the old one
 * recorded, with the files as they are now; the old run's changes stay, and
 * Revert run still reverts them.
 */
export async function continueInterruptedRun(messageId: string): Promise<void> {
  const run = useAIStore.getState().messages.find((m) => m.id === messageId)?.run;
  if (!run || !wasInterrupted(run)) return;
  await startAgentRun({ kind: run.kind ?? 'edit', continuing: { run, note: continuationNote(run) } });
}

/**
 * Start a run for the latest user message in the chat. The caller has
 * already added that message. Refuses (with a chat message saying why) when
 * there is no provider, no model, or no budget left.
 */
export async function startAgentRun(options: StartOptions = {}): Promise<void> {
  const ai = useAIStore.getState();
  if (activeRunId && controllers.get(activeRunId)?.alive) {
    const current = controllers.get(activeRunId)!;
    const status = record(current)?.status;
    if (status === 'running') return;
  }
  if (ai.agentState === 'building') return;

  const say = (content: string, failure?: AIFailure) => {
    ai.addMessage({ id: newId(), role: 'assistant', content, timestamp: Date.now() });
    if (failure) ai.setLastFailure(failure);
  };
  const provider = ai.providers.find((p) => p.id === ai.activeProviderId);
  if (!provider) {
    say(
      ai.providers.length > 0
        ? 'Select an AI provider in Settings before generating.'
        : 'No AI provider is connected yet. Connect one — a local model, an OpenAI key or an Anthropic key — to start generating.',
      { kind: 'setup', message: 'Connect an AI provider to start generating.', at: Date.now() },
    );
    return;
  }
  if (!resolveModel(provider, ai.modelProfile.builder)) {
    const message = `${provider.name} has no model chosen yet. Choose one of its models in AI setup, then send again.`;
    say(message, { kind: 'setup', message, at: Date.now() });
    return;
  }
  if (ai.iterationsUsed >= ai.maxIterations) {
    say(`Iteration limit reached (${ai.maxIterations} runs this session). Reset the budget in Settings to continue.`);
    return;
  }
  if (ai.tokensUsed >= ai.tokenBudget) {
    say(`Token budget exhausted (${ai.tokenBudget.toLocaleString()} tokens this session). Reset the budget in Settings to continue.`, {
      kind: 'budget',
      message: 'The session token budget is used up.',
      at: Date.now(),
    });
    return;
  }

  // A run left paused or waiting is closed before a new one starts.
  if (activeRunId) {
    const previous = controllers.get(activeRunId);
    if (previous) closeRun(previous, 'stopped', 'A new request started another run.');
  }

  ai.setLastFailure(null);
  ai.incrementIteration();
  const id = newId();
  const messageId = newId();
  const settings = ai.agentSettings;
  const protocol = protocolFor(provider, resolveModel(provider, ai.modelProfile.builder));
  const kind = options.kind ?? 'edit';
  const continuing = options.continuing;
  const run: AgentRunRecord = {
    id,
    status: 'running',
    plan: continuing ? continuing.run.plan.map((p) => ({ ...p })) : [],
    entries: [],
    steps: 0,
    maxSteps: settings.maxSteps,
    tokens: { input: 0, output: 0 },
    tokenBudget: settings.runTokenBudget,
    protocol,
    transactions: [],
    startedAt: Date.now(),
    request: continuing ? continuing.run.request : latestRequest(),
    kind,
    ...(continuing ? { continues: continuing.run.id } : {}),
  };
  if (continuing) {
    // The interrupted run is closed, and points at the run that carries it on.
    const reason = `${interruptionReason(continuing.run)} It was continued in the run below.`;
    const old = ai.messages.find((m) => m.run?.id === continuing.run.id);
    if (old) {
      ai.replaceMessage(old.id, (m) => (m.run ? { ...m, run: { ...m.run, status: 'stopped', reason, continuedBy: id, question: undefined, live: undefined, endedAt: m.run.endedAt ?? Date.now() } } : m));
    }
  }
  ai.addMessage({ id: messageId, role: 'assistant', content: '', timestamp: Date.now(), run });

  const ctl: RunController = {
    id,
    messageId,
    provider,
    kind,
    // The project as it stands opens the conversation, not the system prompt, which stays the same across runs.
    turns: [{ role: 'user', text: buildProjectContext(kind) }, ...openingTurns(), ...(continuing ? [{ role: 'user' as const, text: continuing.note }] : [])],
    resultSteps: new Map(),
    seen: new Map(),
    pending: null,
    abort: null,
    alive: true,
    requests: 0,
    deletes: 0,
    approvedDeletes: 0,
    nudged: false,
    repairNext: false,
    lastCheckSignature: null,
    sameCheckFailures: 0,
    lastToolError: null,
    sameToolErrors: 0,
    truncations: 0,
    systems: {},
    live: null,
    weights: cacheWeights(provider),
    lastInput: 0,
    cacheSeen: false,
    compactedAt: 0,
  };
  controllers.set(id, ctl);
  activeRunId = id;
  setStatus(ctl, 'running');
  await drive(ctl);
}

function protocolKey(provider: ProviderConfig, model: string): string {
  return `${provider.id}:${model}`;
}

function protocolFor(provider: ProviderConfig, model: string): ToolProtocol {
  const native = nativeProtocol(provider);
  if (native === 'text') return 'text';
  return useAIStore.getState().toolProtocols[protocolKey(provider, model)] === 'text' ? 'text' : native;
}

// ---------------------------------------------------------------------------
// Stop, continue, answer, revert
// ---------------------------------------------------------------------------

/** Stop the active run; what it committed stays, and it can be continued. */
export function stopAgentRun(runId?: string): void {
  const ctl = controllers.get(runId ?? activeRunId ?? '');
  if (!ctl) return;
  ctl.abort?.abort();
  ctl.abort = null;
  const status = record(ctl)?.status;
  if (status === 'finished' || status === 'failed' || status === 'stopped') return;
  settlePending(ctl, 'Not run: the person stopped the run.');
  setStatus(ctl, 'stopped', 'Stopped by you. What was already written stays; Continue picks the run up where it stopped.');
}

/**
 * Abandon every run: used when the project changes under the chat. Nothing
 * a run does afterwards lands anywhere.
 */
export function discardAgentRuns(): void {
  for (const ctl of controllers.values()) {
    ctl.abort?.abort();
    ctl.alive = false;
  }
  controllers.clear();
  activeRunId = null;
  releasePageForRun();
  const ai = useAIStore.getState();
  ai.setAgentState('idle');
  ai.setCurrentStep('');
}

function closeRun(ctl: RunController, status: 'stopped' | 'failed', reason: string): void {
  ctl.abort?.abort();
  const current = record(ctl)?.status;
  // A run that already ended keeps its ending; only one still open is closed.
  if (current === 'running' || current === 'waiting' || current === 'paused') {
    settlePending(ctl, 'Not run: the run ended.');
    setStatus(ctl, status, reason);
  }
  ctl.alive = false;
  controllers.delete(ctl.id);
}

/** Answer every call still waiting with `text`, so the conversation stays a valid one. */
function settlePending(ctl: RunController, text: string): void {
  const pending = ctl.pending;
  if (!pending) return;
  for (let i = pending.index; i < pending.calls.length; i++) {
    const call = pending.calls[i];
    pending.results.push({ id: call.id, name: call.name, content: text, isError: true, step: record(ctl)?.steps ?? 0 });
  }
  ctl.turns.push({ role: 'tool', results: pending.results.map(({ step: _step, ...r }) => r) });
  ctl.pending = null;
  patch(ctl, (run) => ({ ...run, question: undefined }));
}

/** Continue a stopped, paused or limit-ended run, extending whichever limit it met. */
export async function continueAgentRun(runId: string): Promise<void> {
  const ctl = controllers.get(runId);
  if (!ctl || !ctl.alive) return;
  const run = record(ctl);
  if (!run || run.status === 'running' || run.status === 'waiting' || run.status === 'finished') return;
  if (useAIStore.getState().agentState === 'building') return;
  const settings = useAIStore.getState().agentSettings;
  activeRunId = ctl.id;
  patch(ctl, (r) => ({
    ...r,
    maxSteps: r.steps >= r.maxSteps ? r.steps + settings.maxSteps : r.maxSteps,
    tokenBudget: runEffective(r.tokens) >= r.tokenBudget * 0.9 ? runEffective(r.tokens) + settings.runTokenBudget : r.tokenBudget,
  }));
  ctl.sameCheckFailures = 0;
  ctl.sameToolErrors = 0;
  ctl.truncations = 0;
  const wasPaused = run.status === 'paused';
  setStatus(ctl, 'running');
  // A paused request is sent again as it was; a stopped or limited run is told it was resumed.
  if (!ctl.pending && (!wasPaused || ctl.turns.at(-1)?.role === 'assistant')) {
    ctl.turns.push({ role: 'user', text: 'The person resumed the run. Continue where you left off: check the app, fix what is broken, and call finish when the request is done.' });
  }
  await drive(ctl);
}

/** The person's answer to ask_user, or their decision on a confirmation. */
export async function answerAgentQuestion(runId: string, answer: string | boolean): Promise<void> {
  const ctl = controllers.get(runId);
  const run = ctl ? record(ctl) : undefined;
  if (!ctl || !run || run.status !== 'waiting' || !run.question || !ctl.pending) return;
  const question = run.question;
  const pending = ctl.pending;
  const call = pending.calls[pending.index];
  const step = run.steps;
  activeRunId = ctl.id;
  setStatus(ctl, 'running');
  if (question.confirm) {
    const approved = answer === true || (typeof answer === 'string' && /^(y|yes|ok|allow|approve)/i.test(answer.trim()));
    if (approved) {
      ctl.approvedDeletes++;
      updateEntry(ctl, call.id, { status: 'ok', result: 'Allowed by you' });
      await runOneCall(ctl, call, step, true);
    } else {
      pending.results.push({ id: call.id, name: call.name, content: 'The person declined this deletion. Do not delete it; carry on without deleting, or ask them.', isError: true, step });
      updateEntry(ctl, call.id, { status: 'error', result: 'Declined by you' });
    }
  } else {
    const text = typeof answer === 'string' ? answer.trim() : answer ? 'Yes.' : 'No.';
    pending.results.push({ id: call.id, name: call.name, content: `The person answered: ${text || '(no answer)'}`, isError: false, step });
    const entry = record(ctl)?.entries.find((e) => e.kind === 'tool' && e.id === call.id);
    if (entry) updateEntry(ctl, call.id, { status: 'ok', result: `You answered: ${text}` });
  }
  pending.index++;
  patch(ctl, (r) => ({ ...r, question: undefined }));
  const paused = await processCalls(ctl);
  if (paused || !ctl.alive || controllerStopped(ctl)) return;
  if (await finishCalls(ctl)) return;
  await drive(ctl);
}

export type RevertOutcome = { ok: true; paths: string[] } | { ok: false; reason: string };

/** Undo one step of a run by its transaction. */
export function undoAgentStep(runId: string, messageId: string, entryId: string): RevertOutcome {
  const message = useAIStore.getState().messages.find((m) => m.id === messageId);
  const entry = message?.run?.entries.find((e) => e.id === entryId);
  if (!message?.run || !entry || entry.kind !== 'tool' || !entry.transactionId) return { ok: false, reason: 'That step changed no files.' };
  const result = useVFSStore.getState().revertTransaction(entry.transactionId);
  if (!result.ok) return result;
  useAIStore.getState().replaceMessage(messageId, (m) =>
    m.run ? { ...m, run: { ...m.run, entries: m.run.entries.map((e) => (e.id === entryId && e.kind === 'tool' ? { ...e, undone: true } : e)) } } : m,
  );
  const ctl = controllers.get(runId);
  if (ctl) for (const path of result.paths) ctl.seen.delete(path);
  useWorkspaceStore.getState().setDirty(true);
  return result;
}

/** Revert everything a run wrote, newest step first. Stops at the first step a later edit blocks. */
export function revertAgentRun(messageId: string): RevertOutcome {
  const message = useAIStore.getState().messages.find((m) => m.id === messageId);
  const run = message?.run;
  if (!run) return { ok: false, reason: 'There is no run here.' };
  const history = useVFSStore.getState().history;
  const live = run.transactions.filter((t) => history.some((e) => e.transactionId === t));
  if (live.length === 0) return { ok: false, reason: 'Nothing from this run is left to revert.' };
  // Check every step first, so a run is reverted whole or not at all.
  const inRun = new Set(live);
  const touched = new Set(history.filter((e) => e.transactionId && inRun.has(e.transactionId)).map((e) => e.path));
  const first = history.findIndex((e) => e.transactionId && inRun.has(e.transactionId));
  for (let i = first + 1; i < history.length; i++) {
    const event = history[i];
    if (event.transactionId && inRun.has(event.transactionId)) continue;
    if (touched.has(event.path)) return { ok: false, reason: `${event.path} was edited after this run. Undo that edit first, or revert steps one by one.` };
  }
  const paths = new Set<string>();
  for (const id of [...live].reverse()) {
    const result = useVFSStore.getState().revertTransaction(id);
    if (!result.ok) return result;
    for (const p of result.paths) paths.add(p);
  }
  useAIStore.getState().replaceMessage(messageId, (m) => (m.run ? { ...m, run: { ...m.run, reverted: true, entries: m.run.entries.map((e) => (e.kind === 'tool' && e.transactionId ? { ...e, undone: true } : e)) } } : m));
  const ctl = controllers.get(run.id);
  if (ctl) for (const path of paths) ctl.seen.delete(path);
  useWorkspaceStore.getState().setDirty(true);
  return { ok: true, paths: [...paths] };
}

function controllerStopped(ctl: RunController): boolean {
  const status = record(ctl)?.status;
  return !ctl.alive || status === 'stopped' || status === 'failed' || status === 'finished' || status === 'paused';
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function end(ctl: RunController, status: 'finished' | 'failed', reason: string | undefined, summary?: string): void {
  setStatus(ctl, status, reason, summary !== undefined ? { summary } : {});
  if (status === 'failed' && reason) useAIStore.getState().setLastFailure({ kind: 'provider', message: reason, at: Date.now() });
  ctl.abort = null;
}

/** The file a call reads or changes. */
function callPaths(call: AgentToolCall): string[] {
  const paths = [call.input.path, call.input.from, call.input.to].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return paths.map((p) => p.trim().replace(/^\.\//, ''));
}

const lineTotal = (text: unknown) => (typeof text === 'string' ? text.split('\n').length : 0);

/**
 * Shorten what the model no longer needs, all at once (see COMPACT_EVERY):
 * - a long read, search, lookup or render older than `keep` steps, and a read
 *   of a file that has been read again or changed since;
 * - every check report but the latest;
 * - a write or edit of a file that a later write or edit replaced — the call
 *   keeps its path and a one-line record, not the old content;
 * - an old reply's long text.
 * The latest check, the latest version of each file the model wrote, the
 * newest turns and the person's own messages are left as they are.
 */
function compact(ctl: RunController, step: number, aggressive: boolean): void {
  const keep = aggressive ? 2 : KEEP_READS_FOR;
  // The latest check report is never compacted, wherever it is.
  let latestCheck: string | null = null;
  for (const [id, meta] of ctl.resultSteps) if (meta.check) latestCheck = id;

  // In conversation order: the last call that changed each file, and the last that read it.
  const lastChange = new Map<string, number>();
  const lastRead = new Map<string, number>();
  const order = new Map<string, number>();
  let n = 0;
  for (const turn of ctl.turns) {
    if (turn.role !== 'assistant') continue;
    for (const call of turn.calls) {
      order.set(call.id, ++n);
      for (const path of callPaths(call)) {
        if (WRITE_TOOLS.has(call.name)) lastChange.set(path, n);
        else if (call.name === 'read_file') lastRead.set(path, n);
      }
    }
  }
  const lastIndexOf = (role: AgentTurn['role']) => ctl.turns.map((t) => t.role).lastIndexOf(role);
  const lastAssistant = lastIndexOf('assistant');
  const lastTool = lastIndexOf('tool');
  const callOf = new Map<string, AgentToolCall>();
  for (const turn of ctl.turns) if (turn.role === 'assistant') for (const call of turn.calls) callOf.set(call.id, call);

  ctl.turns.forEach((turn, index) => {
    if (turn.role === 'tool') {
      if (index === lastTool) return;
      turn.results = turn.results.map((r) => {
        const meta = ctl.resultSteps.get(r.id);
        if (!meta || r.id === latestCheck || r.content.startsWith('[')) return r;
        const old = step - meta.step >= keep;
        if (meta.check && r.content.includes('[Automatic check]')) {
          return { ...r, content: r.content.replace(/\n\n\[Automatic check\][\s\S]*$/, '\n\n[Automatic check: superseded by a later check.]') };
        }
        if (meta.name === 'check_app' && r.content.length > 200) {
          return { ...r, content: `[check_app result from step ${meta.step}, superseded by a later check.]` };
        }
        if (COMPACTABLE.has(meta.name) && r.content.length > 600) {
          const call = callOf.get(r.id);
          const at = order.get(r.id) ?? 0;
          const path = call ? callPaths(call)[0] : undefined;
          const since = meta.name === 'read_file' && path !== undefined && ((lastChange.get(path) ?? 0) > at || (lastRead.get(path) ?? 0) > at);
          if (old || since) {
            const lines = r.content.split('\n').length;
            const why = since ? `${path} has been ${(lastChange.get(path) ?? 0) > at ? 'changed' : 'read again'} since` : 'removed to save context';
            return { ...r, content: `[${meta.name} result from step ${meta.step}, ${lines} lines; ${why}. Call ${meta.name} again if you still need it.]` };
          }
        }
        return r;
      });
      return;
    }
    if (turn.role !== 'assistant' || index === lastAssistant) return;
    let changed = false;
    const calls = turn.calls.map((call) => {
      if (call.name !== 'write_file' && call.name !== 'edit_file') return call;
      const [path] = callPaths(call);
      const at = order.get(call.id) ?? 0;
      if (path === undefined || (lastChange.get(path) ?? 0) <= at) return call;
      const meta = ctl.resultSteps.get(call.id);
      const when = meta ? ` at step ${meta.step}` : '';
      if (call.name === 'write_file' && typeof call.input.content === 'string' && call.input.content.length > 200) {
        changed = true;
        return { ...call, input: { path: call.input.path, content: `[${lineTotal(call.input.content)} lines written${when}; the file has been changed since — read_file shows it now]` } };
      }
      const size = String(call.input.old_string ?? '').length + String(call.input.new_string ?? '').length;
      if (call.name === 'edit_file' && size > 200) {
        changed = true;
        return { ...call, input: { path: call.input.path, old_string: `[${lineTotal(call.input.old_string)} lines]`, new_string: `[${lineTotal(call.input.new_string)} lines, applied${when}; the file has been changed since — read_file shows it now]` } };
      }
      return call;
    });
    const firstStep = turn.calls.map((c) => ctl.resultSteps.get(c.id)?.step).find((s) => s !== undefined);
    const oldText = firstStep !== undefined && step - firstStep >= keep && turn.text.length > LONG_TEXT_CHARS;
    const text = oldText ? `${turn.text.slice(0, 400).trimEnd()} […shortened to save context]` : turn.text;
    if (!changed && !oldText) return;
    // An echoed reply is re-encoded from what is left: an old turn's reasoning is not needed again.
    ctl.turns[index] = { role: 'assistant', text, calls };
  });
}

function contextSize(ctl: RunController, system: string): number {
  return estimateTokens(system) + estimateTokens(JSON.stringify(encodeText(ctl.turns)));
}

/**
 * What the next request's prompt will count as against the budgets. Once the
 * provider has said it serves this run's prefix from its cache, the part the
 * last request already sent is counted at the cache-read weight and the rest
 * at the cache-write weight (or face value); otherwise all at face value.
 */
function requestEstimate(ctl: RunController, size: number): number {
  if (!ctl.cacheSeen) return size;
  const prefix = Math.min(size, ctl.lastInput);
  return Math.ceil(prefix * ctl.weights.read + (size - prefix) * Math.max(1, ctl.weights.write));
}

function modelFor(ctl: RunController): { model: string; role: 'architect' | 'builder' | 'repair' } {
  const profile = useAIStore.getState().modelProfile;
  if (ctl.requests === 0 && ctl.kind === 'build' && profile.architect.trim()) return { model: resolveModel(ctl.provider, profile.architect), role: 'architect' };
  if (ctl.repairNext && profile.repair.trim()) return { model: resolveModel(ctl.provider, profile.repair), role: 'repair' };
  return { model: resolveModel(ctl.provider, profile.builder), role: 'builder' };
}

// ---------------------------------------------------------------------------
// The live reply
// ---------------------------------------------------------------------------

function liveView(live: LiveState): LiveReply {
  if (live.protocol === 'text') {
    // Calls written as text are shown as rows, not as markup in the text.
    const parsed = liveTextCalls(live.raw);
    return {
      text: parsed.text,
      thinking: live.thinking && !parsed.text && parsed.calls.length === 0,
      thinkingTokens: Math.ceil(live.thinkingChars / 4),
      calls: parsed.calls.map((c, i) => ({ id: `live-${i}`, name: c.name, subject: liveSubject(c.body) })),
    };
  }
  const text = live.raw.trim();
  return {
    text,
    thinking: live.thinking && !text && live.calls.size === 0,
    thinkingTokens: Math.ceil(live.thinkingChars / 4),
    calls: [...live.calls.entries()].sort(([a], [b]) => a - b).map(([i, c]) => ({ id: c.id || `live-${i}`, name: c.name, subject: liveSubject(c.args) })),
  };
}

/** Begin showing a streamed reply; the sink is what the stream writes to. */
function startLive(ctl: RunController, protocol: ToolProtocol): StreamSink {
  endLive(ctl);
  const live: LiveState = { protocol, raw: '', thinking: false, thinkingChars: 0, calls: new Map(), received: false, timer: null };
  ctl.live = live;
  const changed = () => {
    live.received = true;
    if (live.timer || ctl.live !== live) return;
    live.timer = setTimeout(() => {
      live.timer = null;
      if (ctl.live !== live) return;
      patch(ctl, (run) => (run.status === 'running' ? { ...run, live: liveView(live) } : run));
    }, LIVE_FLUSH_MS);
  };
  return {
    text: (delta) => {
      live.raw += delta;
      changed();
    },
    thinking: (delta) => {
      live.thinking = true;
      live.thinkingChars += delta.length;
      changed();
    },
    toolStart: (index, id, name) => {
      live.calls.set(index, { id, name, args: '' });
      changed();
    },
    toolArgs: (index, delta) => {
      const call = live.calls.get(index);
      if (call) call.args += delta;
      changed();
    },
  };
}

/** Stop showing the streamed reply; answers what had arrived. */
function endLive(ctl: RunController): LiveState | null {
  const live = ctl.live;
  if (!live) return null;
  if (live.timer) clearTimeout(live.timer);
  ctl.live = null;
  patch(ctl, (run) => (run.live ? { ...run, live: undefined } : run));
  return live;
}

/**
 * A streamed reply that ended early — stopped, dropped, unreadable — still
 * reached the model, and the provider counts what it sent. It is counted
 * here by estimate (a stream that did not finish never reports usage), and
 * on Stop the text that had arrived stays in the timeline.
 */
function settlePartial(ctl: RunController, system: string, live: LiveState, stopped: boolean): void {
  if (!live.received) return;
  const input = contextSize(ctl, system);
  const output = estimateTokens(live.raw + [...live.calls.values()].map((c) => c.name + c.args).join(''));
  // Nothing says what the cache served for a reply that never finished: counted at face value.
  useAIStore.getState().addTokens(input + output);
  patch(ctl, (r) => ({ ...r, tokens: addUsage(r.tokens, { inputTokens: input, outputTokens: output }, ctl.weights) }));
  const text = liveView(live).text;
  if (stopped && text) addEntry(ctl, { kind: 'text', id: newId(), text: `${text} …`, at: Date.now() });
}

async function request(ctl: RunController, system: string, model: string, protocol: ToolProtocol): Promise<AgentReply> {
  const settings = useAIStore.getState();
  const key = protocolKey(ctl.provider, model);
  let stream: StreamMode = canStream(ctl.provider) ? (settings.streamModes[key] ?? 'on') : 'off';
  let attempt = 0;
  let stripThinking = false;
  for (;;) {
    ctl.abort = new AbortController();
    const sink = stream === 'off' ? undefined : startLive(ctl, protocol);
    try {
      const turns = stripThinking ? ctl.turns.map((t) => (t.role === 'assistant' ? { ...t, anthropicContent: undefined } : t)) : ctl.turns;
      const reply = await sendAgentRequest(ctl.provider, {
        system,
        turns,
        protocol,
        model,
        signal: ctl.abort.signal,
        timeoutMs: settings.requestTimeoutMs,
        maxOutputTokens: settings.maxOutputTokens,
        stream,
        sink,
      });
      endLive(ctl);
      return reply;
    } catch (err) {
      const cancelled = err instanceof AIProviderError && err.kind === 'cancelled';
      const partial = endLive(ctl);
      if (partial) settlePartial(ctl, system, partial, cancelled);
      if (cancelled) throw err;
      if (!ctl.alive) throw err;
      // A stream the provider refused or could not send: ask again without it, and remember.
      const fallback: 'plain' | 'off' | null = stream === 'off' ? null : streamFallback(err);
      if (fallback) {
        const current = stream as StreamMode;
        stream = fallback === 'plain' && current === 'on' ? 'plain' : 'off';
        useAIStore.getState().rememberStreamMode(key, stream);
        useAIStore.getState().setCurrentStep(stream === 'off' ? 'The provider did not stream; asking again without streaming…' : 'Asking again without stream options…');
        continue;
      }
      // Echoed reasoning blocks can be refused once history was compacted; send without them.
      if (!stripThinking && protocol === 'anthropic' && err instanceof AIProviderError && err.kind === 'http' && /thinking/i.test(`${err.detail ?? ''}`)) {
        stripThinking = true;
        continue;
      }
      if (err instanceof AIProviderError && err.kind === 'rate-limited' && attempt < RATE_LIMIT_RETRIES) {
        attempt++;
        const wait = Math.min(err.retryAfterMs ?? 5_000 * attempt, 60_000);
        useAIStore.getState().setCurrentStep(`Rate limited; retrying in ${Math.ceil(wait / 1000)} s…`);
        await sleep(wait, ctl.abort?.signal);
        if (controllerStopped(ctl)) throw new AIProviderError('cancelled', 'The run was stopped.');
        continue;
      }
      if (err instanceof AIProviderError && err.kind === 'timeout' && attempt < 1) {
        attempt++;
        useAIStore.getState().setCurrentStep('The provider timed out; trying once more…');
        continue;
      }
      throw err;
    }
  }
}

function checkSignature(report: CheckReport): string {
  return report.errors.map((e) => e.replace(/\d+/g, '#')).sort().join('\n');
}

/** Run one call: the timeline row, the tool, the result. */
async function runOneCall(ctl: RunController, call: AgentToolCall, step: number, confirmed = false): Promise<ToolOutcome | null> {
  const pending = ctl.pending!;
  const entryId = confirmed ? `${call.id}-run` : call.id;
  const subjectGuess = String(call.input.path ?? call.input.from ?? call.input.name ?? call.input.page ?? call.input.topic ?? '');
  addEntry(ctl, { kind: 'tool', id: entryId, name: call.name, subject: subjectGuess, status: 'running', result: '', at: Date.now() });
  useAIStore.getState().setCurrentStep(`${call.name.replace(/_/g, ' ')}${subjectGuess ? ` ${subjectGuess}` : ''}…`);
  let outcome: ToolOutcome;
  try {
    outcome = await executeTool(call, {
      seen: ctl.seen,
      env: environment,
      blueprint: useWorkspaceStore.getState().blueprint,
      newTransactionId: newId,
    });
  } catch (err) {
    outcome = { content: `The tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true, subject: subjectGuess };
  }
  if (!ctl.alive) return null;
  if (outcome.changed) {
    pending.wrote = true;
    pending.checkedAfterWrite = false;
    if (call.name === 'delete_file') ctl.deletes++;
    if (outcome.transactionId) patch(ctl, (run) => ({ ...run, transactions: [...run.transactions, outcome.transactionId!] }));
    useAIStore.getState().incrementFilesChanged();
    const ws = useWorkspaceStore.getState();
    ws.setDirty(true);
    ws.addConsoleOutput(`[AI] ${outcome.content.split('\n')[0]}`);
    if (call.name === 'write_file' && ws.mode === 'describe') ws.setMode('design');
  }
  if (call.name === 'check_app') pending.checkedAfterWrite = true;
  if (outcome.control?.kind === 'plan') patch(ctl, (run) => ({ ...run, plan: outcome.control && outcome.control.kind === 'plan' ? outcome.control.items : run.plan }));
  if (outcome.control?.kind === 'finish') pending.finishSummary = outcome.control.summary;
  if (outcome.check) {
    ctl.resultSteps.set(call.id, { step, name: call.name, check: true });
  } else {
    ctl.resultSteps.set(call.id, { step, name: call.name, check: false });
  }
  updateEntry(ctl, entryId, {
    status: outcome.isError ? 'error' : 'ok',
    subject: outcome.subject || subjectGuess,
    result: outcome.content.slice(0, 2_000),
    transactionId: outcome.transactionId,
    diff: outcome.diff,
    check: outcome.check,
  });
  pending.results.push({ id: call.id, name: call.name, content: outcome.content || '(done)', isError: outcome.isError, step });

  // The same failing call, again and again, is not progress.
  if (outcome.isError) {
    const signature = `${call.name}:${outcome.content.slice(0, 200)}`;
    ctl.sameToolErrors = ctl.lastToolError === signature ? ctl.sameToolErrors + 1 : 1;
    ctl.lastToolError = signature;
  } else {
    ctl.sameToolErrors = 0;
    ctl.lastToolError = null;
  }
  return outcome;
}

/**
 * Run the reply's calls from where they stand. Returns true when the run
 * paused (a question, a confirmation) or ended part-way.
 */
async function processCalls(ctl: RunController): Promise<boolean> {
  const pending = ctl.pending;
  if (!pending) return false;
  const settings = useAIStore.getState().agentSettings;
  while (pending.index < pending.calls.length) {
    if (controllerStopped(ctl)) return true;
    const call = pending.calls[pending.index];
    const run = record(ctl);
    if (!run) return true;
    if (pending.finishSummary !== undefined) {
      pending.results.push({ id: call.id, name: call.name, content: 'Not run: finish ended the run.', isError: true, step: run.steps });
      pending.index++;
      continue;
    }
    if (run.steps >= run.maxSteps) {
      pending.results.push({ id: call.id, name: call.name, content: `Not run: the run reached its limit of ${run.maxSteps} steps.`, isError: true, step: run.steps });
      pending.index++;
      continue;
    }
    const step = run.steps + 1;
    patch(ctl, (r) => ({ ...r, steps: step }));

    // A delete past the free allowance waits for the person.
    if (call.name === 'delete_file' && settings.confirmDeletes && ctl.deletes >= FREE_DELETES + ctl.approvedDeletes) {
      const path = String(call.input.path ?? '');
      const question: PendingQuestion = { callId: call.id, question: `The agent wants to delete ${path}. This run has already deleted ${ctl.deletes} file(s). Allow it?`, confirm: { action: 'delete', paths: [path] } };
      addEntry(ctl, { kind: 'tool', id: call.id, name: call.name, subject: path, status: 'running', result: 'Waiting for you to allow or decline', at: Date.now() });
      patch(ctl, (r) => ({ ...r, question }));
      setStatus(ctl, 'waiting', 'Waiting for you to allow a deletion.');
      return true;
    }
    if (call.name === 'ask_user') {
      const question = String(call.input.question ?? '').trim() || 'The agent has a question.';
      addEntry(ctl, { kind: 'tool', id: call.id, name: call.name, subject: question.slice(0, 80), status: 'running', result: 'Waiting for your answer', at: Date.now() });
      patch(ctl, (r) => ({ ...r, question: { callId: call.id, question } }));
      setStatus(ctl, 'waiting', 'Waiting for your answer.');
      return true;
    }

    await runOneCall(ctl, call, step);
    if (!ctl.alive) return true;
    pending.index++;
    if (ctl.sameToolErrors >= REPEAT_LIMIT) {
      settlePending(ctl, 'Not run: the run stopped after repeated failures.');
      end(ctl, 'failed', `The same tool call failed ${REPEAT_LIMIT} times in a row (${ctl.lastToolError?.split(':')[0]}). The run stopped so it does not spend tokens going round in circles. Continue to let it try again, or give it more direction.`);
      return true;
    }
  }
  return false;
}

/**
 * After a reply's calls have all run: the automatic check, the results into
 * the conversation, and finish. Returns true when the run ended here.
 */
async function finishCalls(ctl: RunController): Promise<boolean> {
  const pending = ctl.pending;
  if (!pending) return false;
  const settings = useAIStore.getState().agentSettings;
  let failedRepeatedly: string | null = null;

  // A reply that writes and finishes in one go is checked too: finishing does
  // not get past a broken app.
  if (pending.wrote && !pending.checkedAfterWrite && settings.autoCheck) {
    const entryId = `${pending.calls.at(-1)?.id ?? newId()}-check`;
    addEntry(ctl, { kind: 'tool', id: entryId, name: 'check_app', subject: 'automatic check', status: 'running', result: '', at: Date.now(), auto: true });
    useAIStore.getState().setCurrentStep('Checking the app…');
    let report: CheckReport;
    try {
      report = await environment.checkApp(useVFSStore.getState().files, { blueprint: useWorkspaceStore.getState().blueprint });
    } catch (err) {
      report = { ok: false, errors: [`The check itself failed: ${err instanceof Error ? err.message : String(err)}`], warnings: [], renderedHeadless: false };
    }
    if (!ctl.alive) return true;
    updateEntry(ctl, entryId, { status: report.ok ? 'ok' : 'error', subject: report.page ?? 'app', result: formatCheckReport(report).slice(0, 2_000), check: report });
    // Appended to the last write's result: the one place every protocol lets a note travel.
    const lastWrite = [...pending.results].reverse().find((r) => WRITE_TOOLS.has(r.name) && !r.isError) ?? pending.results.at(-1);
    if (lastWrite) {
      lastWrite.content = `${lastWrite.content}\n\n[Automatic check] ${formatCheckReport(report)}`;
      const meta = ctl.resultSteps.get(lastWrite.id);
      ctl.resultSteps.set(lastWrite.id, { step: meta?.step ?? lastWrite.step, name: lastWrite.name, check: true });
    }
    if (!report.ok && pending.finishSummary !== undefined) {
      pending.finishSummary = undefined;
      const finish = pending.results.find((r) => r.name === 'finish');
      if (finish) {
        finish.content = 'Not accepted: the automatic check found errors after your last change. Fix them, then call finish again.';
        finish.isError = true;
        updateEntry(ctl, finish.id, { status: 'error', result: finish.content });
      }
      if (lastWrite && lastWrite !== finish) lastWrite.content += '\n\nfinish was not accepted: fix the errors above, then call finish.';
    }
    if (report.ok) {
      ctl.sameCheckFailures = 0;
      ctl.lastCheckSignature = null;
      ctl.repairNext = false;
    } else {
      const signature = checkSignature(report);
      ctl.sameCheckFailures = signature === ctl.lastCheckSignature ? ctl.sameCheckFailures + 1 : 1;
      ctl.lastCheckSignature = signature;
      ctl.repairNext = ctl.sameCheckFailures >= 2;
      if (ctl.sameCheckFailures >= REPEAT_LIMIT) failedRepeatedly = report.errors[0] ?? 'the check failed';
    }
  }

  ctl.turns.push({ role: 'tool', results: pending.results.map(({ step: _step, ...r }) => r) });
  const summary = pending.finishSummary;
  ctl.pending = null;

  if (failedRepeatedly) {
    end(ctl, 'failed', `The same check error came back ${REPEAT_LIMIT} times after the agent's fixes: ${failedRepeatedly}. The run stopped rather than keep trying the same thing. Continue to let it try again, or say how to fix it.`);
    return true;
  }
  if (summary !== undefined) {
    end(ctl, 'finished', undefined, summary);
    return true;
  }
  return false;
}

async function drive(ctl: RunController): Promise<void> {
  for (;;) {
    if (controllerStopped(ctl)) return;
    const run = record(ctl);
    if (!run) return;
    const ai = useAIStore.getState();

    if (run.steps >= run.maxSteps) {
      end(ctl, 'failed', `The run reached its limit of ${run.maxSteps} steps. Continue to give it another ${ai.agentSettings.maxSteps}, or raise the limit in Settings.`);
      return;
    }

    const { model, role } = modelFor(ctl);
    let protocol = protocolFor(ctl.provider, model);
    let system = (ctl.systems[protocol] ??= buildAgentSystemPrompt(protocol));
    if (contextSize(ctl, system) > CONTEXT_SOFT_LIMIT_TOKENS) {
      compact(ctl, run.steps, true);
      ctl.compactedAt = run.steps;
    } else if (run.steps - ctl.compactedAt >= COMPACT_EVERY) {
      compact(ctl, run.steps, false);
      ctl.compactedAt = run.steps;
    }

    // Reserve before sending: the request as it stands, and a reply as long as a reply may be.
    const estimate = requestEstimate(ctl, contextSize(ctl, system)) + ai.maxOutputTokens;
    const spent = runEffective(run.tokens);
    if (spent + estimate > run.tokenBudget) {
      end(ctl, 'failed', `The run's token budget would be exceeded: ${spent.toLocaleString()} of ${run.tokenBudget.toLocaleString()} tokens used, and the next request needs about ${estimate.toLocaleString()}. Continue to allow another ${ai.agentSettings.runTokenBudget.toLocaleString()}, or raise the per-run budget in Settings.`);
      return;
    }
    if (ai.tokensUsed + estimate > ai.tokenBudget) {
      const message = `The session's token budget would be exceeded: ${ai.tokensUsed.toLocaleString()} of ${ai.tokenBudget.toLocaleString()} used, and the next request needs about ${estimate.toLocaleString()}. The budget is a local guardrail, not a billing cap: raise or reset it in Settings, then Continue.`;
      end(ctl, 'failed', message);
      ai.setLastFailure({ kind: 'budget', message, at: Date.now() });
      return;
    }

    ai.setCurrentStep(role === 'architect' ? 'Planning the app…' : role === 'repair' ? 'Working out the fix…' : 'Thinking…');
    let reply: AgentReply;
    try {
      try {
        reply = await request(ctl, system, model, protocol);
      } catch (err) {
        if (protocol !== 'text' && isToolsRejection(err)) {
          // The provider or model does not take `tools`: remember, and carry on in text.
          useAIStore.getState().rememberToolProtocol(protocolKey(ctl.provider, model), 'text');
          protocol = 'text';
          system = ctl.systems[protocol] ??= buildAgentSystemPrompt(protocol);
          patch(ctl, (r) => ({ ...r, protocol }));
          addEntry(ctl, { kind: 'text', id: newId(), text: 'This model does not take tool calls natively; continuing with the text protocol.', at: Date.now() });
          reply = await request(ctl, system, model, protocol);
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (!ctl.alive) return;
      if (err instanceof AIProviderError && err.kind === 'cancelled') return;
      const failure = describeFailure(err);
      if (failure.kind === 'network' || failure.kind === 'timeout' || failure.kind === 'rate-limited') {
        setStatus(ctl, 'paused', `${failure.message} Nothing was lost: Resume sends the request again.`);
        useAIStore.getState().setLastFailure(failure);
        return;
      }
      end(ctl, 'failed', failure.message);
      useAIStore.getState().setLastFailure(failure);
      return;
    }
    if (!ctl.alive || controllerStopped(ctl)) return;
    ctl.requests++;
    ctl.abort = null;

    const used = reply.usage.inputTokens + reply.usage.outputTokens;
    // A provider that reports no usage is counted by estimate, so the budget still binds.
    const input = reply.usage.inputTokens || (used === 0 ? contextSize(ctl, system) : 0);
    const output = reply.usage.outputTokens || (used === 0 ? estimateTokens(reply.text + JSON.stringify(reply.calls.map((c) => c.input))) : 0);
    const usage = { ...reply.usage, inputTokens: input, outputTokens: output };
    ctl.lastInput = input;
    ctl.cacheSeen = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > 0;
    // The budgets count effective tokens: cached input weighted by what it costs (budget.ts).
    useAIStore.getState().addTokens(effectiveTokens(usage, ctl.weights));
    patch(ctl, (r) => ({ ...r, tokens: addUsage(r.tokens, usage, ctl.weights) }));

    // A native reply whose calls are written as text: this model does not use `tools`.
    if (reply.wroteCallsAsText && protocol !== 'text') {
      useAIStore.getState().rememberToolProtocol(protocolKey(ctl.provider, model), 'text');
      protocol = 'text';
      patch(ctl, (r) => ({ ...r, protocol }));
      const parsed = parseTextToolCalls(reply.text);
      reply = { ...reply, text: parsed.text, calls: parsed.calls, anthropicContent: undefined };
      addEntry(ctl, { kind: 'text', id: newId(), text: 'This model writes its tool calls as text; continuing with the text protocol.', at: Date.now() });
    }

    if (reply.status === 'refused') {
      end(ctl, 'failed', 'The model declined this request.');
      return;
    }
    if (reply.status === 'truncated') {
      ctl.truncations++;
      if (reply.text.trim()) ctl.turns.push({ role: 'assistant', text: reply.text, calls: [] });
      if (ctl.truncations >= REPEAT_LIMIT) {
        end(ctl, 'failed', `The model's replies were cut off at the output limit (${ai.maxOutputTokens.toLocaleString()} tokens) ${REPEAT_LIMIT} times. Raise Max output tokens in Settings, or ask for a smaller change.`);
        return;
      }
      ctl.turns.push({ role: 'user', text: `Your reply was cut off at the output limit (${ai.maxOutputTokens.toLocaleString()} tokens), so none of its tool calls were run. Make smaller calls: change existing files with edit_file, and write a large new file in parts (write the first part, then add to it with edit_file).` });
      addEntry(ctl, { kind: 'text', id: newId(), text: 'A reply was cut off at the output limit; nothing from it was applied, and the agent was asked for smaller steps.', at: Date.now() });
      continue;
    }
    ctl.truncations = 0;

    ctl.turns.push({ role: 'assistant', text: reply.text, calls: reply.calls, anthropicContent: protocol === 'anthropic' ? reply.anthropicContent : undefined });
    if (reply.text.trim()) addEntry(ctl, { kind: 'text', id: newId(), text: reply.text.trim(), at: Date.now() });

    if (reply.calls.length === 0) {
      if (!ctl.nudged && reply.status !== 'empty') {
        ctl.nudged = true;
        // Every readable block has been taken out of the text: a <tool_call> left in it is one that could not be read.
        const unreadable = protocol === 'text' && /<tool_call\b/i.test(reply.text);
        ctl.turns.push({
          role: 'user',
          text: unreadable
            ? 'Your <tool_call> could not be read, so nothing was run. Write each call as a block with a closing tag, e.g.\n<tool_call name="read_file">\n<arg name="path">ui/main.ui</arg>\n</tool_call>'
            : 'If the request is done, call finish with a short summary. Otherwise carry on with the tools.',
        });
        continue;
      }
      if (reply.status === 'empty' && !ctl.nudged) {
        ctl.nudged = true;
        ctl.turns.push({ role: 'user', text: 'Your reply was empty. Carry on with the tools, or call finish.' });
        continue;
      }
      // A build that wrote nothing and never called finish did not build anything, whatever its text says.
      if (ctl.kind === 'build' && (record(ctl)?.transactions.length ?? 0) === 0) {
        end(ctl, 'failed', 'The model stopped without building anything: it answered in text and never called the tools that write files. Smaller models often cannot drive tool calls. Continue to let it try again, or choose a larger model in AI setup.');
        return;
      }
      end(ctl, 'finished', undefined, reply.text.trim() || 'The agent stopped without a summary.');
      return;
    }
    ctl.nudged = false;

    ctl.pending = { calls: reply.calls, index: 0, results: [], wrote: false, checkedAfterWrite: false };
    const paused = await processCalls(ctl);
    if (paused || !ctl.alive || controllerStopped(ctl)) return;
    if (await finishCalls(ctl)) return;
  }
}
