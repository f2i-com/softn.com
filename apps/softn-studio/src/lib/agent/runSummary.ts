import type { UndoEntry } from '../undoJournal';
import type { LineDiff } from './diff';
import type { AgentRunRecord, RunEntry } from './types';

type ToolEntry = Extract<RunEntry, { kind: 'tool' }>;

/** A real label edit is often sent as an entire line of React or Vue source. Find the
 * quoted value or HTML text node that contains the whole change, keeping complete words. */
function labelReplacement(diff: LineDiff): string | undefined {
  if (diff.added !== 1 || diff.removed !== 1) return;
  const before = diff.lines.find(([kind]) => kind === '-')?.[1];
  const after = diff.lines.find(([kind]) => kind === '+')?.[1];
  if (!before || !after) return;
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (suffix < Math.min(before.length, after.length) - start && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const tokens = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|>[^<>]*</g;
  for (const match of before.matchAll(tokens)) {
    const left = match.index! + 1;
    const right = left + match[0].length - 2;
    if (left > start || right < before.length - suffix) continue;
    const previous = before.slice(left, right);
    const next = after.slice(left, right + after.length - before.length);
    if (previous.trim() && next.trim() && previous.length <= 80 && next.length <= 80) {
      return `Replaced “${previous}” with “${next}” in ${diff.path}.`;
    }
  }
}

/** Describe the files the tools committed. A second edit can restore a file to its original contents. */
export function changedFileSummary(run: AgentRunRecord, journal: UndoEntry[]): string | undefined {
  if (!run.transactions.length) return undefined;
  const receipts = new Map(journal.map((entry) => [entry.id, entry]));
  const files = new Map<string, { before?: string | null; after?: string | null; step: ToolEntry; single: boolean }>();
  for (const step of run.entries) {
    if (step.kind !== 'tool' || step.status !== 'ok' || !step.transactionId || step.undone) continue;
    const receipt = receipts.get(step.transactionId);
    if (!receipt?.changes.length) {
      // Large or expired undo records can still have their file paths in the timeline.
      const paths = step.diff?.map((diff) => diff.path) ?? [step.subject];
      for (const path of paths) files.set(path, { step, single: false });
      continue;
    }
    for (const change of receipt.changes) {
      const previous = files.get(change.path);
      files.set(change.path, {
        before: previous ? previous.before : change.before.kind === 'absent' ? null : change.before.fingerprint.hash,
        after: change.after?.hash ?? null,
        step,
        single: !previous,
      });
    }
  }
  const lines: string[] = [];
  for (const [path, file] of files) {
    if (file.before !== undefined && file.before === file.after) continue;
    if (file.before === null) lines.push(`Created ${path}.`);
    else if (file.after === null) lines.push(`Removed ${path}.`);
    else {
      const diff = file.single && file.step.diff?.find((item) => item.path === path);
      const detail = diff && (labelReplacement(diff) || file.step.changeSummary);
      lines.push(detail || `Updated ${path}.`);
    }
  }
  return lines.join('\n') || 'The edits left the project files unchanged.';
}
