/**
 * What it takes to put back an AI change after the page has reloaded.
 *
 * The VFS undo history lives in memory: it holds whole before-images, bytes
 * included, and it is not saved. Runs record the transactions they committed,
 * and "Undo" on a step or "Revert run" on a run used that history — so after
 * a reload (and runs are continued after reloads) both quietly had nothing to
 * work with. The journal is the part of that history that is saved: for each
 * AI transaction, per file, what the file was before (as text) and a
 * fingerprint of what it was after.
 *
 * The fingerprint is how a revert knows nothing else has changed the file
 * since: the file must still be what the transaction left, or already be what
 * it found (undone some other way, which is not a conflict). Anything else is
 * a later edit, and the revert is refused — the same rule the in-memory
 * history applies, by content instead of by order, so it holds across a
 * reload.
 *
 * The before-text is kept as a difference from the after-text: the common
 * start and end are counted, not copied, so an edit to one line of a long
 * file keeps a line, not the file. It can be rebuilt because a revert only
 * runs once the file is proven to be the after-text.
 *
 * Bounds. In memory the newest MAX_JOURNAL_ENTRIES entries keep their data,
 * bytes included, up to MAX_MEMORY_UNITS in all. In a saved project only
 * text is kept, newest first, up to MAX_PERSISTED_CHARS in all and
 * MAX_PERSISTED_ENTRY_CHARS for any one transaction. An entry beyond a bound
 * keeps its id and the reason it can no longer be undone, so the timeline can
 * say why instead of failing when pressed.
 */


export const MAX_JOURNAL_ENTRIES = 300;
/** Characters plus bytes of before-data held in memory across every entry. */
export const MAX_MEMORY_UNITS = 16_000_000;
/** Characters of before-text saved with a project, across every entry. */
export const MAX_PERSISTED_CHARS = 1_000_000;
/** Characters of before-text one transaction may take in a saved project. */
export const MAX_PERSISTED_ENTRY_CHARS = 250_000;
/** Ids kept, with a reason, for entries whose data is gone. */
export const MAX_TOMBSTONES = 1_000;

/** Why an entry's change cannot be put back. */
export type UndoLoss = 'binary' | 'too-large' | 'trimmed';

export interface Fingerprint {
  hash: string;
  length: number;
}

/** What a file was before, relative to what it was after. */
export type BeforeImage =
  /** The transaction created the file. */
  | { kind: 'absent' }
  /** before = after[0, prefix) + middle + after[after.length - suffix, end). With no text after, prefix = suffix = 0. */
  | { kind: 'text'; prefix: number; suffix: number; middle: string; fingerprint: Fingerprint }
  /** In memory only: a saved project records a binary change as lost. */
  | { kind: 'bytes'; bytes: Uint8Array; fingerprint: Fingerprint };

export interface UndoChange {
  path: string;
  before: BeforeImage;
  /** Null when the transaction deleted the file. */
  after: Fingerprint | null;
}

export interface UndoEntry {
  id: string;
  at: number;
  changes: UndoChange[];
  /** Set when the data is gone: the entry is kept so the reason can be shown. */
  lost?: UndoLoss;
}

export interface PersistedUndoJournal {
  version: 1;
  entries: UndoEntry[];
}

// --- Fingerprints -------------------------------------------------------------

/** cyrb53: a fast 53-bit hash. With the length beside it, a match by accident is not a practical concern. */
function cyrb53(read: (i: number) => number, length: number, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < length; i++) {
    const ch = read(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function fingerprint(content: string | Uint8Array): Fingerprint {
  if (typeof content === 'string') return { hash: `t${cyrb53((i) => content.charCodeAt(i), content.length)}`, length: content.length };
  return { hash: `b${cyrb53((i) => content[i], content.length)}`, length: content.length };
}

export function matches(content: string | Uint8Array | undefined, print: Fingerprint | null): boolean {
  if (print === null) return content === undefined;
  if (content === undefined || content.length !== print.length) return false;
  return fingerprint(content).hash === print.hash;
}

// --- Recording ----------------------------------------------------------------

/** The before-image of one file, as a difference from its after-content where both are text. */
export function beforeImage(before: string | Uint8Array | undefined, after: string | Uint8Array | undefined): BeforeImage {
  if (before === undefined) return { kind: 'absent' };
  const content = before;
  if (content instanceof Uint8Array) return { kind: 'bytes', bytes: content.slice(), fingerprint: fingerprint(content) };
  const print = fingerprint(content);
  if (typeof after !== 'string') return { kind: 'text', prefix: 0, suffix: 0, middle: content, fingerprint: print };
  const max = Math.min(content.length, after.length);
  let prefix = 0;
  while (prefix < max && content.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && content.charCodeAt(content.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  return { kind: 'text', prefix, suffix, middle: content.slice(prefix, content.length - suffix), fingerprint: print };
}

/** The before-content, given the after-content it was recorded against. */
export function rebuildBefore(image: Extract<BeforeImage, { kind: 'text' | 'bytes' }>, after: string | Uint8Array | undefined): string | Uint8Array {
  if (image.kind === 'bytes') return image.bytes.slice();
  if (image.prefix === 0 && image.suffix === 0) return image.middle;
  const text = typeof after === 'string' ? after : '';
  return text.slice(0, image.prefix) + image.middle + text.slice(text.length - image.suffix);
}

function entryUnits(entry: UndoEntry): number {
  let units = 0;
  for (const change of entry.changes) {
    if (change.before.kind === 'text') units += change.before.middle.length;
    else if (change.before.kind === 'bytes') units += change.before.bytes.length;
  }
  return units;
}

function entryHasBytes(entry: UndoEntry): boolean {
  return entry.changes.some((c) => c.before.kind === 'bytes');
}

function tombstone(entry: UndoEntry, lost: UndoLoss): UndoEntry {
  return { id: entry.id, at: entry.at, changes: [], lost: entry.lost ?? lost };
}

/**
 * Keep the journal within its in-memory bounds: the newest entries keep their
 * data; older ones become tombstones, and the oldest tombstones go.
 */
export function boundJournal(entries: UndoEntry[]): UndoEntry[] {
  let units = 0;
  let live = 0;
  const kept: UndoEntry[] = [];
  let tombstones = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.lost) {
      if (tombstones++ < MAX_TOMBSTONES) kept.push(entry);
      continue;
    }
    const size = entryUnits(entry);
    if (live < MAX_JOURNAL_ENTRIES && units + size <= MAX_MEMORY_UNITS) {
      live++;
      units += size;
      kept.push(entry);
    } else if (tombstones++ < MAX_TOMBSTONES) {
      kept.push(tombstone(entry, 'trimmed'));
    }
  }
  kept.reverse();
  return kept.length === entries.length && kept.every((e, i) => e === entries[i]) ? entries : kept;
}

// --- Saving and restoring -----------------------------------------------------

/** The journal as it is saved: text only, within the saved bounds, newest first to keep. */
export function persistJournal(entries: UndoEntry[]): PersistedUndoJournal {
  let chars = 0;
  const out: UndoEntry[] = [];
  let tombstones = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    let saved: UndoEntry;
    if (entry.lost) saved = entry;
    else if (entryHasBytes(entry)) saved = tombstone(entry, 'binary');
    else {
      const size = entryUnits(entry);
      if (size > MAX_PERSISTED_ENTRY_CHARS) saved = tombstone(entry, 'too-large');
      else if (chars + size > MAX_PERSISTED_CHARS) saved = tombstone(entry, 'trimmed');
      else {
        chars += size;
        saved = entry;
      }
    }
    if (saved.lost && tombstones++ >= MAX_TOMBSTONES) continue;
    out.push(saved);
  }
  out.reverse();
  return { version: 1, entries: out };
}

function isFingerprint(value: unknown): value is Fingerprint {
  const v = value as Fingerprint | null;
  return Boolean(v && typeof v === 'object' && typeof v.hash === 'string' && typeof v.length === 'number' && v.length >= 0);
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function readChange(value: unknown): UndoChange | null {
  const v = value as Partial<UndoChange> | null;
  if (!v || typeof v !== 'object' || typeof v.path !== 'string' || !v.path) return null;
  if (v.after !== null && !isFingerprint(v.after)) return null;
  const before = v.before as BeforeImage | undefined;
  if (!before || typeof before !== 'object') return null;
  if (before.kind === 'absent') return { path: v.path, before: { kind: 'absent' }, after: v.after };
  if (
    before.kind === 'text' &&
    isNonNegative(before.prefix) &&
    isNonNegative(before.suffix) &&
    typeof before.middle === 'string' &&
    isFingerprint(before.fingerprint)
  ) {
    // A difference needs text after to be rebuilt from.
    if ((before.prefix > 0 || before.suffix > 0) && (v.after === null || before.prefix + before.suffix > v.after.length)) return null;
    return { path: v.path, before: { kind: 'text', prefix: before.prefix, suffix: before.suffix, middle: before.middle, fingerprint: before.fingerprint }, after: v.after };
  }
  return null;
}

const LOSSES = new Set<UndoLoss>(['binary', 'too-large', 'trimmed']);

/**
 * A saved journal read back. A project saved before there was a journal has
 * none; an entry that does not read is left out, which the timeline explains
 * the same way — the step cannot be undone from here — rather than failing
 * the whole project's restore.
 */
export function readPersistedJournal(value: unknown): UndoEntry[] {
  const v = value as Partial<PersistedUndoJournal> | null;
  if (!v || typeof v !== 'object' || v.version !== 1 || !Array.isArray(v.entries)) return [];
  const out: UndoEntry[] = [];
  for (const raw of v.entries as unknown[]) {
    const e = raw as Partial<UndoEntry> | null;
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.at !== 'number' || !Array.isArray(e.changes)) continue;
    if (e.lost !== undefined) {
      if (LOSSES.has(e.lost)) out.push({ id: e.id, at: e.at, changes: [], lost: e.lost });
      continue;
    }
    const changes = e.changes.map(readChange);
    if (changes.some((c) => c === null)) continue;
    out.push({ id: e.id, at: e.at, changes: changes as UndoChange[] });
  }
  return boundJournal(out);
}

// --- Reverting ----------------------------------------------------------------

/** Why a transaction cannot be put back, in words for the timeline. Null when it can. */
export function undoUnavailableReason(entries: UndoEntry[], transactionId: string): string | null {
  const entry = entries.find((e) => e.id === transactionId);
  if (!entry) return "Can't be undone from here: no undo data was saved for this change (the project was saved by an earlier Studio, or the change was undone already).";
  if (entry.lost === 'binary') return "Can't be undone after a reload: it changed a binary file, and binary contents aren't kept for undo.";
  if (entry.lost === 'too-large') return "Can't be undone after a reload: the change was too large to keep undo data for.";
  if (entry.lost === 'trimmed') return "Can't be undone any more: only the newest changes keep their undo data, and this one is older.";
  return null;
}

/**
 * What an Undo or Revert for `transactionIds` (newest first) would meet now:
 * `unavailable` when the journal lacks the data (with the reason to show),
 * `undone` when every file already is what the transactions found (undone
 * some other way — Ctrl+Z, the History panel — which a redo can reverse),
 * and `available` otherwise. A file edited since still reads as available:
 * pressing the button is what names the edit and refuses.
 */
export type UndoState = { kind: 'available' } | { kind: 'undone' } | { kind: 'unavailable'; reason: string };

export function undoState(entries: UndoEntry[], transactionIds: string[], read: (path: string) => string | Uint8Array | undefined): UndoState {
  for (const id of transactionIds) {
    const reason = undoUnavailableReason(entries, id);
    if (reason) return { kind: 'unavailable', reason };
  }
  if (transactionIds.length === 0) return { kind: 'undone' };
  const plan = planRevert(entries, transactionIds, read);
  return !plan.ok && plan.already ? { kind: 'undone' } : { kind: 'available' };
}

export interface RevertPlanFile {
  path: string;
  /** Undefined: the file should not exist. */
  content: string | Uint8Array | undefined;
}

export type RevertPlan =
  | { ok: true; files: RevertPlanFile[]; paths: string[] }
  | { ok: false; reason: string; path?: string; already?: boolean };

/**
 * Work out what putting back `transactionIds` (newest first) would leave,
 * without touching anything. Every file must still be what the newest of
 * those transactions left it, or already be what the transaction found; the
 * first file that is neither is named, and nothing is planned.
 */
export function planRevert(
  entries: UndoEntry[],
  transactionIds: string[],
  read: (path: string) => string | Uint8Array | undefined,
  what = 'this change',
): RevertPlan {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const current = new Map<string, { content: string | Uint8Array | undefined }>();
  const at = (path: string) => {
    if (!current.has(path)) current.set(path, { content: read(path) });
    return current.get(path)!;
  };
  const touched: string[] = [];
  let changedAny = false;
  for (const id of transactionIds) {
    const entry = byId.get(id);
    const unavailable = undoUnavailableReason(entries, id);
    if (!entry || unavailable) return { ok: false, reason: unavailable ?? 'No undo data.' };
    for (const change of entry.changes) {
      const now = at(change.path);
      if (!touched.includes(change.path)) touched.push(change.path);
      const beforePrint = change.before.kind === 'absent' ? null : change.before.fingerprint;
      if (matches(now.content, change.after)) {
        if (change.before.kind === 'absent') current.set(change.path, { content: undefined });
        else current.set(change.path, { content: rebuildBefore(change.before, now.content) });
        changedAny = true;
      } else if (!matches(now.content, beforePrint)) {
        return { ok: false, reason: `${change.path} was edited after ${what}.`, path: change.path };
      }
    }
  }
  if (!changedAny) return { ok: false, reason: `${what[0].toUpperCase()}${what.slice(1)} is undone already.`, already: true };
  const files: RevertPlanFile[] = [];
  const paths: string[] = [];
  for (const path of touched) {
    const next = current.get(path)!;
    const was = read(path);
    if (was === next.content) continue;
    files.push({ path, content: next.content });
    paths.push(path);
  }
  return { ok: true, files, paths };
}
