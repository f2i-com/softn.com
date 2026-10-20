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

import { randomUUID } from '@softn/bundle-format/crypto';
import { AIProviderError, resolveModel } from '../aiProvider';
import { kindForStatus } from '../providerConnection';
import { useAIStore } from '../../stores/aiStore';
import { useVFSStore } from '../../stores/vfsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { AIFailure, ProviderConfig } from '../../types/studio';
import type { SuppliedFiles } from '../changeset';
import { browserEnvironment, formatCheckReport, type AgentEnvironment } from './appCheck';
import { executeTool, type ToolOutcome } from './executeTool';
import { revertRunFromJournal, undoStepFromJournal, type RevertOutcome } from './runRevert';
import { compact } from './compaction';
import { addUsage, cacheWeights, effectiveTokens, runEffective, type CacheWeights } from './budget';
import { holdPageForRun, releasePageForRun, runInAnotherTab, wasInBackground } from './keepAlive';
import { buildAgentSystemPrompt, buildProjectContext } from './prompt';
import { takePreviewFaults } from '../previewFaults';
import { saveForRun } from '../projectSession';
import {
  canStream,
  encodeText,
  isDefiniteToolsRejection,
  isOutputLimitRejection,
  isToolsRejection,
  nativeProtocol,
  outputLimitFrom,
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
/** Past this estimated size, the conversation is compacted now, and harder. */
const CONTEXT_SOFT_LIMIT_TOKENS = 60_000;
/** The same failure this many times in a row ends the run. */
const REPEAT_LIMIT = 3;
/** How many times a reply cut off at the output limit is asked for again before the run stops. */
const TRUNCATION_RETRIES = 1;
const RATE_LIMIT_RETRIES = 3;
/** How often a streaming reply is shown: often enough to read as live, rarely enough not to re-render per token. */
const LIVE_FLUSH_MS = 60;

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
  /** The run's last check, when it failed: finish is not accepted over it (see finishCalls). */
  failingCheck: CheckReport | null;
  /** Finishes refused one after another over that check; the second ends the run. */
  finishRefusals: number;
  /** The person was asked after such a refusal and answered: the next finish is theirs to have. */
  personAnsweredFailingCheck: boolean;
  /** Files this run wrote whose save met another tab's change, and the model has been told so. */
  toldConflicts: Set<string>;
  /** The model has been told its work could not be saved, and has not been told since that it is. */
  toldUnsaved: boolean;
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
  /**
   * Models (`providerId:model`) moved to the text protocol for this run only: a server error
   * that read like refused `tools`, which is reason enough to carry on in text and not reason
   * enough to write down that the model never takes them.
   */
  textForRun: Set<string>;
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
  return randomUUID();
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
        return { kind: 'provider', message: `${err.message}${providerAdvice(err)}`, at };
    }
  }
  return { kind: 'provider', message: err instanceof Error ? err.message : String(err), at };
}

/**
 * Whether a failure is the provider's server saying it cannot answer just now:
 * overloaded (529), unavailable (503), or a gateway that could not reach or
 * wait for what is behind it (502, 504). Not 500: that is what a server
 * answers when it trips over the request itself, a `tools` field it does not
 * take among them, and asking again would only put that answer off.
 */
function isBusy(err: unknown): boolean {
  return err instanceof AIProviderError && err.kind === 'http' && err.status !== undefined && [502, 503, 504, 529].includes(err.status);
}

/**
 * What to do about a provider's HTTP failure, where the failure's own words do
 * not say already. Every such reason used to end "Check your API key and
 * provider settings": after "had an error of its own (529). Try again in a
 * moment" that contradicts the sentence before it, and after a refused output
 * limit it sends the person to a key the provider had just accepted.
 */
function providerAdvice(err: AIProviderError): string {
  if (isOutputLimitRejection(err)) return ' Set Max output tokens (Settings → Agent runs) to what this model allows, then Continue.';
  // A key that was refused, an address nothing answers at, a server that failed: each of those says what to do.
  if (err.status !== undefined && kindForStatus(err.status) !== 'http') return '';
  return ' Check your API key and provider settings.';
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

/**
 * The statuses a run saved by an earlier page can be left in when the page went away mid-run.
 * A run another tab is driving is in one of them too, and is not such a run: its page has not
 * gone away (keepAlive.ts).
 */
export function wasInterrupted(run: AgentRunRecord): boolean {
  return !isRunLive(run.id) && !run.continuedBy && (run.status === 'running' || run.status === 'waiting' || run.status === 'paused') && runInAnotherTab(run.id) === null;
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
    turns: [{ role: 'user', text: buildProjectContext(kind, takePreviewFaults(useWorkspaceStore.getState().projectId)) }, ...openingTurns(), ...(continuing ? [{ role: 'user' as const, text: continuing.note }] : [])],
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
    failingCheck: null,
    finishRefusals: 0,
    personAnsweredFailingCheck: false,
    toldConflicts: new Set(),
    toldUnsaved: false,
    lastToolError: null,
    sameToolErrors: 0,
    truncations: 0,
    systems: {},
    live: null,
    weights: cacheWeights(provider),
    lastInput: 0,
    cacheSeen: false,
    compactedAt: 0,
    textForRun: new Set(),
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

/**
 * The output allowance a request to `model` goes out with, and the budget
 * reserves for its reply: Max output tokens, or the model's own limit where
 * the provider has said that is lower (see outputLimitFrom).
 */
function outputAllowance(provider: ProviderConfig, model: string): number {
  const ai = useAIStore.getState();
  return Math.min(ai.maxOutputTokens, ai.outputLimits[protocolKey(provider, model)] ?? Infinity);
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
  // Reverting a run and then continuing it is asking it to try again: what it does from here
  // is its to undo and revert (the steps already put back stay marked as undone).
  const wasReverted = run.reverted === true;
  patch(ctl, (r) => ({
    ...r,
    maxSteps: r.steps >= r.maxSteps ? r.steps + settings.maxSteps : r.maxSteps,
    // Another allowance from where the run stands, at the setting as it is now. The budget
    // used to grow only once nine tenths of it were spent, but the stop reserves the next
    // request and a whole reply, which is often more than the last tenth: Continue then met
    // the same stop without sending anything, and so did raising the setting.
    tokenBudget: Math.max(r.tokenBudget, runEffective(r.tokens) + settings.runTokenBudget),
    ...(wasReverted ? { reverted: false } : {}),
  }));
  ctl.sameCheckFailures = 0;
  ctl.finishRefusals = 0;
  ctl.sameToolErrors = 0;
  ctl.truncations = 0;
  const wasPaused = run.status === 'paused';
  setStatus(ctl, 'running');
  // A paused request is sent again as it was; a stopped or limited run is told it was resumed,
  // and one whose files were put back in the meantime is told that, or it would carry on as
  // though they were still there.
  if (!ctl.pending && (wasReverted || !wasPaused || ctl.turns.at(-1)?.role === 'assistant')) {
    ctl.turns.push({
      role: 'user',
      text: wasReverted
        ? 'The person reverted this run and then resumed it: every file it created is gone, and every file it changed or deleted is as it was before the run. Read a file again before you change it, do again what the request still needs, and call finish when it is done.'
        : 'The person resumed the run. Continue where you left off: check the app, fix what is broken, and call finish when the request is done.',
    });
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
    // A finish refused over a failed check tells the model to ask the person. They have been
    // asked and have answered: what to do about the error is theirs to say, so the next
    // finish is taken, until something is written and checked again.
    if (ctl.finishRefusals > 0) {
      ctl.finishRefusals = 0;
      ctl.personAnsweredFailingCheck = true;
    }
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

// Undo and revert work from the journal (runRevert.ts); a run still live here forgets what it
// had read of the files put back, so its next write of one is judged against the file as it is.
export { revertChatTurn, runRevertState, stepUndoState, stepUndoUnavailable, turnRevertState, type RevertOutcome } from './runRevert';

/** Forget, in a run still live in this tab, what it had read of these files. */
function forgetRead(runId: string, paths: string[]): void {
  const ctl = controllers.get(runId);
  if (ctl) for (const path of paths) ctl.seen.delete(path);
}

/** Undo one step of a run by its transaction — before or after a reload. */
export function undoAgentStep(runId: string, messageId: string, entryId: string): RevertOutcome {
  const result = undoStepFromJournal(messageId, entryId);
  if (result.ok) forgetRead(runId, result.paths);
  return result;
}

/**
 * Revert everything a run wrote that has not been undone step by step, as
 * one change — before or after a reload. Every step is checked first, so a
 * run is reverted whole or not at all: a file edited after the run (by the
 * person, or another run) refuses it.
 */
export function revertAgentRun(messageId: string): RevertOutcome {
  const runId = useAIStore.getState().messages.find((m) => m.id === messageId)?.run?.id;
  const result = revertRunFromJournal(messageId);
  if (result.ok && runId) forgetRead(runId, result.paths);
  return result;
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
  /** Waits made for a rate limit or a busy server. */
  let attempt = 0;
  /** Requests sent again after a timeout. */
  let timeouts = 0;
  let stripThinking = false;
  let loweredOutput = false;
  for (;;) {
    ctl.abort = new AbortController();
    const sink = stream === 'off' ? undefined : startLive(ctl, protocol);
    const maxOutputTokens = outputAllowance(ctl.provider, model);
    try {
      const turns = stripThinking ? ctl.turns.map((t) => (t.role === 'assistant' ? { ...t, anthropicContent: undefined } : t)) : ctl.turns;
      const reply = await sendAgentRequest(ctl.provider, {
        system,
        turns,
        protocol,
        model,
        signal: ctl.abort.signal,
        timeoutMs: settings.requestTimeoutMs,
        maxOutputTokens,
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
      // The output cap is over what this model allows, and the provider said what it does
      // allow: ask again with that, once, and keep it for this provider and model. Max output
      // tokens is one setting for every model and its default is above many models' limits,
      // so without this the first request of every run on such a model was refused.
      const limit = loweredOutput ? null : outputLimitFrom(err, maxOutputTokens);
      if (limit !== null) {
        loweredOutput = true;
        useAIStore.getState().rememberOutputLimit(key, limit);
        addEntry(ctl, {
          kind: 'text',
          id: newId(),
          text: `${model} allows at most ${limit.toLocaleString()} output tokens in a reply, so Studio asks for that instead of the ${maxOutputTokens.toLocaleString()} set as Max output tokens.`,
          at: Date.now(),
        });
        continue;
      }
      // A rate limit, and a server that is overloaded or cannot reach its upstream: both are
      // the provider's "try again in a moment", so both are waited out and asked again. An
      // overloaded error arriving inside a stream always was (stream.ts makes it a rate
      // limit); the same answer arriving as a status ended the run on its first refusal.
      const busy = isBusy(err);
      if (err instanceof AIProviderError && (err.kind === 'rate-limited' || busy) && attempt < RATE_LIMIT_RETRIES) {
        attempt++;
        const wait = Math.min(err.retryAfterMs ?? 5_000 * attempt, 60_000);
        useAIStore.getState().setCurrentStep(`${busy ? 'The provider is busy' : 'Rate limited'}; retrying in ${Math.ceil(wait / 1000)} s…`);
        await sleep(wait, ctl.abort?.signal);
        if (controllerStopped(ctl)) throw new AIProviderError('cancelled', 'The run was stopped.');
        continue;
      }
      // A timeout's one second chance is counted on its own. It shared `attempt` with the
      // waits above, so a request that had waited out a rate limit had none left.
      if (err instanceof AIProviderError && err.kind === 'timeout' && timeouts < 1) {
        timeouts++;
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
  // The model's own check counts as the run's last one, as the automatic check does.
  if (call.name === 'check_app' && outcome.check) ctl.failingCheck = outcome.check.ok ? null : outcome.check;
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
    // Discarded, or stopped while the tool ran: Stop answered what was left of these calls,
    // so none of them is run after it — not even if the run has been continued since.
    if (!ctl.alive || ctl.pending !== pending) return true;
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
    // Stop came while the check ran. It has already answered this step's calls, and a stopped
    // run stays stopped: carrying on from here answered them a second time, so every later
    // request held two results for one call, and a reply that had also called finish turned
    // the run the person had stopped into a finished one. The check's row keeps its result.
    if (ctl.pending !== pending) return true;
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
    ctl.failingCheck = report.ok ? null : report;
    // A new check of a new write: what the person said of the last one does not cover it.
    ctl.personAnsweredFailingCheck = false;
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

  // Finish in a reply that changed nothing, after a check that failed: the errors are still
  // there. The refusal above is for a reply that writes and finishes together; a model that
  // wrote in one reply, read the failed check, and called finish in the next was believed, and
  // the run ended "Finished" under a check row that said the app was broken. (A reply that
  // wrote with the automatic check turned off is let through: nothing has judged the app since.)
  // Two finishes are taken all the same: one in a run that has changed nothing, which has
  // broken nothing ("summarize this app", of a project that came in broken); and one after
  // the person, asked about the error as the refusal says to ask, has answered.
  let finishedOverErrors: string | null = null;
  const changedSomething = (record(ctl)?.transactions.length ?? 0) > 0;
  if (pending.finishSummary !== undefined && ctl.failingCheck && !pending.wrote && changedSomething && !ctl.personAnsweredFailingCheck) {
    const errors = ctl.failingCheck.errors;
    pending.finishSummary = undefined;
    ctl.finishRefusals++;
    const finish = pending.results.find((r) => r.name === 'finish');
    if (finish) {
      finish.content = `Not accepted: the last check of the app found errors and nothing has changed since:\n${errors.map((e) => `- ${e}`).join('\n')}\nFix them, then call finish again. If one cannot be fixed, ask the person (ask_user) what to do about it.`;
      finish.isError = true;
      updateEntry(ctl, finish.id, { status: 'error', result: finish.content.slice(0, 2_000) });
    }
    if (ctl.finishRefusals >= 2) finishedOverErrors = `${errors.length} error${errors.length === 1 ? '' : 's'}: ${errors[0] ?? 'the check failed'}`;
  } else if (pending.wrote || !ctl.failingCheck) {
    ctl.finishRefusals = 0;
  }

  // A write is saved now, and a finish waits for the save: a file this run wrote that another
  // tab changed too is not written over (lib/projectMerge.ts), storage keeps the other tab's
  // version, and the run used to end saying it had made a change that was in this tab alone.
  // A save that did not go through at all (storage full or blocked, the project deleted in
  // another tab) was not looked at either, and the run ended "Finished" over a project that
  // was in this tab's memory only: the model is told, and a finish over it ends the run below.
  let unsavedAtFinish: string | null = null;
  if (pending.wrote || pending.finishSummary !== undefined) {
    const saved = await saveForRun();
    if (!ctl.alive || ctl.pending !== pending) return true;
    const lastWrite = () => [...pending.results].reverse().find((r) => WRITE_TOOLS.has(r.name) && !r.isError) ?? pending.results.at(-1);
    if (saved.failed) {
      if (!ctl.toldUnsaved) {
        ctl.toldUnsaved = true;
        const note = lastWrite();
        if (note) note.content += `\n\n${unsavedNote(saved.failed.message)}`;
      }
      if (pending.finishSummary !== undefined) {
        unsavedAtFinish = saved.failed.message;
        const finish = pending.results.find((r) => r.name === 'finish');
        if (finish) finish.content = `The run ended without being saved: ${saved.failed.message} The person has been told.`;
      }
    } else if (ctl.toldUnsaved) {
      ctl.toldUnsaved = false;
      const note = lastWrite();
      if (note) note.content += '\n\nThe project is saved now, with everything written so far: your summary need not say otherwise.';
    }
    const conflicts = saved.conflicts;
    const written = pathsWritten(ctl);
    const untold = conflicts.filter((path) => written.has(path) && !ctl.toldConflicts.has(path));
    if (untold.length > 0) {
      for (const path of untold) ctl.toldConflicts.add(path);
      const note = conflictNote(untold);
      const finish = pending.finishSummary !== undefined ? pending.results.find((r) => r.name === 'finish') : undefined;
      if (finish) {
        // Not counted with the refusals over a failed check: the next finish is accepted.
        pending.finishSummary = undefined;
        finish.content = `Not accepted yet: ${note} Call finish again with a summary that says so.`;
        finish.isError = true;
        updateEntry(ctl, finish.id, { status: 'error', result: finish.content });
      } else {
        const write = lastWrite();
        if (write) write.content += `\n\n${note}`;
      }
    }
  }

  ctl.turns.push({ role: 'tool', results: pending.results.map(({ step: _step, ...r }) => r) });
  const summary = pending.finishSummary;
  ctl.pending = null;

  if (finishedOverErrors) {
    end(ctl, 'failed', `The agent said it was finished while the check still finds ${finishedOverErrors}. The run stopped rather than call the app done. Continue to let it try again, or say how to fix it.`);
    return true;
  }
  if (failedRepeatedly) {
    end(ctl, 'failed', `The same check error came back ${REPEAT_LIMIT} times after the agent's fixes: ${failedRepeatedly}. The run stopped rather than keep trying the same thing. Continue to let it try again, or say how to fix it.`);
    return true;
  }
  // Not "Finished": what the run did is in this tab only. The summary is kept with the run, and
  // said in the reason, which is what a stopped run shows.
  if (summary !== undefined && unsavedAtFinish !== null) {
    end(ctl, 'failed', `The agent finished, but the project is not saved: ${unsavedAtFinish} What the run changed is in this tab only. The agent's summary: ${summary}`, summary);
    return true;
  }
  if (summary !== undefined) {
    end(ctl, 'finished', undefined, summary);
    return true;
  }
  return false;
}

/** The files this run's committed changes touched, from the undo journal and the history. */
function pathsWritten(ctl: RunController): Set<string> {
  const ids = new Set(record(ctl)?.transactions ?? []);
  const vfs = useVFSStore.getState();
  const paths = new Set<string>();
  for (const entry of vfs.journal) if (ids.has(entry.id)) for (const change of entry.changes) paths.add(change.path);
  for (const event of vfs.history) if (event.transactionId !== undefined && ids.has(event.transactionId)) paths.add(event.path);
  return paths;
}

/** What the model is told when the project could not be saved at all. */
function unsavedNote(message: string): string {
  return `The project could not be saved: ${message} Everything written so far is in this tab only; the person has been told. Do not write files again to get past this. Carry on with the request, and say in your summary that the work is not saved.`;
}

/** What the model is told of files it wrote that another tab changed too. */
function conflictNote(paths: string[]): string {
  const list = paths.length === 1 ? `${paths[0]} was` : `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]} were`;
  return `${list} also changed in another tab where this project is open, so storage kept the other tab’s version: your change is in this tab only, not saved. The person chooses which to keep. Do not write the file again to get past this; say it in your summary.`;
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
    let protocol: ToolProtocol = ctl.textForRun.has(protocolKey(ctl.provider, model)) ? 'text' : protocolFor(ctl.provider, model);
    let system = (ctl.systems[protocol] ??= buildAgentSystemPrompt(protocol));
    if (contextSize(ctl, system) > CONTEXT_SOFT_LIMIT_TOKENS) {
      compact(ctl, run.steps, true);
      ctl.compactedAt = run.steps;
    } else if (run.steps - ctl.compactedAt >= COMPACT_EVERY) {
      compact(ctl, run.steps, false);
      ctl.compactedAt = run.steps;
    }

    // Reserve before sending: the request as it stands, and a reply as long as a reply may be.
    const estimate = requestEstimate(ctl, contextSize(ctl, system)) + outputAllowance(ctl.provider, model);
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
          // The provider or model does not take `tools`: carry on in text. A definite refusal is
          // remembered for this provider and model. A 500 is a server tripping over the request,
          // which may be `tools` and may be one bad moment: the run moves to text and stays there
          // (asking with `tools` again at every step would meet the same error at every step),
          // and the next run asks natively again. Remembered, one such moment put the model on
          // the text protocol for every run after it.
          const key = protocolKey(ctl.provider, model);
          const definite = isDefiniteToolsRejection(err);
          if (definite) useAIStore.getState().rememberToolProtocol(key, 'text');
          else ctl.textForRun.add(key);
          protocol = 'text';
          system = ctl.systems[protocol] ??= buildAgentSystemPrompt(protocol);
          patch(ctl, (r) => ({ ...r, protocol }));
          addEntry(ctl, {
            kind: 'text',
            id: newId(),
            text: definite
              ? 'This model does not take tool calls natively; continuing with the text protocol.'
              : 'The provider’s server failed on a request with tool calls, in words that read as if it does not take them. This run continues with the text protocol; the next run tries tool calls again.',
            at: Date.now(),
          });
          reply = await request(ctl, system, model, protocol);
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (!ctl.alive) return;
      if (err instanceof AIProviderError && err.kind === 'cancelled') return;
      const failure = describeFailure(err);
      // A provider still busy after the retries is waited for like one still rate-limiting:
      // the run pauses with its request as it was, where it used to end as failed.
      if (failure.kind === 'network' || failure.kind === 'timeout' || failure.kind === 'rate-limited' || isBusy(err)) {
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
      // Its tokens were counted above, as any reply's. A reasoning model can
      // spend most of the allowance thinking before it writes a call, so one
      // cut reply is not a failure: the step is asked for again, once, with
      // a note to think less and do less per reply.
      // The limit the reply met: the setting, or the model's own where that is lower, and then
      // raising the setting changes nothing.
      const allowance = outputAllowance(ctl.provider, model);
      if (ctl.truncations > TRUNCATION_RETRIES) {
        const remedy = allowance < ai.maxOutputTokens
          ?'That is the most this model allows in one reply: ask for a smaller change, or choose a model that allows longer replies in AI setup.'
          : 'Raise Max output tokens in Settings → Agent runs, or ask for a smaller change.';
        end(ctl, 'failed', `The model's reply was cut off at the output limit (${allowance.toLocaleString()} tokens) again after it was asked to keep its reasoning short and split the work. ${remedy}`);
        return;
      }
      ctl.turns.push({
        role: 'user',
        text: `Your reply was cut off at the output limit (${allowance.toLocaleString()} tokens) before it was finished, so none of its tool calls were run. Thinking counts toward that limit. Try this step again: keep your reasoning short, and split the work — one small call at a time; change existing files with edit_file, and write a large new file in parts (write the first part, then add to it with edit_file).`,
      });
      addEntry(ctl, { kind: 'text', id: newId(), text: 'A reply was cut off at the output limit; nothing from it was applied. The step is being tried again, with the agent asked to keep its reasoning short and split the work.', at: Date.now() });
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
            ? 'Your <tool_call> could not be read, so nothing was run. Write each call as a block with a closing tag, e.g.\n<tool_call name="read_file">\n<arg name="path">index.html</arg>\n</tool_call>'
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
