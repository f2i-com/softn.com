/**
 * Undo and revert for what the agent wrote: one step of a run, a whole run,
 * or a single-shot chat turn. Each works from the undo journal saved with the
 * project (lib/undoJournal.ts), so it holds after a reload, and each follows
 * the journal's rule: a file edited after the change refuses it.
 *
 * The loop (runAgent.ts) adds one thing to the two that act on a run: a run
 * still live in this tab forgets what it had read of the files put back, so
 * its next write of one is judged against the file as it is now.
 */

import { useAIStore } from '../../stores/aiStore';
import { useVFSStore } from '../../stores/vfsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { ChatMessage } from '../../types/studio';
import { undoState, undoUnavailableReason, type UndoEntry, type UndoState } from '../undoJournal';
import type { AgentRunRecord, RunEntry } from './types';

export type RevertOutcome = { ok: true; paths: string[] } | { ok: false; reason: string };

/**
 * The steps of a run still to be put back by Revert run, newest first: every
 * transaction it committed but whose step has not been undone on its own.
 */
function pendingTransactions(run: AgentRunRecord): string[] {
  const undone = new Set(run.entries.flatMap((e) => (e.kind === 'tool' && e.undone && e.transactionId ? [e.transactionId] : [])));
  return run.transactions.filter((t) => !undone.has(t)).reverse();
}

/**
 * Why a step's Undo is not offered, or null when it is. Undo works from the
 * journal saved with the project (lib/undoJournal.ts), so it survives a
 * reload; a step recorded before there was a journal, or whose data was
 * trimmed or was a binary file's, cannot be undone, and says so.
 */
export function stepUndoUnavailable(entry: RunEntry, journal: UndoEntry[] = useVFSStore.getState().journal): string | null {
  if (entry.kind !== 'tool' || !entry.transactionId || entry.undone) return null;
  return undoUnavailableReason(journal, entry.transactionId);
}

/** The file as the VFS holds it now, for the undo checks. */
function readNow(path: string): string | Uint8Array | undefined {
  return useVFSStore.getState().files.get(path)?.content;
}

/**
 * What a step's Undo would meet now, from the journal and the files: a step
 * whose files already are what it found — undone with Ctrl+Z or the History
 * panel — is `undone`, so the timeline shows it as undone instead of a
 * button that would only say so when pressed. Derived, not recorded: a redo
 * brings the button back.
 */
export function stepUndoState(
  entry: RunEntry,
  journal: UndoEntry[] = useVFSStore.getState().journal,
  read: (path: string) => string | Uint8Array | undefined = readNow,
): UndoState | null {
  if (entry.kind !== 'tool' || !entry.transactionId) return null;
  if (entry.undone) return { kind: 'undone' };
  return undoState(journal, [entry.transactionId], read);
}

/**
 * Whether Revert run has anything to do, and if it cannot, why. With `read`,
 * a run whose every pending step is already undone (by Ctrl+Z, say) has
 * nothing to do either.
 */
export function runRevertState(
  run: AgentRunRecord,
  journal: UndoEntry[] = useVFSStore.getState().journal,
  read?: (path: string) => string | Uint8Array | undefined,
): { available: boolean; reason: string | null } {
  if (run.reverted) return { available: false, reason: null };
  const pending = pendingTransactions(run);
  if (pending.length === 0) return { available: false, reason: null };
  for (const id of pending) {
    const reason = undoUnavailableReason(journal, id);
    if (reason) return { available: false, reason: `Revert run isn't available: one of its steps ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` };
  }
  if (read && undoState(journal, pending, read).kind === 'undone') return { available: false, reason: null };
  return { available: true, reason: null };
}

/**
 * "Revert this turn" on a chat message that committed files as one
 * transaction (the single-shot turns before agent runs). It works from the
 * journal, as Undo and Revert run do, so it holds after a reload, and it
 * follows their rule: a file edited after the turn refuses the revert.
 */
export function turnRevertState(message: ChatMessage, journal: UndoEntry[] = useVFSStore.getState().journal, read = readNow): UndoState | null {
  if (message.role !== 'assistant' || !message.transactionId || message.run) return null;
  return undoState(journal, [message.transactionId], read);
}

export function revertChatTurn(messageId: string): RevertOutcome {
  const message = useAIStore.getState().messages.find((m) => m.id === messageId);
  if (!message?.transactionId || message.run) return { ok: false, reason: 'This turn changed no files.' };
  const result = useVFSStore.getState().revertJournaled([message.transactionId], 'this turn');
  if (!result.ok) return { ok: false, reason: /was edited after/.test(result.reason) ? `${result.reason} Undo that edit first, or revert by hand.` : result.reason };
  useWorkspaceStore.getState().setDirty(true);
  return result;
}

/** Undo one step of a run by its transaction, and mark the step undone on its record. */
export function undoStepFromJournal(messageId: string, entryId: string): RevertOutcome {
  const message = useAIStore.getState().messages.find((m) => m.id === messageId);
  const entry = message?.run?.entries.find((e) => e.id === entryId);
  if (!message?.run || !entry || entry.kind !== 'tool' || !entry.transactionId) return { ok: false, reason: 'That step changed no files.' };
  if (entry.undone) return { ok: false, reason: 'That step is undone already.' };
  const result = useVFSStore.getState().revertJournaled([entry.transactionId], 'this step');
  if (!result.ok) return { ok: false, reason: /was edited after/.test(result.reason) ? `${result.reason} Undo that edit first, or revert by hand.` : result.reason };
  useAIStore.getState().replaceMessage(messageId, (m) =>
    m.run ? { ...m, run: { ...m.run, entries: m.run.entries.map((e) => (e.id === entryId && e.kind === 'tool' ? { ...e, undone: true } : e)) } } : m,
  );
  useWorkspaceStore.getState().setDirty(true);
  return result;
}

/**
 * Revert everything a run wrote that has not been undone step by step, as
 * one change. Every step is checked first, so a run is reverted whole or not
 * at all: a file edited after the run (by the person, or another run)
 * refuses it.
 */
export function revertRunFromJournal(messageId: string): RevertOutcome {
  const message = useAIStore.getState().messages.find((m) => m.id === messageId);
  const run = message?.run;
  if (!run) return { ok: false, reason: 'There is no run here.' };
  if (run.reverted) return { ok: false, reason: 'This run was reverted already.' };
  const pending = pendingTransactions(run);
  if (pending.length === 0) return { ok: false, reason: 'Nothing from this run is left to revert.' };
  const state = runRevertState(run);
  if (!state.available) return { ok: false, reason: state.reason ?? 'Nothing from this run is left to revert.' };
  const result = useVFSStore.getState().revertJournaled(pending, 'this run');
  if (!result.ok) return { ok: false, reason: /was edited after/.test(result.reason) ? `${result.reason} Undo that edit first, or revert steps one by one.` : result.reason };
  useAIStore.getState().replaceMessage(messageId, (m) => (m.run ? { ...m, run: { ...m.run, reverted: true, entries: m.run.entries.map((e) => (e.kind === 'tool' && e.transactionId ? { ...e, undone: true } : e)) } } : m));
  useWorkspaceStore.getState().setDirty(true);
  return result;
}
