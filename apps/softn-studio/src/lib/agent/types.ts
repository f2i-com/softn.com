/**
 * The agent's own vocabulary: a provider-neutral conversation, the calls the
 * model makes, and the record of a run the chat shows as a timeline.
 *
 * The conversation is kept in one shape whatever the provider, and turned
 * into Anthropic content blocks, OpenAI-compatible tool messages or the text
 * protocol only when a request is sent (see protocol.ts). That is what lets a
 * run change protocol half-way — a provider that rejects `tools` on the third
 * request continues in text with everything it has done so far.
 */

import type { LineDiff } from './diff';

/** One call the model asked for. `id` is the provider's own, or one Studio made for the text protocol. */
export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the call could not even be read (malformed JSON arguments); answered with this as an error. */
  parseError?: string;
}

/** What a tool call returned to the model. */
export interface AgentToolResult {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

export type AgentTurn =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      text: string;
      calls: AgentToolCall[];
      /**
       * An Anthropic reply's content blocks exactly as they came, echoed back
       * unchanged on the next request (a reply may carry blocks, such as
       * thinking, that must be returned as they were). Only used while the
       * run stays on the Anthropic protocol.
       */
      anthropicContent?: unknown[];
    }
  | { role: 'tool'; results: AgentToolResult[] };

/**
 * How tool calls travel for one provider and model: natively in Anthropic's
 * or the OpenAI-compatible API, natively over the hosted editor's bridge
 * (`hosted`, when the host announced `aiTools`), or written as text.
 */
export type ToolProtocol = 'anthropic' | 'openai' | 'hosted' | 'text';

/**
 * A reply still arriving, as the timeline shows it: the text so far, the
 * calls begun so far (name known, arguments possibly incomplete), and
 * whether the model is reasoning before it writes. Replaced by the real
 * entries when the reply is whole; never kept once the run stops running.
 */
export interface LiveReply {
  text: string;
  thinking: boolean;
  /** About how much reasoning has streamed so far, for a model that reasons before it writes. */
  thinkingTokens?: number;
  calls: Array<{ id: string; name: string; subject: string }>;
}

/** A line of the plan the model keeps with update_plan. */
export interface PlanItem {
  text: string;
  status: 'pending' | 'active' | 'done';
}

/** What a check found, in the form the timeline and the model both read. */
export interface CheckReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** The page that was rendered, if one was. */
  page?: string;
  /** Visible text of the rendered page, for the timeline; trimmed. */
  rendered?: string;
  /** Whether the headless render ran (it needs a document). */
  renderedHeadless: boolean;
}

/** A row in the run's timeline. */
export type RunEntry =
  | { kind: 'text'; id: string; text: string; at: number }
  | {
      kind: 'tool';
      id: string;
      name: string;
      /** The path or subject, for the compact row. */
      subject: string;
      status: 'running' | 'ok' | 'error';
      /** The text the model was given back, trimmed for display. */
      result: string;
      at: number;
      /** A write: the transaction to undo this step by, and what it changed. */
      transactionId?: string;
      undone?: boolean;
      diff?: LineDiff[];
      check?: CheckReport;
      /** Whether this row is the automatic check Studio ran after a write. */
      auto?: boolean;
    };

export type RunStatus =
  /** A request or a tool is in progress. */
  | 'running'
  /** ask_user, or a confirmation, is waiting on the person. */
  | 'waiting'
  /** A network failure or rate limit that outlasted the retries: Resume re-sends. */
  | 'paused'
  /** The person pressed Stop. */
  | 'stopped'
  /** The model called finish. */
  | 'finished'
  /** A limit or a repeated failure ended the run. */
  | 'failed';

export interface PendingQuestion {
  /** The tool call the answer goes back to. */
  callId: string;
  question: string;
  /** Set for a confirmation Studio asks on the model's behalf, such as a delete. */
  confirm?: { action: string; paths: string[] };
}

/**
 * What a run has cost. `input` is every prompt token sent, `cached` and
 * `cacheWrite` the parts of it read from and written to the provider's
 * prompt cache, and `effective` the total the budgets count: output and
 * uncached input at face value, cache reads and writes weighted by what they
 * cost next to ordinary input (budget.ts). A record saved before caching was
 * counted has neither, and its effective total is input + output.
 */
export interface RunTokens {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
  effective?: number;
}

/** The whole of a run as the chat shows it; plain data, kept on the chat message. */
export interface AgentRunRecord {
  id: string;
  status: RunStatus;
  /** Why the run is in its current state, for stopped/failed/paused. */
  reason?: string;
  plan: PlanItem[];
  entries: RunEntry[];
  steps: number;
  maxSteps: number;
  tokens: RunTokens;
  /** Counted in effective tokens (see RunTokens). */
  tokenBudget: number;
  protocol: ToolProtocol;
  /** The reply being streamed right now, if one is. */
  live?: LiveReply;
  /** The model's finish summary. */
  summary?: string;
  question?: PendingQuestion;
  /**
   * What a later session needs to pick the run up if the page reloads under
   * it (its conversation lives only in memory): the request that started it
   * and whether it built a new app. The plan, the steps and the counters are
   * above.
   */
  request?: string;
  kind?: 'build' | 'edit';
  /** The run this one continues, after that one was cut short by a reload. */
  continues?: string;
  /** The run that continued this one. */
  continuedBy?: string;
  /** Every transaction the run committed, oldest first: what Revert run reverts. */
  transactions: string[];
  reverted?: boolean;
  startedAt: number;
  endedAt?: number;
}
