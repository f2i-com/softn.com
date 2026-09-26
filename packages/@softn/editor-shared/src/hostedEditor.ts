/** Private editor session with the same-origin FormLogic parent. No account credentials cross it. */
export const isHostedEditor = () => typeof window !== 'undefined' && window.parent !== window && new URLSearchParams(window.location.search).get('formlogicEditor') === '1';
let currentPort: MessagePort | null = null;
const hostRequests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const pendingSaves = new Map<string, { resolve(value: HostedSaveResult): void; timer: ReturnType<typeof setTimeout> }>();
/** How long FormLogic gets to confirm that it took the draft (audit SN-04). */
const SAVE_ACK_TIMEOUT_MS = 60000;

/**
 * What FormLogic did with a save request. `state: 'draft'` means the parent
 * pulled the current project into the owner's DRAFT; publishing still happens
 * in FormLogic through its version-checked hosting APIs, so this is never a
 * claim that the app is live.
 */
export interface HostedSaveResult { ok: boolean; state: 'draft' | 'error'; error?: string }

/**
 * The truthful outcome of asking the host to save (audit SN-04):
 *  - not hosted at all → the caller keeps its own local save path;
 *  - hosted but the parent channel is not open (before the handshake, after
 *    teardown or a parent reload) → NOT handled; the caller must keep the
 *    unsaved edits and tell the user, never fall back to an unrelated export;
 *  - handled → a request id plus a promise that settles only when FormLogic
 *    acknowledges (or the acknowledgement times out).
 */
export type HostedSaveOutcome =
  | { handled: false; reason: 'not-hosted' | 'disconnected' }
  | { handled: true; id: string; completion: Promise<HostedSaveResult> };

/**
 * The AI tool-call capability of the bridge (`aiTools`). Version 1: an
 * `ai-request` may carry `tools` and structured messages, and an
 * `ai-response` may answer with text and tool calls. The editor announces it
 * in `formlogic-editor-ready`; a host that speaks it announces it back in
 * `formlogic-editor-connect`. Until the host has announced it, the editor
 * sends only what every host takes: `{role, content: string}` messages with
 * roles system/user/assistant, and reads a string back. The bridge protocol
 * number itself stays 1 — everything added here is optional on both sides.
 */
export const HOSTED_AI_TOOLS_VERSION = 1;

/** A tool the model may call: a name, what it does, and a JSON schema for its arguments. */
export interface HostedAITool { name: string; description: string; inputSchema: Record<string, unknown> }
/** A call the model made. `arguments` is the parsed object; a host that has only the raw JSON string may send that. */
export interface HostedAIToolCall { id: string; name: string; arguments: Record<string, unknown> | string }
export type HostedAIMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: HostedAIToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };
export interface HostedAIRequest { messages: HostedAIMessage[]; tools?: HostedAITool[]; maxOutputTokens?: number }
export interface HostedAIReply {
  text: string;
  toolCalls: HostedAIToolCall[];
  /** The provider's own stop reason, when the host passed it on. */
  stopReason: string | null;
  /** Counts the host reported, or null when it reported none. */
  usage: { inputTokens: number; outputTokens: number } | null;
  /**
   * Whether the host answered in the structured form. A plain string answer
   * to a request that carried `tools` means the host (or its provider)
   * ignored them: the caller should fall back to tools written as text.
   */
  structured: boolean;
}

/**
 * A failed AI request, with the host's reason code when it gave one.
 * `tools-unsupported`: the host (or its provider) cannot take `tools`; the
 * editor carries on with tool calls written as text.
 */
export class HostedAIError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.name = 'HostedAIError'; this.code = code; }
}

let hostAITools = 0;
/** The `aiTools` version the connected host announced; 0 when it announced none (or nothing is connected). */
export function hostedAIToolsVersion(): number { return currentPort ? hostAITools : 0; }

/**
 * The agent-run capability of the bridge (`agentRuns`). Version 1:
 *  - the host's `open` may carry `brief: { prompt, kind }`, and an editor that
 *    runs an AI agent starts a run with that request once the project is open;
 *  - the editor tells the host how its agent is doing with `agent-status`
 *    messages, so the host can say what is happening and hold "review" and
 *    "close" while a run is writing.
 * The editor announces it in `formlogic-editor-ready`. It sends `agent-status`
 * only to a host that announced it back; a host that did not simply never
 * sends a brief. Like `aiTools`, it is optional on both sides.
 */
export const HOSTED_AGENT_RUNS_VERSION = 1;

/** A request the host asks the editor's agent to carry out as soon as the project is open. */
export interface HostedBrief { prompt: string; kind: 'build' | 'edit' }
/** Longest brief the editor takes from a host. */
export const HOSTED_BRIEF_MAX_CHARS = 8000;

/**
 * Where the editor's agent is. `running`: a request or a tool is in progress;
 * `waiting`: it asked the person something; `paused`: a network failure it
 * will resume from; `stopped`, `finished`, `failed`: the run ended; `idle`:
 * no run yet.
 */
export type HostedAgentState = 'idle' | 'running' | 'waiting' | 'paused' | 'stopped' | 'finished' | 'failed';
export interface HostedAgentStatus {
  state: HostedAgentState;
  /** What it is doing now, as the editor shows it ("Checking the app…"). */
  step?: string;
  /** The model's summary, once a run finished. */
  summary?: string;
  /** Why a run paused, stopped or failed. */
  reason?: string;
}

let hostAgentRuns = 0;
/** The `agentRuns` version the connected host announced; 0 when it announced none. */
export function hostedAgentRunsVersion(): number { return currentPort ? hostAgentRuns : 0; }

/** A brief as the host sent it, or null when it sent none or one that is not a brief. */
export function readHostedBrief(value: unknown): HostedBrief | null {
  if (!isObject(value) || typeof value.prompt !== 'string') return null;
  const prompt = value.prompt.trim().slice(0, HOSTED_BRIEF_MAX_CHARS);
  if (!prompt) return null;
  return { prompt, kind: value.kind === 'edit' ? 'edit' : 'build' };
}

/** Longest save label the editor takes from a host. */
export const HOSTED_SAVE_LABEL_MAX_CHARS = 32;
let hostSaveLabel: string | null = null;
const saveLabelListeners = new Set<() => void>();

/**
 * The host's own name for returning the editor's work to it ("Save changes"), sent
 * with `open` as `saveLabel`: the editor's button that asks the host to save says
 * the same as the host's button beside it. Null when the host sent none; each
 * editor then keeps its own label. Optional, with no capability to announce.
 */
export function hostedSaveLabel(): string | null { return currentPort ? hostSaveLabel : null; }
/** Called when the host's save label changes (on `open`, and when the host goes). */
export function subscribeHostedSaveLabel(listener: () => void): () => void {
  saveLabelListeners.add(listener);
  return () => { saveLabelListeners.delete(listener); };
}
/** A save label as the host sent it: one line of plain text, or null. */
export function readHostedSaveLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.replace(/\s+/g, ' ').trim();
  return label && label.length <= HOSTED_SAVE_LABEL_MAX_CHARS ? label : null;
}
function setHostSaveLabel(label: string | null): void {
  if (label === hostSaveLabel) return;
  hostSaveLabel = label;
  for (const listener of saveLabelListeners) listener();
}

let lastAgentStatus = '';
/**
 * Tell the host where the agent is. Sent only to a host that announced
 * `agentRuns`, and only when something changed.
 */
export function reportHostedAgentStatus(status: HostedAgentStatus): void {
  if (!currentPort || hostAgentRuns < 1) return;
  const message = {
    kind: 'agent-status',
    state: status.state,
    ...(status.step ? { step: status.step.slice(0, 200) } : {}),
    ...(status.summary ? { summary: status.summary.slice(0, 2000) } : {}),
    ...(status.reason ? { reason: status.reason.slice(0, 1000) } : {}),
  };
  const key = JSON.stringify(message);
  if (key === lastAgentStatus) return;
  lastAgentStatus = key;
  currentPort.postMessage(message);
}

/**
 * How long the editor waits for the host to answer an AI request. One round of an agent that
 * writes whole files can run minutes on a local model; FormLogic gives an editor round 600 s
 * upstream, and this outlasts that so the host's own answer (or its timeout) arrives first.
 */
export const HOSTED_AI_TIMEOUT_MS = 630_000;

function sendAIRequest(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (!currentPort) return Promise.reject(new Error('FormLogic is not connected.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); hostRequests.delete(id); };
    const abort = () => { currentPort?.postMessage({ kind: 'ai-cancel', id }); finish(); reject(new DOMException('AI request cancelled.', 'AbortError')); };
    const timer = setTimeout(() => { currentPort?.postMessage({ kind: 'ai-cancel', id }); finish(); reject(new Error('AI request timed out.')); }, HOSTED_AI_TIMEOUT_MS);
    hostRequests.set(id, { resolve: value => { finish(); resolve(value); }, reject: error => { finish(); reject(error); } });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    currentPort!.postMessage({ kind: 'ai-request', id, ...payload });
  });
}

/** Ask the host for a plain text reply: the form every host takes. */
export function requestHostedAI(messages: { role: string; content: string }[], signal?: AbortSignal): Promise<string> {
  return sendAIRequest({ messages }, signal).then(value => {
    if (typeof value !== 'string') throw new Error('Invalid AI response.');
    return value;
  });
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/** A host's `ai-response` value in the reply shape; throws on one that is neither a string nor a reply object. */
export function readHostedAIReply(value: unknown): HostedAIReply {
  if (typeof value === 'string') return { text: value, toolCalls: [], stopReason: null, usage: null, structured: false };
  if (!isObject(value)) throw new Error('Invalid AI response.');
  const text = typeof value.text === 'string' ? value.text : '';
  const toolCalls: HostedAIToolCall[] = [];
  if (Array.isArray(value.toolCalls)) {
    value.toolCalls.forEach((raw, index) => {
      if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name) return;
      const args = isObject(raw.arguments) || typeof raw.arguments === 'string' ? raw.arguments : {};
      toolCalls.push({ id: typeof raw.id === 'string' && raw.id ? raw.id : `call_${index}`, name: raw.name, arguments: args });
    });
  }
  const usage = isObject(value.usage) ? { inputTokens: count(value.usage.inputTokens), outputTokens: count(value.usage.outputTokens) } : null;
  return { text, toolCalls, stopReason: typeof value.stopReason === 'string' ? value.stopReason : null, usage, structured: true };
}

/**
 * Ask the host for a reply that may call tools. Structured messages and
 * `tools` are only sent to a host that announced `aiTools`; asking without
 * that is refused here rather than sent to a host that would reject it.
 */
export function requestHostedAIReply(request: HostedAIRequest, signal?: AbortSignal): Promise<HostedAIReply> {
  if (currentPort && hostAITools < 1) return Promise.reject(new Error('FormLogic did not announce AI tool calls.'));
  return sendAIRequest({
    aiTools: HOSTED_AI_TOOLS_VERSION,
    messages: request.messages,
    ...(request.tools?.length ? { tools: request.tools } : {}),
    ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
  }, signal).then(readHostedAIReply);
}

export function requestHostedSave(): HostedSaveOutcome {
  if (!isHostedEditor()) return { handled: false, reason: 'not-hosted' };
  const port = currentPort;
  if (!port) return { handled: false, reason: 'disconnected' };
  const id = crypto.randomUUID();
  const completion = new Promise<HostedSaveResult>(resolve => {
    const timer = setTimeout(() => {
      pendingSaves.delete(id);
      resolve({ ok: false, state: 'error', error: 'FormLogic did not confirm the save. Your changes are still in the editor; try again.' });
    }, SAVE_ACK_TIMEOUT_MS);
    pendingSaves.set(id, { resolve, timer });
  });
  port.postMessage({ kind: 'save-requested', id });
  return { handled: true, id, completion };
}

/** Number of saves FormLogic has not acknowledged yet (for teardown warnings). */
export function pendingHostedSaves(): number { return pendingSaves.size; }

function settlePendingSaves(result: HostedSaveResult): void {
  for (const waiting of pendingSaves.values()) { clearTimeout(waiting.timer); waiting.resolve(result); }
  pendingSaves.clear();
}

/** What the host asked for with the project, beyond the project itself. */
export interface HostedOpenOptions { brief: HostedBrief | null }

/**
 * `agentRuns`: whether this editor runs an AI agent that can take a brief and
 * report its status (Studio does; the Builder does not, so it does not announce it).
 */
export function connectHostedEditor(handlers: { open(bytes: Uint8Array, name: string, options: HostedOpenOptions): Promise<void>; export(): Promise<Uint8Array> | Uint8Array }, capabilities: { agentRuns?: boolean } = {}): () => void {
  if (!isHostedEditor()) return () => {};
  let port: MessagePort | null = null;
  let disposed = false;
  let loaded = false;
  let busy = false;
  const ready = () => { if (!port) window.parent.postMessage({ kind: 'formlogic-editor-ready', protocol: 1, aiTools: HOSTED_AI_TOOLS_VERSION, ...(capabilities.agentRuns ? { agentRuns: HOSTED_AGENT_RUNS_VERSION } : {}) }, location.origin); };
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.kind !== 'formlogic-editor-connect' || event.data?.protocol !== 1 || port || !event.ports[0]) return;
    port = event.ports[0]; currentPort = port;
    // Optional: a host that takes tool calls says which version; one that does not says nothing.
    hostAITools = Number.isInteger(event.data.aiTools) && event.data.aiTools > 0 ? Math.min(event.data.aiTools, HOSTED_AI_TOOLS_VERSION) : 0;
    hostAgentRuns = capabilities.agentRuns && Number.isInteger(event.data.agentRuns) && event.data.agentRuns > 0 ? Math.min(event.data.agentRuns, HOSTED_AGENT_RUNS_VERSION) : 0;
    lastAgentStatus = '';
    port.onmessage = async ({ data }) => {
      if (disposed || typeof data?.id !== 'string') return;
      if (data.kind === 'ai-response') {
        const waiting = hostRequests.get(data.id);
        if (data.ok) waiting?.resolve(data.value); else waiting?.reject(new HostedAIError(typeof data.error === 'string' && data.error ? data.error : 'FormLogic AI request failed.', typeof data.code === 'string' ? data.code : undefined));
        return;
      }
      if (data.kind === 'save-result') {
        const waiting = pendingSaves.get(data.id);
        if (!waiting) return;
        clearTimeout(waiting.timer); pendingSaves.delete(data.id);
        waiting.resolve(data.ok === true
          ? { ok: true, state: 'draft' }
          : { ok: false, state: 'error', error: typeof data.error === 'string' && data.error ? data.error : 'FormLogic could not take the draft.' });
        return;
      }
      const reply = (value: unknown) => { if (!disposed) port?.postMessage({ id: data.id, ok: true, value }); };
      if (busy) { port?.postMessage({ id: data.id, ok: false, error: 'The editor is busy. Try again shortly.' }); return; }
      busy = true;
      try {
        if (data.method === 'open' && !loaded) {
          // Checked by tag, not instanceof: a cloned array can come from another realm.
          if (Object.prototype.toString.call(data.bytes) !== '[object Uint8Array]' || data.bytes.byteLength > 24 * 1024 * 1024) throw new Error('Invalid app archive.');
          if (data.theme === 'light' || data.theme === 'dark') {
            document.documentElement.setAttribute('data-theme', data.theme);
            document.documentElement.dispatchEvent(new CustomEvent('softn:theme', { detail: data.theme }));
          }
          setHostSaveLabel(readHostedSaveLabel(data.saveLabel));
          // A brief is only read from a host that said it speaks agentRuns.
          await handlers.open(data.bytes, typeof data.name === 'string' ? data.name.slice(0, 150) : 'App', { brief: hostAgentRuns > 0 ? readHostedBrief(data.brief) : null });
          if (!disposed) { loaded = true; reply({ opened: true }); }
        } else if (data.method === 'export' && loaded) {
          const bytes = await handlers.export();
          if (bytes.byteLength > 24 * 1024 * 1024) throw new Error('This app exceeds the hosted editor archive limit.');
          reply(bytes);
        } else throw new Error('The editor has not opened this app yet.');
      } catch (error) {
        if (!disposed) port?.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : 'Editor operation failed.' });
      } finally { busy = false; }
    };
    port.start();
  };
  window.addEventListener('message', receive);
  const timer = window.setInterval(ready, 500);
  ready();
  return () => {
    disposed = true; window.clearInterval(timer); window.removeEventListener('message', receive);
    if (currentPort === port) { currentPort = null; hostAITools = 0; hostAgentRuns = 0; lastAgentStatus = ''; setHostSaveLabel(null); }
    for (const request of hostRequests.values()) request.reject(new Error('Editor closed.')); hostRequests.clear();
    // A save the parent never confirmed is NOT saved: say so instead of leaving a promise hanging.
    settlePendingSaves({ ok: false, state: 'error', error: 'The editor session ended before FormLogic confirmed the save.' });
    port?.close();
  };
}
