import type { ChatMessage } from '../types/studio';
import type { PersistedFile, PersistedWorkspace, ProjectRecord } from './persistence';
import { persistJournal, type UndoEntry } from './undoJournal';

/**
 * One project open in two tabs: what a save writes when the other tab has
 * saved since this one last read or wrote the project.
 *
 * The record is saved whole, so a save used to be refused outright when the
 * stored copy was newer than the one this tab had seen: one change in either
 * tab (a hand edit, a run's step, even a panel opened) and every later save
 * in the other tab said "Not saved" until it was reloaded, however unrelated
 * the two tabs' work was. The save is now a merge, part by part, against what
 * this tab last had from storage (its base):
 *
 *   - a part this tab has not changed takes the stored one, which may be the
 *     other tab's change, and the stored one is brought into this tab;
 *   - a part the other tab has not changed takes this tab's;
 *   - a part both changed, to different things, is a conflict: storage keeps
 *     the other tab's, this tab keeps its own in memory, and the save says
 *     which parts they are. Nothing either tab wrote is put over silently.
 *
 * The parts: each file by its path; each of the project's own workspace
 * fields (its name, brief, plan, task list, approval, mode); each chat
 * message by its id; each undo-journal entry by its id; and the run counters,
 * which add up what each tab spent. The layout fields (panels, zoom, the page
 * on the canvas, the log) are this tab's view and are always this tab's.
 */

/** The workspace fields that are the project rather than this tab's view of it. */
export const PROJECT_FIELDS = ['projectName', 'brief', 'blueprint', 'taskGraph', 'blueprintApproved', 'mode'] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];

/** The parts of a merge a person could have changed, each by its key. */
export interface MergeParts {
  files: string[];
  fields: ProjectField[];
  messages: string[];
}

export interface MergeOutcome {
  /** What to write. */
  record: ProjectRecord;
  /** Parts where the stored value was taken over this tab's: they are to be brought into this tab. */
  taken: MergeParts & { journal: string[] };
  /** Parts the record holds as this tab has them, where storage holds something else: this tab's changes, which only a write puts in storage. */
  kept: MergeParts;
  /** Parts both tabs changed: storage keeps the other tab's, this tab keeps its own. */
  conflicts: MergeParts;
}

const MAX_MESSAGES = 200;

function sameContent(a: PersistedFile['content'], b: PersistedFile['content']): boolean {
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string') return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const sameFile = (a: PersistedFile, b: PersistedFile): boolean => sameContent(a.content, b.content);

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Absent on a side is a value too: a file deleted, a message not there. */
function same<T>(a: T | undefined, b: T | undefined, eq: (x: T, y: T) => boolean): boolean {
  if (a === undefined || b === undefined) return a === b;
  return eq(a, b);
}

/** Three-way, key by key. */
function mergeKeyed<T>(
  base: ReadonlyMap<string, T>,
  mine: ReadonlyMap<string, T>,
  theirs: ReadonlyMap<string, T>,
  eq: (a: T, b: T) => boolean,
): { value: Map<string, T>; taken: string[]; kept: string[]; conflicts: string[] } {
  const value = new Map<string, T>();
  const taken: string[] = [];
  const kept: string[] = [];
  const conflicts: string[] = [];
  for (const key of new Set([...mine.keys(), ...theirs.keys(), ...base.keys()])) {
    const b = base.get(key);
    const m = mine.get(key);
    const t = theirs.get(key);
    let chosen: T | undefined;
    if (same(m, b, eq)) {
      chosen = t;
      if (!same(t, m, eq)) taken.push(key);
    } else if (same(t, b, eq) || same(m, t, eq)) {
      chosen = m;
      if (!same(m, t, eq)) kept.push(key);
    } else {
      chosen = t;
      conflicts.push(key);
    }
    if (chosen !== undefined) value.set(key, chosen);
  }
  return { value, taken, kept, conflicts };
}

const byKey = <T>(items: readonly T[], key: (item: T) => string): Map<string, T> => new Map(items.map((item) => [key(item), item]));
const filePath = (file: PersistedFile): string => file.path;
const messageId = (message: ChatMessage): string => message.id;
const entryId = (entry: UndoEntry): string => entry.id;
const fieldsOf = (ws: PersistedWorkspace): Map<string, unknown> => new Map(PROJECT_FIELDS.map((field) => [field, ws[field]]));

/**
 * Two paths that are one file on a case-insensitive disk, one from each tab,
 * are a conflict and not two files: storage keeps the other tab's spelling,
 * and this tab's stays in memory. Answers both spellings of each such pair:
 * neither is brought into this tab, which would then hold the file twice.
 */
function aliasConflicts(value: Map<string, PersistedFile>, theirs: ReadonlyMap<string, PersistedFile>): { mine: string[]; theirs: string[] } {
  const seen = new Map<string, string>();
  const out = { mine: [] as string[], theirs: [] as string[] };
  for (const path of [...value.keys()].sort()) {
    const folded = path.toLowerCase();
    const other = seen.get(folded);
    if (other === undefined) {
      seen.set(folded, path);
      continue;
    }
    // Both spellings stored, or neither: not two tabs' files meeting.
    if (theirs.has(path) === theirs.has(other)) continue;
    const [mineOnly, theirsOnly] = theirs.has(path) ? [other, path] : [path, other];
    value.delete(mineOnly);
    out.mine.push(mineOnly);
    out.theirs.push(theirsOnly);
  }
  return out;
}

const earlier = (a: ChatMessage, b: ChatMessage): boolean => a.timestamp < b.timestamp || (!(a.timestamp > b.timestamp) && a.id < b.id);

/**
 * The messages in `keep`, in one order: each list's own order is kept (a
 * message after another in a tab's chat stays after it), and where no list
 * says which of two comes first, the one said earlier comes first, then the
 * lower id. The same lists give the same order in whichever order they are
 * given, so two tabs store one chat alike.
 *
 * The time alone was the order once. A message said after the clock was put
 * back sorted among the oldest, where the cap to 200 cut it; and two tabs'
 * messages of the same moment were stored in the order of whichever tab
 * saved. Where the lists contradict each other, the earliest of what is left
 * is taken, so every message in `keep` is placed.
 */
export function orderChat(lists: ReadonlyArray<readonly ChatMessage[]>, keep: ReadonlyMap<string, ChatMessage>): ChatMessage[] {
  const next = new Map<string, Set<string>>();
  const waiting = new Map<string, number>();
  for (const id of keep.keys()) {
    next.set(id, new Set());
    waiting.set(id, 0);
  }
  for (const list of lists) {
    let previous: string | null = null;
    for (const message of list) {
      if (!keep.has(message.id) || message.id === previous) continue;
      const after: Set<string> | null = previous === null ? null : next.get(previous)!;
      if (after && !after.has(message.id)) {
        after.add(message.id);
        waiting.set(message.id, waiting.get(message.id)! + 1);
      }
      previous = message.id;
    }
  }
  const left = new Set(keep.keys());
  const out: ChatMessage[] = [];
  while (left.size > 0) {
    let pick: ChatMessage | null = null;
    for (const id of left) {
      const message = keep.get(id)!;
      if (waiting.get(id)! <= 0 && (!pick || earlier(message, pick))) pick = message;
    }
    if (!pick) for (const id of left) {
      const message = keep.get(id)!;
      if (!pick || earlier(message, pick)) pick = message;
    }
    out.push(pick!);
    left.delete(pick!.id);
    for (const id of next.get(pick!.id)!) waiting.set(id, waiting.get(id)! - 1);
  }
  return out;
}

/** Chat messages of a merge in one order (see orderChat), the oldest by that order cut past 200. */
function orderMessages(value: Map<string, ChatMessage>, mine: readonly ChatMessage[], theirs: readonly ChatMessage[]): ChatMessage[] {
  const list = orderChat([mine, theirs], value);
  return list.length > MAX_MESSAGES ? list.slice(-MAX_MESSAGES) : list;
}

/**
 * Merge this tab's record with the stored one, against the base. `revision`
 * is what the merged record is written as: above both the stored one and
 * this tab's own.
 */
export function mergeProjectRecords(base: ProjectRecord, mine: ProjectRecord, theirs: ProjectRecord, revision: number): MergeOutcome {
  const mineFiles = byKey(mine.files, filePath);
  const theirFiles = byKey(theirs.files, filePath);
  const files = mergeKeyed(byKey(base.files, filePath), mineFiles, theirFiles, sameFile);
  const aliases = aliasConflicts(files.value, theirFiles);
  const fileConflicts = [...files.conflicts, ...aliases.mine];

  const fields = mergeKeyed(fieldsOf(base.workspace), fieldsOf(mine.workspace), fieldsOf(theirs.workspace), sameJson);
  const messages = mergeKeyed(byKey(base.session.messages, messageId), byKey(mine.session.messages, messageId), byKey(theirs.session.messages, messageId), sameJson);

  // Undo data is not work, and not a reason to refuse a save: where both tabs changed an entry
  // (each trimmed it to a note of why it cannot be undone), this tab's stands.
  const mineEntries = byKey(mine.undo?.entries ?? [], entryId);
  const journal = mergeKeyed(byKey(base.undo?.entries ?? [], entryId), mineEntries, byKey(theirs.undo?.entries ?? [], entryId), sameJson);
  for (const key of journal.conflicts) {
    const entry = mineEntries.get(key);
    if (entry) journal.value.set(key, entry);
    else journal.value.delete(key);
  }

  // What each tab spent since the base, added up.
  const counter = (key: 'iterationsUsed' | 'tokensUsed' | 'filesChanged') =>
    Math.max(0, mine.session[key] + theirs.session[key] - base.session[key]);

  const workspace: PersistedWorkspace = { ...mine.workspace };
  for (const field of PROJECT_FIELDS) (workspace as unknown as Record<string, unknown>)[field] = fields.value.get(field);

  // In this tab's order, then the files only the other tab has.
  const order = [...new Set([...mine.files.map(filePath), ...theirs.files.map(filePath)])];
  const record: ProjectRecord = {
    ...mine,
    revision,
    workspace,
    files: order.filter((path) => files.value.has(path)).map((path) => files.value.get(path)!),
    session: {
      messages: orderMessages(messages.value, mine.session.messages, theirs.session.messages),
      iterationsUsed: counter('iterationsUsed'),
      tokensUsed: counter('tokensUsed'),
      filesChanged: counter('filesChanged'),
    },
    undo: persistJournal([...journal.value.values()].sort((a, b) => a.at - b.at)),
  };
  return {
    record,
    taken: {
      files: files.taken.filter((path) => !fileConflicts.includes(path) && !aliases.theirs.includes(path)),
      fields: fields.taken as ProjectField[],
      messages: messages.taken,
      journal: journal.taken.filter((key) => !journal.conflicts.includes(key)),
    },
    // Not the undo data: where both tabs trimmed an entry each keeps its own, and neither is work to write.
    kept: { files: files.kept.filter((path) => !aliases.mine.includes(path)), fields: fields.kept as ProjectField[], messages: messages.kept },
    conflicts: { files: fileConflicts, fields: fields.conflicts as ProjectField[], messages: messages.conflicts },
  };
}

/** Whether `parts` names any part at all. */
export function hasParts(parts: MergeParts): boolean {
  return parts.files.length + parts.fields.length + parts.messages.length > 0;
}

export function hasConflicts(conflicts: MergeParts): boolean {
  return hasParts(conflicts);
}

const FIELD_NAMES: Record<ProjectField, string> = {
  projectName: 'the app’s name',
  brief: 'the brief',
  blueprint: 'the plan',
  taskGraph: 'the task list',
  blueprintApproved: 'the plan’s approval',
  mode: 'the project’s stage',
};

/** Parts of a project, in words: "ui/main.ui and the plan". Empty for none. */
export function describeParts(parts: MergeParts): string {
  const more = parts.files.length - 3;
  const names = [...parts.files.slice(0, 3), ...(more > 0 ? [`${more} more file${more === 1 ? '' : 's'}`] : [])];
  names.push(...parts.fields.map((field) => FIELD_NAMES[field]));
  if (parts.messages.length > 0) names.push(parts.messages.length === 1 ? 'a chat message' : `${parts.messages.length} chat messages`);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What this tab now holds as having come from storage, after a merged save.
 *
 * A part is at the merged value when this tab holds that value: it wrote it,
 * or it brought it in (`applied`). A part it could not bring in (a conflict,
 * or a part the person changed while the save was in flight) keeps its old
 * base, so the next save still sees the other tab's change as a change and
 * does not write this tab's copy over it. `pinned` says whether any part was
 * kept back like that: then storage is no longer what the base says, and the
 * next save must merge even when no other tab has saved since. The undo data
 * and the counters are always brought in, and are at the merged value.
 */
export function baseAfterMerge(oldBase: ProjectRecord, collected: ProjectRecord, merged: ProjectRecord, applied: MergeParts): { base: ProjectRecord; pinned: boolean } {
  let pinned = false;
  /** One kind of part: each key at the merged value when this tab holds it, at its old base when not. */
  const rebase = <T>(wrote: ReadonlyMap<string, T>, written: ReadonlyMap<string, T>, before: ReadonlyMap<string, T>, appliedKeys: readonly string[], eq: (a: T, b: T) => boolean): T[] => {
    const out: T[] = [];
    for (const key of new Set([...written.keys(), ...before.keys()])) {
      let value = written.get(key);
      if (!same(value, wrote.get(key), eq) && !appliedKeys.includes(key)) {
        pinned = true;
        value = before.get(key);
      }
      if (value !== undefined) out.push(value);
    }
    return out;
  };

  const files = rebase(byKey(collected.files, filePath), byKey(merged.files, filePath), byKey(oldBase.files, filePath), applied.files, sameFile);
  const messages = rebase(byKey(collected.session.messages, messageId), byKey(merged.session.messages, messageId), byKey(oldBase.session.messages, messageId), applied.messages, sameJson);

  const workspace: PersistedWorkspace = { ...merged.workspace };
  const wroteFields = fieldsOf(collected.workspace);
  const oldFields = fieldsOf(oldBase.workspace);
  for (const field of PROJECT_FIELDS) {
    if (!sameJson(merged.workspace[field], wroteFields.get(field)) && !applied.fields.includes(field)) {
      pinned = true;
      (workspace as unknown as Record<string, unknown>)[field] = oldFields.get(field);
    }
  }

  return { base: { ...merged, workspace, files, session: { ...merged.session, messages } }, pinned };
}
