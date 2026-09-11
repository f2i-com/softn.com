/**
 * A reply's file operations as a changeset: staged, resolved, judged, and
 * only then applied — all of it or none of it.
 *
 * Operations used to go into the VFS one by one as they were parsed, so a
 * reply with one refused or malformed block left the project half changed,
 * and the model was never told which half. Here every operation becomes a
 * record with a canonical path, the version it was built on, and a verdict;
 * the records are judged against each other (two spellings of one path,
 * a delete and an update of the same file) and against the project (a path
 * that is not a project path, private editor state, a file the model did
 * not see whole, a file that changed under the request). A changeset with
 * any refused record is not committed. That is the safe default the audit
 * asks for; an explicit reviewed-subset apply can be offered on top of it.
 */

import type { VFSChangeRecord } from '../stores/vfsStore';
import type { VFSFile } from '../types/studio';
import { canonicalKey, resolveProjectPath } from './paths';

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
  /** The VFS version at the time it was supplied. */
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
export function checkWrite(path: string, supplied: SuppliedFiles, current: VFSFile | undefined): WriteRefusal | null {
  if (!current) return null;
  const record = supplied.get(path);
  if (!record) {
    // Exists, but the model was never shown it: a binary, a file past the
    // budget, or one created since the prompt was built.
    return { kind: 'unseen' };
  }
  if (!record.complete) return { kind: 'partial', shown: record.shown, total: record.total };
  if (current.version !== record.version) return { kind: 'stale', suppliedVersion: record.version, currentVersion: current.version };
  return null;
}

export function describeRefusal(path: string, refusal: WriteRefusal): string {
  switch (refusal.kind) {
    case 'partial':
      return `Refused: ${path} was shown truncated (${refusal.shown} of ${refusal.total} characters), so this reply would have erased the rest of it. Nothing was written. Ask for the file whole, or ask for a smaller change.`;
    case 'unseen':
      return `Refused: ${path} exists but was not shown to the model, so this reply could not have preserved its content. Nothing was written.`;
    case 'stale':
      return `Refused: ${path} changed while the request was in flight (v${refusal.suppliedVersion} → v${refusal.currentVersion}), so this reply was built on old content. Nothing was written; ask again.`;
  }
}

export type ChangeOp = 'create' | 'update' | 'delete';

export type Verdict = { ok: true } | { ok: false; reason: string };

export interface ChangeRecord {
  /** The path as the reply wrote it. */
  requestedPath: string;
  /** The canonical path; the requested one when it did not resolve. */
  path: string;
  op: ChangeOp;
  /** The version the reply was built on, or null for a file the project did not hold when the prompt was made. */
  baseVersion: number | null;
  content?: string;
  verdict: Verdict;
}

export interface Changeset {
  /** The transaction/turn id the records commit under. */
  id: string;
  records: ChangeRecord[];
  /** Whether every record may be applied. */
  ok: boolean;
}

export interface ChangeRequest {
  files: Array<{ path: string; content: string }>;
  deletes: Array<{ path: string }>;
}

const refuse = (reason: string): Verdict => ({ ok: false, reason });

/**
 * Stage a reply's operations against the project as it is now and the base
 * the reply was built on. Nothing here touches the VFS.
 */
export function buildChangeset(id: string, request: ChangeRequest, base: TurnBase, files: Map<string, VFSFile>): Changeset {
  // The project's own spellings, so an alias of an existing file is caught.
  const existingByKey = new Map<string, string>();
  for (const path of files.keys()) existingByKey.set(canonicalKey(path), path);

  const records: ChangeRecord[] = [];
  const staged: Array<{ record: ChangeRecord; key: string | null }> = [];

  const stage = (requestedPath: string, op: 'write' | 'delete', content?: string) => {
    const verdict = resolveProjectPath(requestedPath);
    if (!verdict.ok) {
      const record: ChangeRecord = { requestedPath, path: requestedPath, op: op === 'delete' ? 'delete' : 'create', baseVersion: null, content, verdict: refuse(`Refused: ${verdict.reason}. Nothing was written.`) };
      records.push(record);
      staged.push({ record, key: null });
      return;
    }
    const current = files.get(verdict.path);
    const record: ChangeRecord = {
      requestedPath,
      path: verdict.path,
      op: op === 'delete' ? 'delete' : current ? 'update' : 'create',
      baseVersion: base.versions.get(verdict.path) ?? null,
      content,
      verdict: { ok: true },
    };
    if (verdict.private) {
      record.verdict = refuse(`Refused: ${verdict.path} is private editor state (builder/), which the model does not write. Nothing was written.`);
    } else {
      const alias = existingByKey.get(verdict.key);
      if (alias !== undefined && alias !== verdict.path) {
        record.verdict = refuse(`Refused: ${requestedPath} is the same file as the project's ${alias} on a case-insensitive disk. Use that path. Nothing was written.`);
      }
    }
    records.push(record);
    staged.push({ record, key: verdict.key });
  };

  for (const file of request.files) stage(file.path, 'write', file.content);
  for (const del of request.deletes) stage(del.path, 'delete');

  // Two records for one file — the same spelling twice, two spellings, or a
  // write and a delete — cannot both be meant; neither is applied.
  const byKey = new Map<string, ChangeRecord[]>();
  for (const { record, key } of staged) {
    if (key === null) continue;
    const list = byKey.get(key) ?? [];
    list.push(record);
    byKey.set(key, list);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const spellings = [...new Set(group.map((r) => r.requestedPath))].join(', ');
    for (const record of group) {
      if (record.verdict.ok) {
        record.verdict = refuse(`Refused: this reply names ${record.path} more than once (${spellings}), as ${group.map((r) => r.op).join(' and ')}. Nothing was written.`);
      }
    }
  }

  // Each record against the project: what the model saw, and what is there now.
  for (const record of records) {
    if (!record.verdict.ok) continue;
    const current = files.get(record.path);
    if (record.op === 'delete') {
      if (!current) {
        record.verdict = refuse(`Refused: ${record.path} does not exist, so it cannot be deleted. Nothing was written.`);
      } else if (record.baseVersion === null) {
        record.verdict = refuse(`Refused: ${record.path} was created after this request was made, so the reply cannot have meant it. Nothing was written.`);
      } else if (current.version !== record.baseVersion) {
        record.verdict = refuse(describeRefusal(record.path, { kind: 'stale', suppliedVersion: record.baseVersion, currentVersion: current.version }));
      }
      continue;
    }
    const refusal = checkWrite(record.path, base.supplied, current);
    if (refusal) record.verdict = refuse(describeRefusal(record.path, refusal));
  }

  return { id, records, ok: records.length > 0 && records.every((r) => r.verdict.ok) };
}

/** The store records of a changeset that passed, in reply order. */
export function toStoreRecords(changeset: Changeset): VFSChangeRecord[] {
  return changeset.records.map((r) => (r.op === 'delete' ? { op: 'delete', path: r.path } : { op: r.op, path: r.path, content: r.content ?? '' }));
}

/**
 * Lines added and removed between two texts, as a multiset difference by
 * line: enough for a card to say how big a change was, without the cost of
 * a full alignment on a long file. Binary content counts as no lines.
 */
export function diffSummary(before: string | Uint8Array | null | undefined, after: string | Uint8Array | null | undefined): { added: number; removed: number } {
  const linesOf = (text: string | Uint8Array | null | undefined): string[] => (typeof text === 'string' ? (text.length === 0 ? [] : text.split('\n')) : []);
  const counts = new Map<string, number>();
  for (const line of linesOf(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of linesOf(after)) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}

export function describeDiff(summary: { added: number; removed: number }): string {
  return `+${summary.added} −${summary.removed} line${summary.added + summary.removed === 1 ? '' : 's'}`;
}
