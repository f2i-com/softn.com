/**
 * Editing a file by hand: the rules, apart from the editor that shows them.
 *
 * Studio's code view was for reading: every change went through the chat. A
 * person who could see the one word to change had to ask for it and wait for
 * a run. They can now change a text file themselves. A save is one write by
 * the person, `updateFile(path, text, 'user')`: one unit in the History panel,
 * which Undo last, Revert and Redo treat as any other; the validator, the
 * preview and the autosave follow the file store and so follow it too.
 *
 * What a save must never do is put the draft over a write it was not made
 * from. The agent may write the file while the draft is open, and so may an
 * undo, a revert or a redo in the History panel; so the draft remembers the
 * file it began from, and a save is refused, with nothing written, when the
 * file is no longer that one. (A write made in another tab reaches this tab's
 * files when this tab next saves: the save brings in what the other tab
 * changed and this one did not, lib/projectMerge.ts, with a new version, so
 * a draft made from the older file is refused the same way.) While a run is working nothing is saved at all: the agent would be
 * building on a file changing under it. (The agent's side has the same rule
 * already: a file the person saved after the agent read it is refused to the
 * agent's next write as "changed since you read it", executeTool.ts.)
 */

import { classifyAsset } from '@softn/core';
import { useAIStore } from '../stores/aiStore';
import { hasUnsavedDraft, useEditStore } from '../stores/editStore';
import { useVFSStore } from '../stores/vfsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { VFSFile } from '../types/studio';
import { isPrivatePath } from './paths';

/** Why a file is not edited by hand, in words for the person, or null when it is. */
export function handEditRefusal(path: string, file: Pick<VFSFile, 'content'> | undefined): string | null {
  if (!file) return `${path} is not in the project.`;
  if (isPrivatePath(path)) return 'Studio keeps this file for itself (builder/ holds its notes on the project, and is not exported), so it is shown and not edited.';
  if (typeof file.content !== 'string') return `This file is kept as bytes (${classifyAsset(path).mime}), not text, so it is shown and not edited.`;
  return null;
}

/** Whether a run is working now: nothing is saved by hand until it stops. */
export function runIsWorking(): boolean {
  return useAIStore.getState().agentState === 'building';
}

/** Start editing `path` by hand. Answers why it cannot be, or null when the draft is open. */
export function beginHandEdit(path: string): string | null {
  // One draft at a time. Opening an editor on another file would have replaced a draft that
  // was not saved without a word: it is asked about, as anything else that leaves it is.
  const open = useEditStore.getState().draft;
  if (open?.path === path) return null;
  if (open && !confirmLeaveDraft()) return `${open.path} is still being edited, with changes that are not saved.`;
  const file = useVFSStore.getState().files.get(path);
  const refusal = handEditRefusal(path, file);
  if (refusal || !file || typeof file.content !== 'string') return refusal ?? `${path} is not text.`;
  useEditStore.getState().open({ path, text: file.content, baseVersion: file.version, baseText: file.content });
  return null;
}

export type HandSave =
  | { ok: true; changed: boolean }
  /** A run is working. */
  | { ok: false; kind: 'running'; message: string }
  /** The file is not the one the draft was made from. */
  | { ok: false; kind: 'changed'; message: string }
  /** The file has been deleted since. */
  | { ok: false; kind: 'gone'; message: string }
  /** A JSON file would be saved as something that is not JSON. */
  | { ok: false; kind: 'not-json'; message: string };

/** Files whose whole content has to be JSON for the app to open or its data to load. */
const JSON_FILE = /\.(json|xdb)$/i;

/** Why `text` is not what a JSON file can hold, or null when it parses. */
function jsonProblem(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Save the open draft. Nothing is written unless every rule holds: no run is
 * working, the file is still the one the draft began from, and a JSON file is
 * still JSON (or `evenIfNotJson`, which is the person having been told and
 * choosing to). A draft that changes nothing is closed without a write, so it
 * leaves no empty unit in the history.
 */
export function saveHandEdit(options: { evenIfNotJson?: boolean } = {}): HandSave {
  const draft = useEditStore.getState().draft;
  if (!draft) return { ok: true, changed: false };
  const { path } = draft;
  if (runIsWorking()) {
    return { ok: false, kind: 'running', message: 'The AI is working, and may be reading this file. Save when the run stops; what you typed is kept until then.' };
  }
  const file = useVFSStore.getState().files.get(path);
  if (!file) {
    return { ok: false, kind: 'gone', message: `${path} has been deleted since you began editing it, so there is nothing to save over. Copy what you need from here before you leave.` };
  }
  if (file.version !== draft.baseVersion || file.content !== draft.baseText) {
    return {
      ok: false,
      kind: 'changed',
      message: `${path} was changed while you were editing it, by the AI, by an undo in History or in another tab. Your changes were not saved, and nothing was written over. Reload the file to start again from what it is now (what you typed here is discarded), or keep editing to copy your changes out first.`,
    };
  }
  if (draft.text === draft.baseText) {
    useEditStore.getState().close();
    return { ok: true, changed: false };
  }
  if (JSON_FILE.test(path) && !options.evenIfNotJson) {
    const problem = jsonProblem(draft.text);
    if (problem) {
      return {
        ok: false,
        kind: 'not-json',
        message: `${path} would no longer be JSON (${problem}).${path === 'manifest.json' ? ' The app cannot be opened, run or exported until its manifest is.' : ''} Keep editing to fix it, or save it as it is.`,
      };
    }
  }
  useVFSStore.getState().updateFile(path, draft.text, 'user');
  const ws = useWorkspaceStore.getState();
  ws.setDirty(true);
  ws.addConsoleOutput(`[You] Edited ${path}`);
  useEditStore.getState().close();
  return { ok: true, changed: true };
}

/** Take the file as it is now into the draft, discarding what was typed. False when the file is gone. */
export function reloadHandEdit(): boolean {
  const draft = useEditStore.getState().draft;
  if (!draft) return false;
  const file = useVFSStore.getState().files.get(draft.path);
  if (!file || typeof file.content !== 'string') return false;
  useEditStore.getState().open({ path: draft.path, text: file.content, baseVersion: file.version, baseText: file.content });
  return true;
}

/**
 * The draft's path when its file is no longer in the project: the agent deleted or renamed it,
 * or an undo took back the write that created it. The canvas has moved on to another file by
 * then, and the draft would be left in the store with no editor on the page: what was typed
 * could not be seen, copied or let go of. The canvas shows the draft's editor instead.
 */
export function orphanedDraftPath(files: Map<string, VFSFile>): string | null {
  const draft = useEditStore.getState().draft;
  return draft && !files.has(draft.path) ? draft.path : null;
}

/**
 * Whether showing `path` on the canvas may go ahead: it may when that is the file being edited
 * (nothing is left), and otherwise when {@link confirmLeaveDraft} says so. The panels compared
 * the path with the workspace's active file, which is empty while the canvas shows the entry
 * page by default: choosing the very file being edited asked to discard its draft.
 */
export function confirmShowing(path: string): boolean {
  return useEditStore.getState().draft?.path === path || confirmLeaveDraft();
}

/**
 * Ask before something takes the person away from a draft they have not
 * saved: another file, the preview, another project, an import. True when
 * there is nothing to lose or they agree to lose it (and then it is
 * discarded); false when they would rather stay, and the caller does nothing.
 */
export function confirmLeaveDraft(): boolean {
  const draft = useEditStore.getState().draft;
  if (!draft) return true;
  if (hasUnsavedDraft() && !window.confirm(`${draft.path} has changes you have not saved.\n\nLeave it and discard them? Press Cancel to go back and save.`)) return false;
  useEditStore.getState().close();
  return true;
}
