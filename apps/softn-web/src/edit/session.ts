/**
 * One app being edited while it runs: its files as the editor shows them,
 * what became of each change, and whose app it is.
 *
 * Three versions of the files are kept apart. `base` is the bundle's own
 * text, as the app was opened and as "Discard my changes" returns it. `good`
 * is the last version that worked, which is what is running. `files` is what
 * the person has typed, which is `good` except while a change does not work
 * yet. A change goes to the running app through `updateOpenApp`, and the
 * answer is said in one line; a change the running app cannot take where it
 * stands (its manifest, what it asks permission for, another language for
 * its logic) opens the app afresh, and what it newly asks for is asked of
 * the person by the runtime's own bar, never allowed here.
 *
 * Whose app it is decides where a change is kept. One that is the person's
 * (from a file, from Studio or the Builder, a copy they made) keeps their
 * changes beside it in their library (./drafts): the app keeps its identity,
 * its saved data and what it was allowed. One from the directory or a link is
 * someone else's and is never changed: the first change makes a copy in the
 * person's library, under a name of its own, and the tab becomes that copy.
 *
 * What is typed is kept beside the app before the app is handed it, so a
 * page closed while the app is still answering loses nothing. And it is
 * never written over what another tab kept since this one last looked: the
 * person is told, and chooses.
 */

import { classifyAsset, composePage, createLiveApp, isUnsafeEntryName, readManifest, type AppUpdateResult, type LiveApp } from '@softn/core';
import { extractPermissions, processBundle, readZip, requestedCapabilities } from '@softn/runtime-shell/bundleProcessor';
import { declarationKey, grantRecord } from '@softn/runtime-shell/consent';
import { cacheApp, copyAppData, forgetSyncNotes, getCachedApps, recordPermissionGrant, renameCachedApp } from '../lib/appCache';
import { planOpenAppUpdate, updateOpenApp, type OpenAppUpdate, type RevisedTabFields } from '../lib/liveUpdate';
import type { OpenTab } from '../lib/openBundle';
import { bundleWith, damagedFile } from './bundle';
import { changesWhatRuns, dropDraft, forgetPermissionGrant, offeredTo, readKept, setAside, withDraft, writeDraft, type DraftWrite, type EditDraft, type SetAside } from './drafts';
import type { EditHost } from './host';

export interface EditStatus {
  /** `ok`: the change is showing. `held`: it is not, and the last version that worked still runs. `busy`: being done. `quiet`: nothing to say. */
  kind: 'quiet' | 'ok' | 'held' | 'busy';
  text: string;
  /** held: where the problem is, when it says. */
  file?: string;
  line?: number;
  /** held: another tab changed the app, and the person chooses whose changes stand (`takeTheirs`, `keepMine`). */
  choose?: 'tabs';
}

/** A file of the app, for the editor's list. */
export interface FileEntry {
  path: string;
  /**
   * What it is to the app: a page, its logic, its styles, its data, what the
   * app is (its manifest and what it asks permission for), other text, or a
   * picture or another file that is carried as it is and not read as text.
   */
  kind: 'page' | 'logic' | 'style' | 'data' | 'app' | 'other' | 'picture';
  /** Text, which the editor opens; a picture is listed by name. */
  text: boolean;
  /** Not as the app was opened: changed, or added. */
  changed: boolean;
  /** Typed, and not showing yet. */
  held: boolean;
}

/** What the session keeps and reads outside itself; a test gives its own. */
export interface EditStore {
  /** The changes kept beside the app, as they are stored (./drafts, `readKept`). */
  readDraft(origin: string): Promise<EditDraft | null>;
  /**
   * Keep the person's changes, unless another tab has kept its own since
   * `seenAt`. A write that lands is this writer's answer: the set-aside text
   * of the writers in `settles` is done with (./drafts).
   */
  writeDraft(draft: Omit<EditDraft, 'at'>, seenAt: number, settles?: readonly string[]): Promise<DraftWrite>;
  /** Keep what `writer` typed while another tab's changes wait on a choice, apart from the draft; or forget it (null). */
  setAside(origin: string, writer: string, set: Omit<SetAside, 'at'> | null): Promise<boolean>;
  dropDraft(origin: string): Promise<void>;
  forgetGrant(origin: string): Promise<boolean>;
  /** The names of the apps in the person's library: each one's shown name, and its bundle's own where that is another. */
  libraryNames(): Promise<string[]>;
  /**
   * Show the app in the person's library under `name`, which its manifest
   * now has. Resolves with its bundle's own name where that is another one:
   * the name its address is always written with.
   */
  renameApp(origin: string, name: string): Promise<string | undefined>;
  /**
   * Save `bytes` as an app of the person's own, with the records `from` holds
   * copied to it and, when `allowed`, the same things allowed, as an answer
   * to `declaration`. Resolves with its identity, or null when it could not
   * be saved.
   */
  saveCopy(copy: {
    bytes: Uint8Array;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    requested: string[];
    allowed: boolean;
    declaration: string;
    from: string;
  }): Promise<string | null>;
}

/** The person's library in this browser, and the editor's own store beside it. */
export const libraryStore: EditStore = {
  readDraft: readKept,
  writeDraft,
  setAside,
  dropDraft,
  forgetGrant: forgetPermissionGrant,
  // Both names of each: the one it is shown under, and its bundle's own where the person has renamed it.
  libraryNames: async () => (await getCachedApps()).flatMap((app) => (app.ownName !== undefined ? [app.name, app.ownName] : [app.name])),
  renameApp: async (origin, name) => (await renameCachedApp(origin, name))?.ownName,
  saveCopy: async ({ bytes, name, version, description, icon, requested, allowed, declaration, from }) => {
    const record = await cacheApp(bytes, { name, version, description }, icon, undefined, requested);
    if (!record?.origin) return null;
    // What the person allowed the app, their copy of it is allowed too: it
    // asks for the same things, and it is theirs. What a later edit adds is
    // asked for like anything new.
    if (allowed && requested.length > 0) await recordPermissionGrant(record.origin, grantRecord(requested), declaration);
    // Their records in it come along. Where the app stood with sync does not:
    // the room it was in is the published app's, with other people in it, and
    // what it had queued to send is not the copy's to send.
    const carried = copyAppData(from, record.origin);
    if (!carried.ok) console.warn('[SoftN Web] Your copy starts without the data the app had saved:', carried.error);
    forgetSyncNotes(record.origin);
    return record.origin;
  },
};

const PAGE = /\.(ui|softn|html?)$/i;
const LOGIC = /\.(logic|js|mjs|ts|py)$/i;
const STYLE = /\.css$/i;
const DATA = /\.(json|xdb|csv|txt|md)$/i;

function kindOf(path: string, text: boolean): FileEntry['kind'] {
  if (!text) return 'picture';
  if (path === 'manifest.json' || path === 'permission.json') return 'app';
  if (PAGE.test(path)) return 'page';
  if (LOGIC.test(path)) return 'logic';
  if (STYLE.test(path)) return 'style';
  if (DATA.test(path)) return 'data';
  return 'other';
}

/** What an app's logic can read by `import`, beside what is composed into its page. */
const IMPORTED = /\.(logic|js|mjs|cjs|ts|py|json)$/i;

const KIND_ORDER: Record<FileEntry['kind'], number> = { page: 0, logic: 1, style: 2, data: 3, app: 4, other: 5, picture: 6 };

function sameFiles(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, text] of a) if (b.get(path) !== text) return false;
  return true;
}

/** What `to` has that `from` does not have the same: path to text, and the paths `from` has that `to` lacks. */
function difference(from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>): { files: Record<string, string>; removed: string[] } {
  const files: Record<string, string> = {};
  for (const [path, text] of to) if (from.get(path) !== text) files[path] = text;
  const removed = [...from.keys()].filter((path) => !to.has(path));
  return { files, removed };
}

/** The files a kept draft shows in the editor: the bundle's, with what runs laid over them, then what was typed. */
function shownBy(base: ReadonlyMap<string, string>, draft: Pick<EditDraft, 'files' | 'removed' | 'typed'>): Map<string, string> {
  const shown = withDraft(base, draft);
  for (const [path, text] of Object.entries(draft.typed ?? {})) {
    if (text === null) shown.delete(path);
    else shown.set(path, text);
  }
  return shown;
}

/**
 * What a set of files asks permission for, as one text to compare, in the
 * form an answer is kept with (`declarationKey`): the same asks written in
 * another order are the same ask. Null when it cannot be read.
 */
function asks(files: ReadonlyMap<string, string>): string | null {
  try {
    return declarationKey(extractPermissions(files, readManifest(files) as never) ?? { permissions: {} });
  } catch {
    return null;
  }
}

/** The name a manifest gives its app, as the runtime shows it (no spaces round it); null where it gives none that can be read. */
function nameOf(manifest: string | undefined): string | null {
  try {
    const name = (JSON.parse(manifest ?? '') as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/** An id nothing else has: for a page's editor as a writer, and for a copy as an app of its own. */
function freshId(): string {
  const parts = new Uint32Array(4);
  crypto.getRandomValues(parts);
  return Array.from(parts, (part) => part.toString(36)).join('');
}

/**
 * Who a page's editor is to the store its changes are kept in: one id for
 * the page, made when its editor is first opened. Every editor the page
 * opens writes under it, so nothing the page itself wrote is ever "another
 * tab's" to it.
 */
const writers = new WeakMap<EditHost, string>();
function writerOf(host: EditHost): string {
  let writer = writers.get(host);
  if (writer === undefined) writers.set(host, (writer = freshId()));
  return writer;
}

/**
 * The editor last opened on each tab of a page. One that was put away while
 * the app was still answering goes on to its answer; if another has been
 * opened on the tab by then, the keeping is that one's, and the older one
 * writes nothing more over it.
 */
const newest = new WeakMap<EditHost, Map<string, object>>();

/**
 * `text`, a manifest, with `name` as its app's name and everything else of
 * it as it is written: its spacing, its order, its other values. Null where
 * it is not a manifest that can be read, or has no name to change.
 */
function withManifestName(text: string, name: string, copy?: string): string | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const wanted = sortedJson({ ...(manifest as object), name, ...(copy !== undefined ? { copy } : {}) });
  const reads = (candidate: string): boolean => {
    try {
      return sortedJson(JSON.parse(candidate)) === wanted;
    } catch {
      return false;
    }
  };
  // A "name" may be written deeper in it too (an author's, a page's). The one
  // to change is the one that leaves the manifest reading as wanted. A copy's
  // mark is written beside it, or over the mark the manifest came with (a
  // copy of a copy).
  const marked = copy !== undefined && typeof (manifest as { copy?: unknown }).copy === 'string';
  const written = /("name"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
  for (let match = written.exec(text); match; match = written.exec(text)) {
    const mark = copy !== undefined && !marked ? `, "copy": ${JSON.stringify(copy)}` : '';
    const candidate = text.slice(0, match.index) + match[1] + JSON.stringify(name) + mark + text.slice(match.index + match[0].length);
    if (!marked) {
      if (reads(candidate)) return candidate;
      continue;
    }
    const marks = /("copy"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
    for (let had = marks.exec(candidate); had; had = marks.exec(candidate)) {
      const both = candidate.slice(0, had.index) + had[1] + JSON.stringify(copy) + candidate.slice(had.index + had[0].length);
      if (reads(both)) return both;
    }
  }
  return null;
}

/** JSON with every object's keys in one order: two texts that say the same read the same. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner as object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : inner
  );
}

/** The name of a copy of the app called `of`: its own, within the 255 characters a name may have. */
function copyName(of: string, n: number): string {
  const suffix = n < 2 ? ' (my copy)' : ` (my copy ${n})`;
  let stem = of.slice(0, 255 - suffix.length);
  // Not the first half of a character that is written in two.
  if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1);
  return stem.trimEnd() + suffix;
}

/** Where a problem says it is: "ui/main.ui, line 3, column 5: …". */
function placeOf(problem: string): { file?: string; line?: number } {
  const at = /^(.+?), line (\d+)(?:, column \d+)?:/.exec(problem);
  if (at) return { file: at[1], line: Number(at[2]) };
  const line = /\bline (\d+)\b/i.exec(problem);
  return line ? { line: Number(line[1]) } : {};
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const said = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));

interface History {
  past: string[];
  future: string[];
  /** When the last change was typed, so a run of typing is one step back. */
  typedAt: number;
}

/** The steps back a file keeps: this many, and no more text than this in all (a large file keeps fewer). */
const HISTORY_STEPS = 200;
const HISTORY_CHARS = 8_000_000;

function trimSteps(steps: string[]): void {
  let held = 0;
  for (const text of steps) held += text.length;
  while (steps.length > 1 && (steps.length > HISTORY_STEPS || held > HISTORY_CHARS)) held -= (steps.shift() as string).length;
}

/**
 * A text file longer than this is shown and not edited here: the editor
 * draws the whole file again on each key, and what a key costs grows with
 * the file. Measured in Chromium on 2026-11-12 (one key, until it is drawn):
 * 26 ms at 390 KB, 60 to 100 ms at 1 MB (text and JSON at the low end, a
 * page at the high end), 115 to 125 ms at 2 MB of text or JSON. That is slow
 * and still usable; past it, a fast typist is ahead of the screen. Each
 * pause also writes the whole file beside the app and puts a copy in its
 * steps back.
 */
export const LARGEST_EDITED = 2_500_000;

/** How long putting the editor away waits for the app to answer a change still in flight. */
const CLOSE_WAIT = 4000;

const CHANGED_IN_ANOTHER_TAB =
  'This app was changed in another tab, so what you changed here is not saved yet. Take those changes, or keep yours. A file changed in only one of the two keeps its change either way.';

export interface EditSessionOptions {
  store?: EditStore;
  /** How long after the last keystroke a change is handed to the app, in milliseconds. */
  pause?: number;
  now?: () => number;
  /** Makes the running app a copy starts as; core's `createLiveApp` unless a test gives its own. */
  makeLive?: () => LiveApp;
  /** How long putting the editor away waits for the app to answer a change still in flight, in milliseconds. */
  closeWait?: number;
}

export class EditSession {
  /** The files as the editor shows them. */
  readonly files = new Map<string, string>();
  status: EditStatus = { kind: 'quiet', text: '' };
  /** Counts every change to what the editor draws from. */
  version = 0;
  /** The name of the copy this session made of someone else's app, once it has. */
  copied: string | null = null;

  private base = new Map<string, string>();
  private good = new Map<string, string>();
  private binaries: string[] = [];
  /** Text files of the bundle that cannot be read: listed by name, and the reason the app cannot be copied or written as a file. */
  private damaged: string[] = [];
  /** When the kept changes this session last read or wrote were written; 0 for none. */
  private seenAt = 0;
  /** The files those kept changes show. */
  private seen = new Map<string, string>();
  /** Changes another tab kept since, which nothing here has been written over. */
  private theirs: EditDraft | null = null;
  /**
   * Files both this editor and another tab had changed when it was last put
   * away, or its page hidden, without a choice: asked about again when it
   * opens (`EditDraft.aside`).
   */
  private undecided = new Set<string>();
  /** The writer whose set-aside text this editor was offered when it opened, where that is not itself: a page that is gone. Done with once this editor has really written. */
  private adopted: string | null = null;
  /** Who this page's editor is to the store (`writerOf`). */
  private readonly writer: string;
  /** This editor's writes to the store, one after another. */
  private keeping: Promise<unknown> = Promise.resolve();
  /** Changes the person made to this app when it was theirs alone, kept beside it; it is someone else's now, and they are not laid. */
  private stranded: EditDraft | null = null;
  private strandedName: string | null = null;
  private readonly histories = new Map<string, History>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly store: EditStore;
  private readonly pause: number;
  private readonly now: () => number;
  private readonly makeLive: () => LiveApp;
  private readonly closeWait: number;
  private heard: ((result: AppUpdateResult) => void) | null = null;
  private readonly stopHearing: () => void;

  private constructor(
    private readonly host: EditHost,
    readonly tabId: string,
    options: EditSessionOptions
  ) {
    this.store = options.store ?? libraryStore;
    this.pause = options.pause ?? 400;
    this.now = options.now ?? Date.now;
    this.makeLive = options.makeLive ?? createLiveApp;
    this.closeWait = options.closeWait ?? CLOSE_WAIT;
    this.writer = writerOf(host);
    let onTabs = newest.get(host);
    if (!onTabs) newest.set(host, (onTabs = new Map()));
    onTabs.set(tabId, this);
    this.stopHearing = host.onAppUpdate((tabId, result) => {
      if (tabId === this.tabId) this.heard?.(result);
    });
  }

  /** Begin editing the app in a tab: its files as they are running, and what the person had typed that is not. */
  static async open(host: EditHost, tabId: string, options: EditSessionOptions = {}): Promise<EditSession | null> {
    const tab = host.tab(tabId);
    if (!tab?.appId || !tab.bundleData || !tab.textFiles) return null;
    const session = new EditSession(host, tabId, options);
    const zip = readZip(tab.bundleData);
    // Each text file is read by name. One that is damaged where it lies in
    // the bundle fails the read that asks for it and no other: the app runs
    // without ever asking, and the editor lists it by name, unopened.
    const damaged = new Set<string>();
    const read = (from: ReadonlyMap<string, string>): Map<string, string> => {
      const texts = new Map<string, string>();
      for (const path of from.keys()) {
        try {
          const text = from.get(path);
          if (text !== undefined) texts.set(path, text);
        } catch {
          damaged.add(path);
        }
      }
      return texts;
    };
    session.base = read(zip.textFiles);
    session.good = read(tab.textFiles);
    session.damaged = [...damaged].sort();
    session.binaries = [...zip.binaryFiles.keys(), ...session.damaged].sort();
    zip.binaryFiles.release();
    for (const [path, text] of session.good) session.files.set(path, text);
    // What is kept beside the app, and of it what this editor is offered:
    // the draft, with the text a tab set aside while a question waited (this
    // page's own, or that of a page that is gone) laid over what was typed.
    const kept = await session.store.readDraft(tab.appId);
    const offer = kept ? offeredTo(kept, session.writer) : null;
    const draft = offer?.draft ?? null;
    if (draft && tab.mine === false) {
      // Theirs once, and someone else's now: the app has since been opened
      // from the directory or by a link. Nothing is laid over such an open.
      // The changes are still the person's, and are offered (`bringEarlier`).
      if (changesWhatRuns(draft) || Object.keys(draft.typed ?? {}).length > 0) {
        session.stranded = draft;
        session.strandedName = nameOf(session.base.get('manifest.json'));
      }
    } else if (draft) {
      session.seenAt = draft.at;
      // The files as they were last kept: what runs, where the app opened
      // with it; what was kept and is not running (the app did not open with
      // it, or another tab has changed it since this one opened), which is
      // shown and handed to the app again; and what was typed and never shown.
      session.files.clear();
      for (const [path, text] of shownBy(session.base, draft)) session.files.set(path, text);
      if (offer?.from !== undefined && offer.from !== session.writer) session.adopted = offer.from;
    }
    // What this editor knows of the draft proper, which is what a later
    // change is told apart from: the set-aside text is not part of it, so it
    // still counts as typed here, and is set aside again with what follows.
    session.seen = kept && draft && tab.mine !== false ? shownBy(session.base, kept) : new Map(session.files);
    const aside = draft && tab.mine !== false ? Object.keys(draft.aside ?? {}) : [];
    if (kept && aside.length > 0) {
      // Put away last time with a choice unmade: another tab had changed
      // these files too. What was typed here is shown; the other tab's text
      // for them is what is kept as running, and the question is asked again.
      session.undecided = new Set(aside);
      session.theirs = kept;
      session.status = session.elsewhere();
    } else if (!sameFiles(session.files, session.good)) {
      session.schedule(0);
    }
    return session;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private changed(): void {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }

  private say(status: EditStatus): void {
    // A question that has not been answered is not painted over: "Updated."
    // in its place left an editor that kept nothing and said all was well.
    this.status = this.theirs && status.choose !== 'tabs' && status.kind !== 'busy' ? this.elsewhere() : status;
    this.changed();
  }

  private tab(): OpenTab | undefined {
    return this.host.tab(this.tabId);
  }

  /** Whose app this is, for the editor to say. */
  whose(): 'mine' | 'theirs' {
    return this.tab()?.mine === false ? 'theirs' : 'mine';
  }

  /** Whether what is running is the person's changed version and not the app as it was opened. */
  runningChanges(): boolean {
    return !sameFiles(this.good, this.base);
  }

  /** Whether anything is typed that is not showing. */
  holding(): boolean {
    return !sameFiles(this.files, this.good);
  }

  /**
   * Whether the person changed this app before it became someone else's
   * (it was since opened from the directory or by a link): those changes are
   * kept, and are not what is running. `bringEarlier` brings them into a copy.
   */
  earlier(): boolean {
    return this.stranded !== null;
  }

  /** Whether another tab has changed the app since this editor last read or kept its changes: the person chooses (`takeTheirs`, `keepMine`). */
  changedElsewhere(): boolean {
    return this.theirs !== null;
  }

  /** The app's files for the editor's list: pages, logic, styles, data, what the app is, other text, then pictures by name. */
  entries(): FileEntry[] {
    const entries: FileEntry[] = [];
    for (const [path, text] of this.files) {
      entries.push({ path, kind: kindOf(path, true), text: true, changed: this.base.get(path) !== text, held: this.good.get(path) !== text });
    }
    for (const path of this.binaries) entries.push({ path, kind: 'picture', text: false, changed: false, held: false });
    return entries.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.path.localeCompare(b.path));
  }

  /** The app's main page, as its manifest names it. */
  mainPage(): string | null {
    try {
      return readManifest(this.files).main;
    } catch {
      try {
        return readManifest(this.good).main;
      } catch {
        return null;
      }
    }
  }

  /** The files that are running: the last version that worked. */
  running(): ReadonlyMap<string, string> {
    return this.good;
  }

  /** Whether a file is one the person added: the app as it was opened has none of that name. */
  added(path: string): boolean {
    return !this.base.has(path);
  }

  /** Whether a file is shown and not edited here, for its size. */
  tooLarge(path: string): boolean {
    return (this.files.get(path)?.length ?? 0) > LARGEST_EDITED;
  }

  // ── Changing text ──────────────────────────────────────────────

  private history(path: string): History {
    let history = this.histories.get(path);
    if (!history) this.histories.set(path, (history = { past: [], future: [], typedAt: 0 }));
    return history;
  }

  private write(path: string, text: string, typed: boolean): boolean {
    const before = this.files.get(path);
    if (before === undefined || before === text) return false;
    const history = this.history(path);
    const at = this.now();
    // A run of typing is one step back; anything else is a step of its own.
    if (!typed || history.past.length === 0 || at - history.typedAt > 700) {
      history.past.push(before);
      trimSteps(history.past);
    }
    history.typedAt = typed ? at : 0;
    history.future.length = 0;
    this.files.set(path, text);
    return true;
  }

  /** The person typed: the app is handed the change after a short pause. */
  type(path: string, text: string): void {
    if (!this.write(path, text, true)) return;
    this.changed();
    this.schedule(this.pause);
  }

  /** A change made for the person in one piece (an element's words, an attribute): handed over at once. */
  change(path: string, text: string): void {
    if (!this.write(path, text, false)) return;
    this.changed();
    this.schedule(0);
  }

  canUndo(path: string): boolean {
    return (this.histories.get(path)?.past.length ?? 0) > 0;
  }

  canRedo(path: string): boolean {
    return (this.histories.get(path)?.future.length ?? 0) > 0;
  }

  private step(path: string, from: 'past' | 'future'): boolean {
    const history = this.histories.get(path);
    const current = this.files.get(path);
    const text = history?.[from].pop();
    if (!history || current === undefined || text === undefined) return false;
    const other = history[from === 'past' ? 'future' : 'past'];
    other.push(current);
    trimSteps(other);
    history.typedAt = 0;
    this.files.set(path, text);
    this.changed();
    this.schedule(this.pause);
    return true;
  }

  undo(path: string): boolean {
    return this.step(path, 'past');
  }

  redo(path: string): boolean {
    return this.step(path, 'future');
  }

  /** Add a text file. Answers what is wrong with the name, or null when it was added. */
  add(path: string, text = ''): string | null {
    const name = path.trim().replace(/\\/g, '/');
    if (!/^[A-Za-z0-9_][A-Za-z0-9_. -]*(?:\/[A-Za-z0-9_][A-Za-z0-9_. -]*)*$/.test(name) || name.split('/').some((part) => part.endsWith('.'))) {
      return 'Name it with letters, digits, dashes and dots, folders divided by /.';
    }
    // What a bundle's reader will not carry is refused here, by the reader's
    // own rule: `..` anywhere in a name. A file under such a name would run
    // today and be missing from what is downloaded, copied or published.
    if (isUnsafeEntryName(name)) return 'A name cannot have two dots together. A file named so is left out when the app is next opened.';
    if (this.files.has(name) || this.binaries.includes(name)) return `The app already has ${name}.`;
    const sort = classifyAsset(name);
    if (sort.binary) {
      // An ending the runtime does not know (.csv, .mjs, .ts, .htm) is text
      // to the person who wrote it, and bytes to the runtime.
      return sort.kind === 'binary'
        ? 'A file with that ending is carried as it is and not read as text, so it cannot be written here. Add it in Studio or the Builder.'
        : 'That is a picture, a sound or another file that is not text. Add it in Studio or the Builder.';
    }
    if (kindOf(name, true) === 'other') return 'Give it an ending the app reads: .ui, .html, .logic, .js, .css or .json.';
    this.files.set(name, text);
    this.changed();
    this.schedule(0);
    return null;
  }

  /** Take a text file out of the app. */
  remove(path: string): void {
    if (!this.files.delete(path)) return;
    this.histories.delete(path);
    this.changed();
    this.schedule(0);
  }

  // ── Handing changes to the app ─────────────────────────────────

  private schedule(delay: number): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Hand the app what is typed now, after whatever is already being handed over. Resolves when it has been dealt with. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = this.chain.then(() => this.apply());
    this.chain = run.catch((problem) => {
      console.error('[SoftN Web] The editor could not hand over a change:', problem);
      this.say({ kind: 'held', text: `Not shown yet: ${sentence(said(problem))}` });
    });
    return this.chain;
  }

  private elsewhere(staying = false): EditStatus {
    const text =
      this.undecided.size > 0
        ? `Another tab changed ${[...this.undecided].sort().join(', ')} as you did, and the editor was put away before you chose. What you typed is shown. Take those changes, or keep yours.`
        : staying
          ? CHANGED_IN_ANOTHER_TAB.replace('Take those changes, or keep yours.', 'The editor stays open until you choose: take those changes, or keep yours.')
          : CHANGED_IN_ANOTHER_TAB;
    return { kind: 'held', text, choose: 'tabs' };
  }

  /**
   * The person asked to put the editor away with the question unanswered.
   * It is said again, with what is waiting on it, and answers true: there
   * is something to choose first. False when nothing is waiting.
   */
  remind(): boolean {
    if (!this.theirs) return false;
    this.status = this.elsewhere(true);
    this.changed();
    return true;
  }

  private async apply(): Promise<void> {
    let tab = this.tab();
    if (this.closed || !tab || !tab.source) return;
    // Nothing is handed over, and nothing kept over the other tab's, until
    // the person has chosen. What is typed meanwhile is set beside theirs as
    // it is typed (not when the page goes, which may be too late to write),
    // and the question is said again each time, so it is never a silence.
    if (this.theirs) {
      await this.setAside();
      this.say(this.elsewhere());
      return;
    }
    if (sameFiles(this.files, this.good)) {
      if ((await this.keep()) === 'elsewhere') {
        await this.setAside();
        this.say(this.elsewhere());
      } else if (this.status.kind === 'held') {
        this.say({ kind: 'ok', text: 'Updated.' });
      }
      return;
    }
    let copy: { name: string; asks: boolean } | null = null;
    if (tab.mine === false) {
      copy = await this.makeCopy(tab);
      if (copy === null) return;
      tab = this.tab();
      if (!tab) return;
    } else if ((await this.keep()) === 'elsewhere') {
      // Kept before the app is handed it: what was typed outlives a page
      // closed while the app is still answering. Not kept over another
      // tab's: set beside it, as typed text, until the person has chosen.
      await this.setAside();
      this.say(this.elsewhere());
      return;
    }
    const next = new Map(this.files);
    const status = await this.hand(tab, next);
    if (this.closed) return;
    if (copy === null) {
      this.say(status);
      return;
    }
    // The copy started as it took the change: that it started is not news beside what it is.
    const made = `This makes your own copy, “${copy.name}”, in your library.`;
    const asked = copy.asks ? ' It asks before it uses what the app was allowed: your copy syncs as itself, not as the app it was made from.' : '';
    this.say(status.kind === 'ok' ? { kind: 'ok', text: `${made} It is running as your copy, with your change.${asked}` } : { ...status, text: `${made} ${status.text}` });
  }

  /** Hand `next` to the running app, and say what became of it. */
  private async hand(tab: OpenTab, next: Map<string, string>): Promise<EditStatus> {
    const held = async (problem: string): Promise<EditStatus> => {
      if ((await this.keep()) === 'elsewhere') return this.elsewhere();
      return { kind: 'held', text: `Not shown yet: ${sentence(problem)}`, ...placeOf(problem) };
    };

    // A manifest the next open would refuse is not handed over: the running
    // app takes a name of any length, and the app would then never open with
    // the person's changes again.
    const manifest = next.get('manifest.json');
    if (manifest !== tab.textFiles?.get('manifest.json')) {
      try {
        const read = readManifest(next) as { name?: unknown };
        if (typeof read.name === 'string' && read.name.length > 255) {
          const at = (manifest ?? '').search(/"name"\s*:/);
          const line = at < 0 ? 1 : (manifest ?? '').slice(0, at).split('\n').length;
          return held(`manifest.json, line ${line}: the name is longer than the 255 characters an app’s name may have`);
        }
      } catch (problem) {
        return held(said(problem));
      }
    }

    const plan = planOpenAppUpdate(tab, next);
    if ('problem' in plan) return held(plan.problem);
    if ('reopen' in plan) return this.reopenWith(next, plan.reopen, held);
    if (Boolean(plan.fields.python) !== Boolean(tab.python)) {
      plan.resolver.dispose();
      return this.reopenWith(next, 'Its logic is in another language, so it has to be opened again.', held);
    }

    let result: OpenAppUpdate;
    if (tab.shownPage) {
      // Another page of the app is on screen, drawn from the tab's files:
      // the tab is handed them, and the page says what became of them.
      try {
        const page = composePage(next, tab.shownPage);
        // A page that cannot be read is not put on the tab at all: the tab's
        // files are what the bar's Download writes and what a link opens.
        if (page.parseProblem) throw new Error(page.parseProblem);
      } catch (problem) {
        plan.resolver.dispose();
        return held(said(problem));
      }
      // The page answers a change to what it is drawn from, or to what its
      // logic imports, and says nothing of any other: a data file it never
      // reads, another page. Where nothing it could answer for has changed,
      // the tab is handed the files and no answer is waited for (it was: three
      // seconds, each time, for an answer that was never coming).
      const answers = this.pageAnswers(tab, next, tab.shownPage);
      const answer = new Promise<AppUpdateResult | null>((resolve) => {
        if (!answers) {
          resolve(null);
          return;
        }
        this.heard = resolve;
        setTimeout(() => resolve(null), 3000);
      });
      const before: RevisedTabFields = {
        source: tab.source,
        logicBasePath: tab.logicBasePath,
        preIncludedLogicPaths: tab.preIncludedLogicPaths,
        python: tab.python,
        parseProblem: tab.parseProblem,
        textFiles: tab.textFiles,
        importResolver: tab.importResolver,
      };
      this.host.patch(this.tabId, plan.fields);
      result = (await answer) ?? { outcome: 'updated', changed: [] };
      this.heard = null;
      if (result.outcome === 'kept') {
        // Refused: the tab goes back to the files of the version still showing.
        if (this.tab()?.source) this.host.patch(this.tabId, before);
        plan.resolver.dispose();
      } else if (before.importResolver !== plan.resolver) {
        before.importResolver?.dispose();
      }
    } else {
      plan.resolver.dispose();
      result = await updateOpenApp(tab, next, (fields) => this.host.patch(this.tabId, fields));
    }

    if (result.outcome === 'reopen') return this.reopenWith(next, result.reason, held);
    if (result.outcome === 'kept') return held(result.problem ?? 'The change has a problem.');
    this.good = next;
    // Showing, and kept beside the app; where the browser will not keep it, the person is told it is showing only.
    const kept = await this.keep();
    if (kept === 'elsewhere') return this.elsewhere();
    await this.followName();
    const unkept = kept === 'kept' ? '' : ' It could not be saved in this browser, so it lasts until this page is closed.';
    if (result.outcome === 'restarted') {
      // The reason says what became of its variables, where it was started for its logic.
      return { kind: 'ok', text: (result.reason ? `Started again: ${sentence(result.reason)}` : 'Started again.') + unkept };
    }
    return { kind: 'ok', text: `Updated.${unkept}` };
  }

  /**
   * Whether the page a link put on screen has anything to say about `next`:
   * its composed text differs from what it is showing, or a file its logic
   * could import has changed. Anything that cannot be told is taken as yes.
   */
  private pageAnswers(tab: OpenTab, next: ReadonlyMap<string, string>, page: string): boolean {
    const had = tab.textFiles;
    if (!had) return true;
    try {
      const was = composePage(had, page);
      const now = composePage(next, page);
      if (was.source !== now.source || was.parseProblem !== now.parseProblem || was.logicBasePath !== now.logicBasePath) return true;
    } catch {
      return true;
    }
    for (const path of new Set([...had.keys(), ...next.keys()])) {
      if (IMPORTED.test(path) && had.get(path) !== next.get(path)) return true;
    }
    return false;
  }

  /**
   * The app is called what its manifest calls it, in every place the runtime
   * names it: its tab, the person's library and its address. A name changed
   * in the editor that reached the tab alone left an app that a reload could
   * not find, or that a reload opened another app in place of.
   */
  private async followName(): Promise<void> {
    const tab = this.tab();
    if (!tab?.appId || !tab.source || tab.mine === false) return;
    const name = nameOf(this.good.get('manifest.json'));
    if (name === null || name === tab.name) return;
    // Its address is written with its bundle's own name, always: never with
    // a name typed here, which another app may have, now or later.
    const own = await this.store.renameApp(tab.appId, name);
    const now = this.tab();
    if (!now?.source || now.appId !== tab.appId) return;
    this.host.patch(this.tabId, { name, addressName: own, ...(now.consent ? { consent: { ...now.consent, appName: name } } : {}) });
    this.host.libraryChanged();
  }

  /**
   * A change the running app cannot take where it stands. It is checked
   * first, so an app is never closed for a change it cannot open with; then
   * kept, and the app opened afresh from the library with it laid over.
   */
  private async reopenWith(next: Map<string, string>, reason: string, held: (problem: string) => Promise<EditStatus>): Promise<EditStatus> {
    try {
      processBundle(next, readManifest(next) as never);
    } catch (problem) {
      return held(said(problem));
    }
    const origin = this.tab()?.appId;
    if (!origin) return held('The app is no longer open.');
    const asksChanged = asks(next) !== asks(this.good);
    const before = this.good;
    this.good = next;
    const kept = await this.keep();
    if (kept !== 'kept') {
      this.good = before;
      return kept === 'elsewhere' ? this.elsewhere() : held('Your changes could not be saved in this browser, and the app has to be opened again from them.');
    }
    // What it was allowed is forgotten. It asks again; nothing is allowed
    // from here. (An answer left behind would not cover it either: an answer
    // is kept with what it answered, and holds for that alone.)
    if (asksChanged) await this.store.forgetGrant(origin);
    this.say({ kind: 'busy', text: 'Opening it again…' });
    const opened = await this.host.reopen(this.tabId);
    const now = this.tab();
    if (!opened || !now?.source || !now.textFiles) return { kind: 'held', text: 'The app did not open again. Your changes are kept: open it from your library.' };
    const running = new Map(now.textFiles);
    if (!sameFiles(running, next)) {
      // It opened as it was: with the change laid over it, it does not open.
      this.good = running;
      await this.keep();
      return { kind: 'held', text: 'Not shown yet: the app does not open with this change, so it is running as it was.' };
    }
    const asked = asksChanged && now.consent ? ' It asks before it uses what it now asks for.' : '';
    return { kind: 'ok', text: `Opened again: ${sentence(reason)}${asked}` };
  }

  /**
   * Keep the person's changes beside the app: `kept`; `refused` when the
   * browser would not; `elsewhere` when another tab has kept its own since
   * this one last looked, in which case nothing is written and the person
   * chooses.
   */
  private keep(): Promise<'kept' | 'refused' | 'elsewhere'> {
    // One after another: two of this editor's writes are never on their way
    // at once, and each reads what the one before it left (`seenAt`).
    const run = this.keeping.then(() => this.keepNow());
    this.keeping = run.catch(() => {});
    return run;
  }

  private async keepNow(): Promise<'kept' | 'refused' | 'elsewhere'> {
    const tab = this.tab();
    if (!tab?.appId || tab.mine === false) return 'kept';
    // A newer editor is open on this tab: the keeping is its own now.
    if (newest.get(this.host)?.get(this.tabId) !== this) return 'kept';
    if (this.theirs) return 'elsewhere';
    const runs = difference(this.base, this.good);
    const typed: Record<string, string | null> = {};
    for (const [path, text] of this.files) if (this.good.get(path) !== text) typed[path] = text;
    for (const path of this.good.keys()) if (!this.files.has(path)) typed[path] = null;
    const draft: Omit<EditDraft, 'at'> = {
      origin: tab.appId,
      files: runs.files,
      removed: runs.removed,
      ...(Object.keys(typed).length > 0 ? { typed } : {}),
      by: this.writer,
    };
    const shows = new Map(this.files);
    // A write that lands is an answer: what this editor had set aside while
    // a question waited, and what it was offered of a page that is gone, are
    // done with.
    const wrote = await this.store.writeDraft(draft, this.seenAt, this.adopted === null ? [this.writer] : [this.writer, this.adopted]);
    if (!wrote.kept) {
      if (!wrote.newer) return 'refused';
      this.theirs = wrote.newer;
      return 'elsewhere';
    }
    this.adopted = null;
    this.seenAt = wrote.at;
    this.seen = shows;
    const edited = changesWhatRuns(draft);
    if (Boolean(tab.edited) !== edited && this.tab()?.source) this.host.patch(this.tabId, { edited });
    return 'kept';
  }

  /**
   * Keep what is typed now, without waiting for the pause: the page is being
   * hidden or closed. Where another tab's changes wait on a choice that
   * cannot be asked for now, what was typed here is set beside them.
   */
  async save(): Promise<void> {
    if (this.closed) return;
    if ((await this.keep()) !== 'elsewhere') return;
    await this.setAside();
    if (this.status.choose !== 'tabs') this.say(this.elsewhere());
  }

  /**
   * The question between this tab's changes and another's is unanswered.
   * What is typed here meanwhile is kept, so that it is never in memory
   * alone: under this editor's own name, apart from the draft (./drafts,
   * `setAside`). The draft is the other tab's still, untouched: its files,
   * its typed text, its time and its writer. So the other tab is told
   * nothing by this, and is asked nothing, until the person has answered
   * here and this tab has really written. For a file both changed, their
   * text is noted too, and the question is asked again if the editor is
   * next opened without an answer having been given.
   */
  private setAside(): Promise<void> {
    const run = this.keeping.then(async () => {
      const tab = this.tab();
      if (!this.theirs || !tab?.appId || tab.mine === false) return;
      if (newest.get(this.host)?.get(this.tabId) !== this) return;
      const their = shownBy(this.base, this.theirs);
      const typed: Record<string, string | null> = {};
      const theirs: Record<string, string | null> = {};
      for (const path of new Set([...this.files.keys(), ...this.seen.keys(), ...their.keys()])) {
        const was = this.seen.get(path);
        const mine = this.files.get(path);
        const other = their.get(path);
        const undecided = this.undecided.has(path);
        // Not changed here since this editor last read or wrote the draft: nothing of this tab's to keep.
        if (mine === was && !undecided) continue;
        typed[path] = mine ?? null;
        if (undecided || (other !== was && other !== mine)) theirs[path] = other ?? null;
      }
      await this.store.setAside(tab.appId, this.writer, Object.keys(typed).length > 0 ? { typed, ...(Object.keys(theirs).length > 0 ? { theirs } : {}) } : null);
    });
    this.keeping = run.catch(() => {});
    return run.catch(() => {});
  }

  /**
   * Someone else's app, changed for the first time: a copy is saved in the
   * person's library under a name of its own, and the tab becomes the copy.
   * It starts again as the copy, on the copy's own saved data, and is ready
   * for the change before this resolves with the copy's name. Null when no
   * copy could be made; nothing is changed then.
   */
  private async makeCopy(tab: OpenTab): Promise<{ name: string; asks: boolean } | null> {
    this.say({ kind: 'busy', text: 'Making your own copy…' });
    const origin = tab.appId;
    const bundle = tab.bundleData;
    const manifestText = this.base.get('manifest.json');
    if (!origin || !bundle || manifestText === undefined) return this.refuseCopy();
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestText) as Record<string, unknown>;
    } catch {
      return this.refuseCopy();
    }
    const taken = new Set(await this.store.libraryNames());
    let name = copyName(tab.name, 1);
    for (let n = 2; taken.has(name); n++) name = copyName(tab.name, n);
    // A copy is an app of its own whatever it is called, and however alike
    // two copies are: each is given a mark no other has, in its manifest, so
    // that its bytes, and with them its identity, are its own. Without one,
    // a second copy of an app made under the same name was the first copy.
    const mark = freshId();
    const renamed = withManifestName(manifestText, name, mark) ?? JSON.stringify({ ...manifest, name, copy: mark }, null, 2);
    const base = new Map(this.base).set('manifest.json', renamed);
    let bytes: Uint8Array;
    try {
      if (this.damaged.length > 0) throw damagedFile(this.damaged[0]);
      bytes = await bundleWith(bundle, base);
    } catch (problem) {
      // A file of the app that cannot be read: said as it is, and nothing is changed.
      this.say({ kind: 'held', text: sentence(said(problem)) });
      return null;
    }
    const declared = extractPermissions(base, manifest as never) ?? { permissions: {} };
    const requested = requestedCapabilities(declared);
    // What the app was allowed, the copy is allowed. Except sync, which
    // reaches other people and a server: the copy is not the app those know,
    // so it is opened as any app is, and asks.
    const allowed = !tab.consent;
    const asks = allowed && requested.includes('sync');
    const copy = await this.store.saveCopy({
      bytes,
      name,
      version: typeof manifest.version === 'string' ? manifest.version : '',
      description: typeof manifest.description === 'string' ? manifest.description : undefined,
      icon: tab.icon,
      requested,
      allowed: allowed && !asks,
      declaration: declarationKey(declared),
      from: origin,
    });
    if (copy === null) return this.refuseCopy();

    // The manifest's new name is the only thing the copy says differently.
    // What the person typed in that file keeps their words otherwise, and a
    // name they gave it themselves is theirs. The steps back are the copy's
    // too: undoing a first change to its manifest does not bring the name of
    // the app it was made from back.
    const was = manifest.name;
    const rename = (text: string): string => {
      if (text === manifestText) return renamed;
      let typed: unknown;
      try {
        typed = (JSON.parse(text) as { name?: unknown } | null)?.name;
      } catch {
        return text; // Not JSON as typed: it is held as a problem like any other.
      }
      return withManifestName(text, typeof typed === 'string' && typed !== was ? typed : name, mark) ?? text;
    };
    const renameIn = (files: Map<string, string>): void => {
      const text = files.get('manifest.json');
      if (text !== undefined) files.set('manifest.json', rename(text));
    };
    this.base = base;
    renameIn(this.good);
    renameIn(this.files);
    const steps = this.histories.get('manifest.json');
    if (steps) {
      steps.past = steps.past.map(rename);
      steps.future = steps.future.map(rename);
    }
    this.seenAt = 0;
    this.seen = new Map(this.good);

    // A new run under a new identity: its own records, its own answers, and
    // none of the published app's address, page or server storage.
    const identity = { appId: copy, bundleData: bytes, name, addressName: undefined, directorySlug: undefined, bundleUrl: undefined, mine: true, edited: false, shownPage: undefined };
    this.copied = name;
    let live: LiveApp | undefined;
    if (asks) {
      // Emptied first, so the copy does not run for a moment on what the app
      // it was made from was allowed; then opened from the library, where
      // nothing is allowed it yet and the runtime's bar asks.
      this.host.patch(this.tabId, { ...identity, source: '' });
      this.host.libraryChanged();
      await this.keep();
      const opened = await this.host.reopen(this.tabId);
      live = this.tab()?.live;
      if (!opened || !this.tab()?.source || !live) {
        this.say({ kind: 'held', text: `Your own copy, “${name}”, is in your library, and it did not open here. Open it from Home.` });
        return null;
      }
    } else {
      live = this.makeLive();
      this.host.patch(this.tabId, {
        ...identity,
        live,
        textFiles: new Map(this.good),
        ...(tab.consent ? { consent: { ...tab.consent, appName: name } } : {}),
      });
      this.host.libraryChanged();
      // What was typed is the copy's from here, and is kept beside it before the copy is up.
      await this.keep();
    }
    // The copy is handed the change once it is up.
    for (let waited = 0; waited < 20_000 && live.shown === null && !this.closed && this.tab(); waited += 25) await wait(25);
    return { name, asks };
  }

  private refuseCopy(): null {
    this.say({ kind: 'held', text: 'Your own copy could not be saved in this browser, so nothing was changed.' });
    return null;
  }

  // ── What the person asks for by name ───────────────────────────

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Put `text` in a file, or take the file out (null), as a step the person can take back. */
  private put(path: string, text: string | null): void {
    if (text === null) {
      if (this.files.delete(path)) this.histories.delete(path);
    } else if (this.files.has(path)) {
      this.write(path, text, false);
    } else {
      this.files.set(path, text);
    }
  }

  /**
   * The other tab's changes, and this one's, as one set of files. A file
   * only one of the two changed since this editor last looked keeps that
   * change. A file both changed is `prefer`'s.
   */
  private async settle(prefer: 'theirs' | 'mine'): Promise<void> {
    if (!this.theirs) return;
    this.stopTimer();
    await this.chain;
    await this.keeping;
    // Their newest, read now: what was handed back when the question was
    // raised may be older than what is kept by the time it is answered (the
    // other tab went on), and an answer given to the older one would be met
    // by the same question again.
    const tab = this.tab();
    const stored = tab?.appId && tab.mine !== false ? await this.store.readDraft(tab.appId) : null;
    if (this.theirs && stored && stored.by !== this.writer && stored.at > this.theirs.at) this.theirs = stored;
    const theirs = this.theirs;
    if (!theirs) return;
    const their = shownBy(this.base, theirs);
    for (const path of new Set([...their.keys(), ...this.files.keys(), ...this.seen.keys()])) {
      const was = this.seen.get(path);
      const mine = this.files.get(path);
      const other = their.get(path);
      // A file left undecided when the editor was last put away was changed by both, whatever is known of how it was before.
      const mineChanged = this.undecided.has(path) || mine !== was;
      const theirsChanged = this.undecided.has(path) || other !== was;
      const take = mineChanged && theirsChanged ? (prefer === 'mine' ? mine : other) : mineChanged ? mine : other;
      this.put(path, take ?? null);
    }
    // Read, and so known: the next write is over these, not blind to them.
    this.undecided.clear();
    this.theirs = null;
    this.seenAt = theirs.at;
    this.seen = their;
    this.say({ kind: 'busy', text: prefer === 'theirs' ? 'Taking those changes…' : 'Keeping yours…' });
    await this.flush();
    if (this.status.kind === 'busy') this.say({ kind: 'ok', text: 'Updated.' });
  }

  /** The other tab's changes stand where both changed a file. This tab's stay in the files that tab did not change. */
  takeTheirs(): Promise<void> {
    return this.settle('theirs');
  }

  /** This tab's changes stand where both changed a file. The other tab's stay in the files this one did not change. */
  keepMine(): Promise<void> {
    return this.settle('mine');
  }

  /**
   * Bring the changes the person made to this app, when it was theirs alone,
   * into a copy of it: they are put in the editor as if typed, which makes
   * the copy (or goes into the copy this editor already made). The app
   * itself, which is someone else's now, is not changed.
   */
  async bringEarlier(): Promise<void> {
    const draft = this.stranded;
    if (!draft) return;
    this.stopTimer();
    await this.chain;
    // In a copy already made, the manifest keeps the copy's name, not the one the app had.
    const own = nameOf(this.base.get('manifest.json'));
    const fit = (path: string, text: string): string =>
      path === 'manifest.json' && own !== null && own !== this.strandedName && nameOf(text) === this.strandedName ? (withManifestName(text, own) ?? text) : text;
    for (const path of draft.removed) this.put(path, null);
    for (const [path, text] of Object.entries(draft.files)) this.put(path, fit(path, text));
    for (const [path, text] of Object.entries(draft.typed ?? {})) this.put(path, text === null ? null : fit(path, text));
    this.changed();
    await this.flush();
    // In the copy now, showing or held as typed. Or they were what the app
    // already is. Either way the ones kept beside the app are done with.
    if (this.tab()?.mine !== false || sameFiles(this.files, this.good)) {
      await this.store.dropDraft(draft.origin);
      this.stranded = null;
      this.changed();
    }
  }

  /** Start the app again from nothing, with the version it has. */
  async restart(): Promise<void> {
    if (this.timer !== null) await this.flush();
    await this.chain;
    const tab = this.tab();
    if (!tab?.source) return;
    this.say({ kind: 'busy', text: 'Starting it again…' });
    if (tab.shownPage || !tab.live) {
      const opened = await this.host.reopen(this.tabId);
      this.say(opened ? { kind: 'ok', text: 'Started again, clean.' } : { kind: 'held', text: 'The app did not start again.' });
      return;
    }
    const result = await tab.live.restart();
    this.say(result.outcome === 'kept' ? { kind: 'held', text: `It did not start again: ${sentence(result.problem ?? 'it has a problem')}` } : { kind: 'ok', text: 'Started again, clean.' });
  }

  /** Back to how the app was opened: every change is dropped, shown or not, in this tab and any other. */
  async discard(): Promise<void> {
    this.stopTimer();
    await this.chain;
    this.files.clear();
    for (const [path, text] of this.base) this.files.set(path, text);
    this.histories.clear();
    this.changed();
    const run = this.chain.then(async () => {
      const tab = this.tab();
      if (!tab?.source) return;
      // Asked for by name, after asking: what another tab kept goes with the
      // rest. It is read first, so the app is not left waiting on a choice
      // between two sets of changes that are both being dropped.
      this.theirs = null;
      this.undecided.clear();
      if (tab.appId && tab.mine !== false) this.seenAt = Math.max(this.seenAt, (await this.store.readDraft(tab.appId))?.at ?? 0);
      const dropped = async (): Promise<void> => {
        const origin = this.tab()?.appId;
        if (!origin || this.tab()?.mine === false) return;
        await this.store.dropDraft(origin);
        this.adopted = null;
        this.theirs = null;
        this.seenAt = 0;
        this.seen = new Map(this.base);
        if (this.tab()?.edited) this.host.patch(this.tabId, { edited: false });
      };
      if (sameFiles(this.base, this.good)) {
        await dropped();
        this.say({ kind: 'ok', text: 'Your changes are discarded. This is the app as you opened it.' });
        return;
      }
      const status = await this.hand(tab, new Map(this.base));
      if (status.kind === 'ok') await dropped();
      this.say(status.kind === 'ok' ? { kind: 'ok', text: 'Your changes are discarded. This is the app as you opened it.' } : status);
    });
    this.chain = run.catch(() => {});
    await this.chain;
  }

  /**
   * The app as a bundle with the person's changes in it: the version that is
   * running. Rejects with a sentence when a file of the app cannot be read.
   */
  async bundle(): Promise<Uint8Array | null> {
    const bytes = this.tab()?.bundleData;
    if (!bytes) return null;
    if (this.damaged.length > 0) throw damagedFile(this.damaged[0]);
    return bundleWith(bytes, this.good);
  }

  /** Everything handed over so far has been dealt with. */
  async settled(): Promise<void> {
    await this.chain;
  }

  /**
   * Put away with another tab's changes still waiting on a choice (the
   * editor itself does not let a person do that: its tab was closed, or
   * something else took it down). Nothing typed is dropped: it is set beside
   * the other tab's changes as typed text, and this tab's app is handed it,
   * as closing always leaves the app as edited.
   */
  private leaveUnanswered(): Promise<void> {
    this.stopTimer();
    const run = this.chain.then(async () => {
      await this.setAside();
      const tab = this.tab();
      if (tab?.source && tab.mine !== false && !sameFiles(this.files, this.good)) await this.hand(tab, new Map(this.files));
    });
    this.chain = run.catch(() => {});
    return this.chain;
  }

  /**
   * The editor is put away. What was typed and not handed over yet is handed
   * over first: closing leaves the app as edited. It does not wait for an
   * answer that cannot come: an app whose tab is closed answers nothing, and
   * one that is slow to answer is given a few seconds.
   */
  async close(): Promise<void> {
    this.listeners.clear();
    if (this.tab()?.source) {
      const done = this.theirs ? this.leaveUnanswered() : this.timer !== null ? this.flush() : this.chain;
      let gaveUp: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          gaveUp = setTimeout(resolve, this.closeWait);
        }),
      ]);
      clearTimeout(gaveUp);
    } else {
      this.stopTimer();
    }
    this.closed = true;
    this.heard = null;
    this.stopHearing();
  }
}
