/**
 * What a person changed in an app with the runtime's editor, kept beside the
 * app in their library and laid over its files when it opens.
 *
 * The saved bundle itself is never rewritten. An app is the digest of its
 * bytes: its saved data and what the person allowed it both belong to that,
 * so a bundle rewritten on each change would be a new app each time, with
 * none of its data. The changes are kept here instead, by the app's
 * identity, and the app goes on being itself. Taking them away ("Discard my
 * changes") leaves the app exactly as it was opened.
 *
 * Two versions are kept apart: the files as the last version that worked has
 * them, which is what runs, and the files as last typed where that is
 * something else (a change that does not work yet), which is what the editor
 * shows. An app never opens on text that did not run.
 *
 * And a third thing, apart from both: what a tab typed while another tab's
 * changes waited on a choice the person had not made yet (`asides`). That
 * text is nobody's decided change. It is kept so that it is never in memory
 * alone, under the name of the tab that typed it, where no other tab reads
 * it as a change and where writing it moves neither the draft's time nor its
 * writer: the other tab is asked only once this one has answered and really
 * written. It is offered back when an editor next opens on the app.
 *
 * In a database of its own, so the library's needs no new version.
 */

import { openDB, type IDBPDatabase } from 'idb';
import { readManifest } from '@softn/core';
import { processBundle } from '@softn/runtime-shell/bundleProcessor';
import { getDB } from '../lib/appCacheDb';
import { noteDraft } from '../lib/editIndex';

/** What one tab typed while another tab's changes waited on a choice. */
export interface SetAside {
  /** The files it typed in: text, or null for one it took out. */
  typed: Record<string, string | null>;
  /** The other tab's text (null: it took the file out) for each of those files it had changed as well. */
  theirs?: Record<string, string | null>;
  /** When it was last set aside. */
  at: number;
}

export interface EditDraft {
  /** The identity of the app these are changes to. */
  origin: string;
  /** Files of the last version that worked, where they are not the bundle's own: path to text. */
  files: Record<string, string>;
  /** The bundle's text files that version no longer has. */
  removed: string[];
  /** Files as last typed, where that is not what runs: text, or null for one taken out. */
  typed?: Record<string, string | null>;
  /**
   * In a draft as an opening editor is offered it (`offeredTo`): the other
   * tab's text for each file a set-aside text was typed over, which is what
   * the question is asked about again. Not stored: see `asides`.
   */
  aside?: Record<string, string | null>;
  /**
   * What each tab typed while another's changes waited on a choice, by the
   * tab's writer id. Not part of the draft to any other tab: it is not what
   * runs, not what was typed and kept, and no reason to ask anyone anything.
   */
  asides?: Record<string, SetAside>;
  /**
   * Who wrote it: one page's editor (an id made when the page loaded, known
   * to nothing else). A page's own writes are never another tab's to it,
   * whatever order they land in.
   */
  by?: string;
  /** When it was written. Each write is later than the one it replaces. */
  at: number;
}

interface EditDB {
  drafts: { key: string; value: EditDraft };
}

let db: Promise<IDBPDatabase<EditDB>> | null = null;

function drafts(): Promise<IDBPDatabase<EditDB>> {
  db ??= openDB<EditDB>('softn-web-edits', 1, {
    upgrade(made) {
      made.createObjectStore('drafts', { keyPath: 'origin' });
    },
    blocking(_current, _blocked, event) {
      // A newer build in another tab wants to change the store. Holding it
      // open would keep that tab waiting for good: it is closed, and opened
      // again, at whatever version it then has, by the next thing that asks.
      (event.target as IDBDatabase | null)?.close();
      db = null;
    },
    terminated() {
      db = null;
    },
  }).catch((problem) => {
    db = null;
    throw problem;
  });
  return db;
}

/** For tests: open the store again on the next call. */
export function resetDraftStore(): void {
  db = null;
}

/**
 * The changes kept beside an app, as they are stored: what runs, what was
 * typed and kept, and each tab's set-aside text under its own name. What an
 * editor that is already open reads of another tab's changes (never the
 * set-aside text: `asides` is not theirs to take).
 */
export async function readKept(origin: string): Promise<EditDraft | null> {
  try {
    return (await (await drafts()).get('drafts', origin)) ?? null;
  } catch {
    return null;
  }
}

/**
 * A kept draft as an editor that is opening is offered it: with one tab's
 * set-aside text laid over what was typed, and the other tab's text for the
 * same files beside it (`aside`), to be asked about. The set-aside text is
 * `writer`'s own where it has some (the same page, its editor opened again);
 * otherwise the newest there is (a page that was closed, or reloaded,
 * without an answer: its writer is gone, and its text is still the
 * person's). `from` names whose it was.
 */
export function offeredTo(kept: EditDraft, writer?: string): { draft: EditDraft; from?: string } {
  const { asides, ...draft } = kept;
  const all = Object.entries(asides ?? {});
  const own = writer !== undefined ? all.find(([by]) => by === writer) : undefined;
  const picked = own ?? all.sort(([, a], [, b]) => b.at - a.at)[0];
  if (!picked) return { draft };
  const [from, set] = picked;
  return {
    from,
    draft: {
      ...draft,
      typed: { ...(draft.typed ?? {}), ...set.typed },
      ...(set.theirs && Object.keys(set.theirs).length > 0 ? { aside: set.theirs } : {}),
    },
  };
}

/** The changes kept beside an app, as an editor opening on it is offered them (`offeredTo`). */
export async function readDraft(origin: string, writer?: string): Promise<EditDraft | null> {
  const kept = await readKept(origin);
  return kept ? offeredTo(kept, writer).draft : null;
}

/** Whether a draft changes what runs, and not only what the editor shows. */
export function changesWhatRuns(draft: Pick<EditDraft, 'files' | 'removed'>): boolean {
  return Object.keys(draft.files).length > 0 || draft.removed.length > 0;
}

/**
 * What became of a write. `kept` with the time it was written at (0 when
 * what was kept is nothing: no change is left to keep). Not kept, with the
 * draft `newer` than this tab knew of: another tab has written since, and
 * nothing of it was touched. Not kept, with none: the browser refused.
 */
export type DraftWrite = { kept: true; at: number } | { kept: false; newer?: EditDraft };

/** What a draft says, whoever wrote it and whenever: for telling a write that changes nothing from one that does. */
function said(draft: Pick<EditDraft, 'files' | 'removed' | 'typed' | 'aside'>): string {
  const sorted = <T>(record: Record<string, T> | undefined): Array<[string, T]> => Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([sorted(draft.files), [...draft.removed].sort(), sorted(draft.typed), sorted(draft.aside)]);
}

/**
 * Set-aside text is kept for a tab that may come back, not for good. No more
 * than this many tabs' worth for one app (the newest), and none older than
 * this: a tab that was closed on an unanswered question and never opened
 * again does not leave its text in the browser for ever.
 */
const ASIDES_PER_APP = 4;
const ASIDE_KEPT_FOR = 30 * 24 * 60 * 60 * 1000;

/** `asides` without those of `gone`, the stale and the ones past the count; undefined when none is left. */
function remaining(asides: Record<string, SetAside> | undefined, gone: readonly string[], now: number): Record<string, SetAside> | undefined {
  const left = Object.entries(asides ?? {})
    .filter(([by, set]) => !gone.includes(by) && now - set.at < ASIDE_KEPT_FOR)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, ASIDES_PER_APP);
  return left.length > 0 ? Object.fromEntries(left) : undefined;
}

const sameAsides = (a: Record<string, SetAside> | undefined, b: Record<string, SetAside> | undefined): boolean => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

/**
 * Keep `draft` (its `at` is given here), or nothing when it holds no change.
 *
 * `seenAt` is when the draft this writer last read or wrote was written; 0
 * for none. The stored draft is read in the transaction that writes. Where
 * it is newer than that and is someone else's (`by`), another tab has
 * changed the app since, and writing this tab's whole draft over it would
 * discard that tab's work with nothing said in either. So nothing is
 * written, and the newer draft is handed back for the person to choose.
 *
 * A stored draft that this writer wrote is never that, however its time
 * compares: two of one editor's own saves can be on their way at once (the
 * page is hidden while a change is being kept), and the second finds the
 * first's. And a write that says what is stored already writes nothing: the
 * draft keeps its time and its writer, so a tab that is only being left does
 * not look, to another, like a tab that changed something.
 *
 * A write that lands is this writer's answer: the text it had set aside
 * while a question waited is done with, and so is any set-aside text the
 * write answers for (`settles`: a closed tab's, offered to this editor when
 * it opened). Other tabs' set-aside text is carried over untouched.
 */
export async function writeDraft(draft: Omit<EditDraft, 'at'>, seenAt: number, settles: readonly string[] = draft.by !== undefined ? [draft.by] : [], now: number = Date.now()): Promise<DraftWrite> {
  const holds = changesWhatRuns(draft) || Object.keys(draft.typed ?? {}).length > 0;
  // What is written is the draft: never an offered view's `aside`, or another record's set-aside text.
  const { aside: _offered, asides: _theirs, ...written } = draft;
  try {
    const tx = (await drafts()).transaction('drafts', 'readwrite');
    const store = tx.objectStore('drafts');
    const stored = await store.get(draft.origin);
    const asides = remaining(stored?.asides, settles, now);
    if (stored && said(stored) === said(written)) {
      if (!sameAsides(stored.asides, asides)) {
        const { asides: _had, ...same } = stored;
        if (asides || changesWhatRuns(same) || Object.keys(same.typed ?? {}).length > 0) await store.put({ ...same, ...(asides ? { asides } : {}) });
        else await store.delete(draft.origin);
      }
      await tx.done;
      return { kept: true, at: stored.at };
    }
    const own = stored !== undefined && draft.by !== undefined && stored.by === draft.by;
    if (stored && !own && stored.at > seenAt) {
      await tx.done;
      return { kept: false, newer: stored };
    }
    const at = holds ? Math.max(now, seenAt + 1, (stored?.at ?? 0) + 1) : 0;
    if (holds) await store.put({ ...written, at, ...(asides ? { asides } : {}) });
    // Nothing of this writer's is left to keep. What other tabs set aside still is, under a draft that says nothing.
    else if (asides) await store.put({ origin: draft.origin, files: {}, removed: [], at: 0, asides });
    else await store.delete(draft.origin);
    await tx.done;
    noteDraft(draft.origin, changesWhatRuns(draft));
    return { kept: true, at };
  } catch (problem) {
    console.warn('[SoftN Web] Your changes could not be saved in this browser:', problem);
    return { kept: false };
  }
}

/**
 * Keep what `writer` typed while another tab's changes wait on a choice
 * (`set`), or forget it (null: it has answered, or has nothing typed).
 *
 * Kept under the writer's own name, beside the draft and apart from it: the
 * draft's files, its typed text, its time and its writer are as they were,
 * so no other tab sees a change, and none is asked about text that nobody
 * has decided on. False when the browser refused.
 */
export async function setAside(origin: string, writer: string, set: Omit<SetAside, 'at'> | null, now: number = Date.now()): Promise<boolean> {
  try {
    const tx = (await drafts()).transaction('drafts', 'readwrite');
    const store = tx.objectStore('drafts');
    const stored = await store.get(origin);
    const had = stored?.asides?.[writer];
    const next = set && Object.keys(set.typed).length > 0 ? set : null;
    // The same text again is not written again: it keeps the time it was first set aside.
    const unchanged = next === null ? had === undefined : had !== undefined && JSON.stringify([had.typed, had.theirs ?? {}]) === JSON.stringify([next.typed, next.theirs ?? {}]);
    if (!unchanged) {
      const asides = remaining({ ...(stored?.asides ?? {}), ...(next ? { [writer]: { ...next, at: now } } : {}) }, next ? [] : [writer], now);
      const { asides: _had, ...draft } = stored ?? { origin, files: {}, removed: [], at: 0 };
      if (asides || changesWhatRuns(draft) || Object.keys(draft.typed ?? {}).length > 0) await store.put({ ...draft, ...(asides ? { asides } : {}) });
      else await store.delete(origin);
    }
    await tx.done;
    return true;
  } catch (problem) {
    console.warn('[SoftN Web] What you typed could not be saved in this browser:', problem);
    return false;
  }
}

/** Forget everything kept beside an app: its changes, and every tab's set-aside text. For "Discard my changes", and for an app that is removed. */
export async function dropDraft(origin: string): Promise<void> {
  noteDraft(origin, false);
  try {
    await (await drafts()).delete('drafts', origin);
  } catch {
    // Nothing kept, or nothing reachable: either way there is no draft to lay.
  }
}

/** `files` with a draft's working version laid over them. */
export function withDraft(files: ReadonlyMap<string, string>, draft: Pick<EditDraft, 'files' | 'removed'>): Map<string, string> {
  const laid = new Map(files);
  for (const path of draft.removed) laid.delete(path);
  for (const [path, text] of Object.entries(draft.files)) laid.set(path, text);
  return laid;
}

/**
 * Lay the person's changes over an app's files as it opens. They are tried
 * on a copy first: changes the app cannot be put together from are not laid,
 * and the app opens as it was, with the changes still there for the editor.
 */
export async function layDraft(origin: string, textFiles: Map<string, string>): Promise<{ laid: boolean }> {
  const draft = await readKept(origin);
  if (!draft || !changesWhatRuns(draft)) {
    if (!draft) noteDraft(origin, false);
    return { laid: false };
  }
  try {
    const trial = withDraft(textFiles, draft);
    processBundle(trial, readManifest(trial));
  } catch (problem) {
    console.warn('[SoftN Web] The changes made in the editor are not shown, because the app cannot be put together with them:', problem);
    return { laid: false };
  }
  for (const path of draft.removed) textFiles.delete(path);
  for (const [path, text] of Object.entries(draft.files)) textFiles.set(path, text);
  return { laid: true };
}

/**
 * Forget what the person allowed the app with this identity, so that it asks
 * again when it next opens. For an edit that changes what the app asks for:
 * the answer was given to what it asked before, and the editor allows
 * nothing itself.
 */
export async function forgetPermissionGrant(origin: string): Promise<boolean> {
  try {
    const library = await getDB();
    const tx = library.transaction('softn-apps', 'readwrite');
    const store = tx.objectStore('softn-apps');
    const app = await store.index('by-origin').get(origin);
    if (app) {
      delete app.grantedPermissions;
      delete app.permissionsPromptedAt;
      delete app.grantedFor;
      await store.put(app);
    }
    await tx.done;
    return Boolean(app);
  } catch {
    console.warn('[SoftN Web] What this app was allowed could not be forgotten; it is asked again all the same.');
    return false;
  }
}
