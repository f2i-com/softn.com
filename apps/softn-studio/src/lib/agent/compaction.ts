/**
 * Keeping a run's conversation short: what the model no longer needs is
 * replaced by a line that says what it was. The loop (runAgent.ts) decides
 * when — every few steps, and at once when the conversation grows too large —
 * and this decides what.
 */

import { WRITE_TOOLS } from './tools';
import type { AgentToolCall, AgentTurn } from './types';

/** How many steps a long read stays in the conversation, at the least, before a compaction may shorten it. */
const KEEP_READS_FOR = 6;
/** A reply's text longer than this is shortened once it is old. */
const LONG_TEXT_CHARS = 1_500;

const COMPACTABLE = new Set(['read_file', 'search_files', 'list_files', 'inspect_preview', 'run_app_function', 'lookup_components', 'read_docs']);

/** What compaction reads and rewrites of a run: its turns, and the step and tool of each tool result by id. */
export interface Conversation {
  turns: AgentTurn[];
  resultSteps: Map<string, { step: number; name: string; check: boolean }>;
}

/** The file a call reads or changes. */
function callPaths(call: AgentToolCall): string[] {
  const paths = [call.input.path, call.input.from, call.input.to].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return paths.map((p) => p.trim().replace(/^\.\//, ''));
}

const lineTotal = (text: unknown) => (typeof text === 'string' ? text.split('\n').length : 0);

/**
 * Shorten what the model no longer needs, all at once (see runAgent.ts's COMPACT_EVERY):
 * - a long read, search, lookup or render older than `keep` steps, and a read
 *   of a file that has been read again or changed since;
 * - every check report but the latest;
 * - a write or edit of a file that a later write or edit replaced — the call
 *   keeps its path and a one-line record, not the old content;
 * - an old reply's long text.
 * The latest check, the latest version of each file the model wrote, the
 * newest turns and the person's own messages are left as they are.
 */
export function compact(ctl: Conversation, step: number, aggressive: boolean): void {
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
