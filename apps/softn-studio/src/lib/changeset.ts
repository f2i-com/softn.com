/**
 * What the model was shown of each file, and whether a write may go ahead
 * given that: the part of the single-shot turn's changeset the agent's
 * write_file and edit_file still use (lib/agent/executeTool.ts).
 *
 * A reply used to be staged here whole as a changeset and applied all or
 * nothing. The agent writes one file per step instead, each its own undoable
 * transaction, and each is judged by checkWrite against what the run read.
 */

import type { VFSFile } from '../types/studio';

/**
 * What the model was shown of one file, and the version it was shown at.
 *
 * A reply replaces files whole, so a file the model saw only the head of
 * cannot be replaced from that reply without losing its tail: the record
 * of what was supplied is what lets the apply step refuse that. The
 * version is what lets it notice the file changed under the request.
 */
export interface SuppliedFile {
  path: string;
  /** Whether the whole content was in the prompt. */
  complete: boolean;
  /**
   * The VFS version at the time it was supplied. The store never gives a
   * path the same version twice in a session — not after a delete and a
   * re-create, not after an undo — so equal versions mean equal content.
   */
  version: number;
  /** Characters shown, of the total. */
  shown: number;
  total: number;
}

export type SuppliedFiles = Map<string, SuppliedFile>;

/**
 * What a turn was built on: the files supplied to the model, and the
 * version of every project file when the prompt was made — the base a
 * deletion is checked against, since a file can be deleted without having
 * been shown.
 */
export interface TurnBase {
  supplied: SuppliedFiles;
  versions: Map<string, number>;
}

/**
 * Why a file block may not be written. `partial` is the STU-01 case: the
 * model saw a truncated file, or none of it, and a whole-file reply would
 * erase what it did not see. `stale` is the file having changed since it
 * was supplied — a manual edit while the request was in flight — which a
 * replacement built on the old content would overwrite.
 */
export type WriteRefusal =
  | { kind: 'partial'; shown: number; total: number }
  | { kind: 'unseen' }
  | { kind: 'stale'; suppliedVersion: number; currentVersion: number };

/**
 * Whether a whole-file write of `path` may be applied given what the model
 * was supplied and what the VFS holds now. A new file is always allowed:
 * there is nothing to erase.
 */
export function checkWrite(
  path: string,
  supplied: SuppliedFiles,
  current: VFSFile | undefined,
  /**
   * `replace` writes the whole file, so the whole file must have been seen.
   * `edit` (the agent's edit_file) replaces one exact span that is matched
   * against the file as it is now, so part of it having been seen is enough —
   * but it must have been seen, and must not have changed since.
   */
  mode: 'replace' | 'edit' = 'replace',
): WriteRefusal | null {
  if (!current) return null;
  const record = supplied.get(path);
  if (!record) {
    // Exists, but the model was never shown it: a binary, a file past the
    // budget, or one created since the prompt was built.
    return { kind: 'unseen' };
  }
  if (!record.complete && mode === 'replace') return { kind: 'partial', shown: record.shown, total: record.total };
  if (current.version !== record.version) return { kind: 'stale', suppliedVersion: record.version, currentVersion: current.version };
  return null;
}
