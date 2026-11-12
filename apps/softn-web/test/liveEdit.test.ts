/**
 * @vitest-environment jsdom
 *
 * An app edited while it runs (src/edit/): whose app it is, where a change is
 * kept, and what the app is allowed afterwards.
 *
 * The real library, the editor's real store and the real open of a bundle
 * run here over an in-memory IndexedDB. The one stand-in is the running app
 * itself (core's LiveApp, which a renderer answers for): it answers as the
 * renderer does for the cases these tests are about, a page that does not
 * parse being kept out, and logic that changed being started again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { openBundleArchive, type AppRevision, type AppUpdateResult, type LiveApp } from '@softn/core';
import { readZip } from '@softn/runtime-shell/bundleProcessor';
import { declarationKey } from '@softn/runtime-shell/consent';

vi.mock('idb', () => import('./helpers/fakeIdb'));

import { resetFakeIdb } from './helpers/fakeIdb';
import { computeAppOrigin, getCachedAppByAddress, getCachedAppByOrigin, getCachedApps, recordPermissionGrant, resetAppCacheAvailability } from '../src/lib/appCache';
import { getDB } from '../src/lib/appCacheDb';
import { tabAddress } from '../src/lib/appUrl';
import { forgetEdits, hasDraft } from '../src/lib/editIndex';
import { openBundle, type OpenBundleHost, type OpenBundleRequest, type OpenTab } from '../src/lib/openBundle';
import { reopenTab } from '../src/lib/reopenTab';
import { readDraft, readKept, resetDraftStore, setAside, writeDraft, type DraftWrite } from '../src/edit/drafts';
import type { EditHost } from '../src/edit/host';
import { EditSession, libraryStore, type EditStore } from '../src/edit/session';

// See openFromUrl.test.ts: fflate needs bytes from its own realm.
const ascii = (text: string) => strToU8(text, true);

const MAIN = '<logic src="../logic/main.logic" />\n<div class="page">\n  <h1 id="title">Notes</h1>\n  <span class="count">{count}</span>\n</div>\n';
const LOGIC = 'let count = 0\nfunction inc() { count = count + 1 }\n';

function bundleOf(files: Record<string, string> = {}, manifest: Record<string, unknown> = {}): Uint8Array {
  const all: Record<string, string> = {
    'manifest.json': JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] }, ...manifest }),
    'ui/main.ui': MAIN,
    'logic/main.logic': LOGIC,
    ...files,
  };
  return zipSync(Object.fromEntries(Object.entries(all).map(([path, text]) => [path, ascii(text)])));
}

const textOf = (bundle: Uint8Array, path: string): string => strFromU8(unzipSync(bundle)[path]);

/** The logic a composed page carries, which is what a renderer starts again for. */
const logicOf = (source: string): string => /<logic>([^]*)<\/logic>\s*$/.exec(source)?.[1] ?? '';

type StandIn = LiveApp & { handed: AppRevision[]; restarts: number; answer(): void };

/**
 * The running app, answering as a renderer does. Or `silent`: never
 * answering, as one whose tab is busy or gone. Or `slow`: answering when the
 * test says (`answer()`), as one that takes its time.
 */
function standInApp(mode: boolean | 'slow' = false, opened?: string): StandIn {
  let shown: AppRevision | null = null;
  const waiting: Array<() => void> = [];
  const answerTo = (revision: AppRevision): AppUpdateResult => {
    if (revision.parseProblem) return { outcome: 'kept', changed: [], problem: revision.parseProblem };
    // Started again for logic that is not the logic it is running: what it was opened with, until it has been handed anything.
    const running = shown?.source ?? opened;
    const restarted = running !== undefined && logicOf(running) !== logicOf(revision.source);
    shown = revision;
    return restarted ? { outcome: 'restarted', changed: ['logic'], reason: 'Its logic changed', carried: true } : { outcome: 'updated', changed: ['page'] };
  };
  const app: StandIn = {
    handed: [] as AppRevision[],
    restarts: 0,
    answer: () => {
      for (const go of waiting.splice(0)) go();
    },
    update: async (revision: AppRevision): Promise<AppUpdateResult> => {
      app.handed.push(revision);
      if (mode === true) return new Promise<AppUpdateResult>(() => {});
      if (mode === 'slow') return new Promise<AppUpdateResult>((resolve) => waiting.push(() => resolve(answerTo(revision))));
      return answerTo(revision);
    },
    restart: async (): Promise<AppUpdateResult> => {
      app.restarts++;
      return { outcome: 'restarted', changed: [], reason: 'It was asked to' };
    },
    get shown() {
      return shown ?? { source: '' };
    },
    get wanted() {
      return shown;
    },
  };
  return app;
}

/**
 * The runtime around an open app, as far as opening and editing ask of it:
 * one browser tab's. Two of them share the library, the editor's store and
 * localStorage, as two tabs of one browser do. `silent`: its apps never
 * answer a change handed to them.
 */
function runtime(options: { silent?: boolean | 'slow' } = {}) {
  let tabs: OpenTab[] = [];
  let active: string | null = null;
  const errors: Error[] = [];
  const notices: string[] = [];
  const set = <T>(update: T | ((before: T) => T), before: T): T => (typeof update === 'function' ? (update as (before: T) => T)(before) : update);
  const opening: OpenBundleHost = {
    tabs: () => tabs,
    activeTabId: () => active,
    setOpenTabs: (update) => {
      tabs = set(update, tabs);
    },
    setActiveTabId: (update) => {
      active = set(update, active);
    },
    setError: (error) => {
      if (error) errors.push(error);
    },
    showOpening: () => {},
    hideOpening: () => {},
    appsChanged: () => {},
    notify: (text) => notices.push(text),
    installOffline: () => {},
  };
  const withApp = (tabId: string): void => {
    tabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, live: standInApp(options.silent, tab.source) } : tab));
  };
  /** Open a bundle as a tab, with the stand-in for its running app. Null when it did not open: why is in `errors`. */
  const tryOpen = async (request: Omit<OpenBundleRequest, 'fileName'>): Promise<OpenTab | null> => {
    const had = new Set(tabs.map((tab) => tab.id));
    const name = await openBundle(opening, { fileName: 'app.softn', ...request });
    if (name === null) return null;
    const opened = tabs.find((tab) => !had.has(tab.id) || tab.id === request.placeholderId)!;
    withApp(opened.id);
    return tabs.find((tab) => tab.id === opened.id)!;
  };
  const open = async (request: Omit<OpenBundleRequest, 'fileName'>): Promise<OpenTab> => {
    const opened = await tryOpen(request);
    expect(errors.map((error) => error.message)).toEqual([]);
    expect(opened).not.toBeNull();
    return opened!;
  };
  const editing: EditHost = {
    tab: (tabId) => tabs.find((tab) => tab.id === tabId),
    patch: (tabId, fields) => {
      tabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, ...fields } : tab));
    },
    // As App.tsx does it, with the code it does it with: the tab stays, empty, and the open fills it from the library.
    reopen: async (tabId) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      const record = tab?.appId ? await getCachedAppByOrigin(tab.appId) : null;
      if (!tab || !record) return false;
      const opened = await reopenTab(opening, tab, record);
      if (opened) withApp(tabId);
      return opened;
    },
    close: () => {},
    guardClose: () => () => {},
    libraryChanged: () => {},
    onAppUpdate: () => () => {},
  };
  const close = (tabId: string): void => {
    tabs = tabs.filter((tab) => tab.id !== tabId);
  };
  return { open, tryOpen, editing, close, tab: (tabId: string) => tabs.find((tab) => tab.id === tabId)!, errors, notices };
}

const edit = (host: EditHost, tabId: string, store?: EditStore) =>
  EditSession.open(host, tabId, { pause: 0, makeLive: standInApp, ...(store ? { store } : {}) }).then((session) => session!);

/** The editor's own store, with a note of what became of each write asked of it. */
function watched(): EditStore & { writes: string[] } {
  const writes: string[] = [];
  return {
    ...libraryStore,
    writes,
    writeDraft: async (draft, seenAt, settles) => {
      const outcome: DraftWrite = await writeDraft(draft, seenAt, settles);
      writes.push(outcome.kept ? 'kept' : outcome.newer ? 'REFUSED: a newer draft is there' : 'refused');
      return outcome;
    },
  };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Type `text` over `find` in a file, and let the app answer. */
async function type(session: EditSession, path: string, find: string, text: string): Promise<void> {
  const before = session.files.get(path)!;
  expect(before, `${path} has ${find}`).toContain(find);
  session.type(path, before.replace(find, text));
  await session.flush();
}

beforeEach(() => {
  resetFakeIdb();
  resetAppCacheAvailability();
  resetDraftStore();
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an app of the person’s own, edited while it runs', () => {
  it('is edited as itself: the change is kept beside it, it keeps its identity, and it opens again as it was left', async () => {
    const app = runtime();
    const data = bundleOf();
    const tab = await app.open({ data });
    expect(tab.mine).toBe(true);
    expect(tab.edited).toBe(false);
    const origin = tab.appId!;

    const session = await edit(app.editing, tab.id);
    expect(session.whose()).toBe('mine');
    await type(session, 'ui/main.ui', '>Notes<', '>My notes<');
    expect(session.status).toEqual({ kind: 'ok', text: 'Updated.' });

    // The running app took it, and the tab holds what it is showing.
    const now = app.tab(tab.id);
    expect(now.appId).toBe(origin);
    expect(now.source).toContain('My notes');
    expect(now.textFiles?.get('ui/main.ui')).toContain('My notes');
    expect(now.edited).toBe(true);
    expect(session.runningChanges()).toBe(true);

    // The saved bundle is the bytes it was: its identity, and so its data and what it was allowed, are its own still.
    const saved = await getCachedAppByOrigin(origin);
    expect(await computeAppOrigin(saved!.bundleData)).toBe(origin);
    expect(textOf(saved!.bundleData, 'ui/main.ui')).toBe(MAIN);
    expect(await getCachedApps()).toHaveLength(1);
    expect(hasDraft(origin)).toBe(true);
    expect((await readDraft(origin))?.files['ui/main.ui']).toContain('My notes');

    // The page reloaded: it opens from the library with the change, as the same app.
    await session.close();
    app.close(tab.id);
    const again = await app.open({ data: saved!.bundleData, cachedAppId: saved!.id });
    expect(again.appId).toBe(origin);
    expect(again.edited).toBe(true);
    expect(again.source).toContain('My notes');
    // And handed back as a file, it is the app with the change in it.
    const reopened = await edit(app.editing, again.id);
    const edited = (await reopened.bundle())!;
    expect(textOf(edited, 'ui/main.ui')).toContain('My notes');
    expect(textOf(edited, 'logic/main.logic')).toBe(LOGIC);
    // A bundle the runtime opens like any other.
    app.close(again.id);
    const fromFile = await app.open({ data: edited });
    expect(fromFile.source).toContain('My notes');
    expect(fromFile.appId).not.toBe(origin);
  });

  it('keeps the last version that worked running when a change does not, and says where the problem is', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Good<');
    const good = app.tab(tab.id).source;

    // An attribute HTML does not have, which the page's parser refuses.
    await type(session, 'ui/main.ui', '<span class="count">', '<span class="count" else>');
    expect(session.status.kind).toBe('held');
    expect(session.status.text).toMatch(/^Not shown yet: ui\/main\.ui, line 4/);
    expect(session.status).toMatchObject({ file: 'ui/main.ui', line: 4 });
    expect(session.holding()).toBe(true);
    // The app is as it was: the tab still holds the version that worked.
    expect(app.tab(tab.id).source).toBe(good);
    expect(app.tab(tab.id).textFiles?.get('ui/main.ui')).not.toContain(' else>');

    // Both are kept: what runs, and what was typed. A reload opens on what runs and shows what was typed.
    const draft = await readDraft(tab.appId!);
    expect(draft?.files['ui/main.ui']).toContain('>Good<');
    expect(draft?.files['ui/main.ui']).not.toContain(' else>');
    expect(draft?.typed?.['ui/main.ui']).toContain(' else>');
    const saved = (await getCachedAppByOrigin(tab.appId!))!;
    await session.close();
    app.close(tab.id);
    const again = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(again.source).toBe(good);
    const reopened = await edit(app.editing, again.id);
    expect(reopened.files.get('ui/main.ui')).toContain(' else>');
    await reopened.flush();
    expect(reopened.status.kind).toBe('held');

    // Mended, it is shown, and nothing is held any more.
    await type(reopened, 'ui/main.ui', ' else>', '>');
    expect(reopened.status).toEqual({ kind: 'ok', text: 'Updated.' });
    expect(reopened.holding()).toBe(false);
    expect((await readDraft(tab.appId!))?.typed).toBeUndefined();
  });

  it('starts the app again for a change to its logic, and says so', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Notes.<');
    await type(session, 'logic/main.logic', 'count + 1', 'count + 2');
    expect(session.status).toEqual({ kind: 'ok', text: 'Started again: Its logic changed.' });
  });

  it('steps back and forward through what was typed, a run of typing at a time', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    let now = 1000;
    const session = (await EditSession.open(app.editing, tab.id, { pause: 0, makeLive: standInApp, now: () => now }))!;
    const typed = (text: string) => session.type('ui/main.ui', MAIN.replace('>Notes<', `>${text}<`));
    typed('N');
    now += 100;
    typed('Ne');
    now += 100;
    typed('New');
    now += 5000;
    typed('New notes');
    expect(session.canUndo('ui/main.ui')).toBe(true);
    session.undo('ui/main.ui');
    expect(session.files.get('ui/main.ui')).toContain('>New<');
    session.undo('ui/main.ui');
    expect(session.files.get('ui/main.ui')).toBe(MAIN);
    expect(session.canUndo('ui/main.ui')).toBe(false);
    session.redo('ui/main.ui');
    session.redo('ui/main.ui');
    expect(session.files.get('ui/main.ui')).toContain('>New notes<');
    await session.flush();
    expect(app.tab(tab.id).source).toContain('New notes');
  });

  it('goes back to how it was opened on "Discard my changes", and keeps nothing of them', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const opened = tab.source;
    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Changed<');
    await type(session, 'ui/main.ui', '<span class="count">', '<span class="count" else>');
    expect(app.tab(tab.id).edited).toBe(true);
    expect(session.holding()).toBe(true);

    await session.discard();
    expect(session.status).toEqual({ kind: 'ok', text: 'Your changes are discarded. This is the app as you opened it.' });
    expect(session.files.get('ui/main.ui')).toBe(MAIN);
    expect(app.tab(tab.id).source).toBe(opened);
    expect(app.tab(tab.id).edited).toBe(false);
    expect(session.runningChanges()).toBe(false);
    expect(await readDraft(tab.appId!)).toBeNull();
    expect(hasDraft(tab.appId!)).toBe(false);
  });

  it('says so when the browser will not keep a change: it is showing, and lasts as long as the page', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const session = (await EditSession.open(app.editing, tab.id, { pause: 0, makeLive: standInApp, store: { ...libraryStore, writeDraft: async () => ({ kept: false }) } }))!;
    await type(session, 'ui/main.ui', '>Notes<', '>Unsaved<');
    expect(session.status).toEqual({ kind: 'ok', text: 'Updated. It could not be saved in this browser, so it lasts until this page is closed.' });
    expect(app.tab(tab.id).source).toContain('Unsaved');
    // A change the app would have to be opened again for is not made on those terms: opened again, it would be gone.
    await type(session, 'manifest.json', '"version":"1.0.0"', '"version":"1.0.0","config":{"execution":"worker"}');
    expect(session.status.kind).toBe('held');
    expect(session.status.text).toMatch(/could not be saved in this browser/);
    expect(app.tab(tab.id).source).toContain('Unsaved');
  });

  it('adds a page the app can go to, and takes one it added out again', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const session = await edit(app.editing, tab.id);
    expect(session.add('../outside.ui')).toMatch(/^Name it/);
    expect(session.add('ui/main.ui')).toBe('The app already has ui/main.ui.');
    expect(session.add('assets/logo.png')).toMatch(/not text/);
    // Text to whoever wrote it, and bytes to the runtime, which does not know the ending: said as that, not as "a picture".
    for (const name of ['data/rows.csv', 'logic/extra.mjs', 'logic/extra.ts', 'ui/old.htm']) {
      expect(session.add(name), name).toMatch(/^A file with that ending is carried as it is and not read as text/);
      expect(session.add(name), name).not.toMatch(/picture/);
    }
    expect(session.add('ui/about.ui', '<div><h1>About</h1></div>\n')).toBeNull();
    await session.flush();
    expect(session.status.kind).toBe('ok');
    expect(app.tab(tab.id).textFiles?.get('ui/about.ui')).toContain('About');
    expect(session.entries().find((entry) => entry.path === 'ui/about.ui')).toMatchObject({ kind: 'page', changed: true });
    expect(session.added('ui/about.ui')).toBe(true);
    expect(session.added('ui/main.ui')).toBe(false);
    session.remove('ui/about.ui');
    await session.flush();
    expect(app.tab(tab.id).textFiles?.has('ui/about.ui')).toBe(false);
    expect(await readDraft(tab.appId!)).toBeNull();
  });
});

describe('someone else’s app, from the directory or a link', () => {
  it('is never changed: the first edit makes a copy in the person’s library, and the tab becomes the copy', async () => {
    const app = runtime();
    const data = bundleOf();
    const tab = await app.open({ data, fromLink: true });
    expect(tab.mine).toBe(false);
    const theirs = tab.appId!;
    localStorage.setItem(`xdb:${theirs}:notes`, '[{"id":"1","text":"mine"}]');
    localStorage.setItem(`softn:${theirs}:theme`, 'dark');

    const session = await edit(app.editing, tab.id);
    expect(session.whose()).toBe('theirs');
    // Looking changes nothing and makes nothing.
    expect(await getCachedApps()).toHaveLength(1);

    await type(session, 'ui/main.ui', '>Notes<', '>My notes<');
    expect(session.status).toEqual({
      kind: 'ok',
      text: 'This makes your own copy, “Notes (my copy)”, in your library. It is running as your copy, with your change.',
    });
    expect(session.whose()).toBe('mine');
    expect(session.copied).toBe('Notes (my copy)');

    // The tab is the copy: another identity, another name, and no tie to the published app's address or page.
    const now = app.tab(tab.id);
    expect(now.appId).not.toBe(theirs);
    expect(now).toMatchObject({ name: 'Notes (my copy)', mine: true, edited: true, directorySlug: undefined, bundleUrl: undefined });
    expect(now.source).toContain('My notes');

    // The app they opened is as it was, in the library and in what it has saved.
    const library = await getCachedApps();
    expect(library.map((saved) => saved.name).sort()).toEqual(['Notes', 'Notes (my copy)']);
    const original = (await getCachedAppByOrigin(theirs))!;
    expect(Array.from(original.bundleData)).toEqual(Array.from(data));
    expect(original.linked).toBe(true);
    expect(hasDraft(theirs)).toBe(false);
    expect(await readDraft(theirs)).toBeNull();
    expect(localStorage.getItem(`xdb:${theirs}:notes`)).toBe('[{"id":"1","text":"mine"}]');

    // The copy is a bundle of its own, named for what it is; the change is kept beside it; the person's records came along.
    const copy = (await getCachedAppByOrigin(now.appId!))!;
    expect(copy.linked).toBeUndefined();
    expect(copy.directorySlug).toBeUndefined();
    expect(JSON.parse(textOf(copy.bundleData, 'manifest.json')).name).toBe('Notes (my copy)');
    expect(textOf(copy.bundleData, 'ui/main.ui')).toBe(MAIN);
    expect((await readDraft(now.appId!))?.files['ui/main.ui']).toContain('My notes');
    expect(localStorage.getItem(`xdb:${now.appId}:notes`)).toBe('[{"id":"1","text":"mine"}]');
    expect(localStorage.getItem(`softn:${now.appId}:theme`)).toBe('dark');

    // Opened by its link again, the app is the app as published, whatever is saved here.
    await session.close();
    app.close(tab.id);
    const published = await app.open({ data, fromLink: true });
    expect(published).toMatchObject({ appId: theirs, mine: false, edited: false });
    expect(published.source).not.toContain('My notes');
    // A second first edit is a second copy, under a name of its own.
    const second = await edit(app.editing, published.id);
    await type(second, 'ui/main.ui', '>Notes<', '>Other<');
    expect(app.tab(published.id).name).toBe('Notes (my copy 2)');
  });

  it('is not changed by a draft kept under its identity: from the directory it opens as published', async () => {
    const app = runtime();
    const data = bundleOf();
    // Theirs first, from a file, and edited.
    const own = await app.open({ data });
    const session = await edit(app.editing, own.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Edited<');
    await session.close();
    app.close(own.id);
    expect(hasDraft(own.appId!)).toBe(true);
    // The same bytes, opened from the directory: the published app.
    const published = await app.open({ data, directorySlug: 'notes' });
    expect(published).toMatchObject({ mine: false, edited: false });
    expect(published.source).not.toContain('Edited');
    app.close(published.id);
    // And from then on it is the directory's, from the library too.
    const saved = (await getCachedAppByOrigin(own.appId!))!;
    const fromLibrary = await app.open({ data: saved.bundleData, cachedAppId: saved.id, directorySlug: saved.directorySlug });
    expect(fromLibrary).toMatchObject({ mine: false, edited: false });
  });

  it('gives its copy what the person allowed it, for the same things and no others', async () => {
    const app = runtime();
    const data = bundleOf({ 'permission.json': JSON.stringify({ permissions: { net: { enabled: true } } }) });
    const first = await app.open({ data, fromLink: true });
    expect(first.consent?.capabilities).toEqual(['net']);
    await recordPermissionGrant(first.appId!, { net: true });
    app.close(first.id);
    const tab = await app.open({ data, fromLink: true });
    expect(tab.consent).toBeUndefined();

    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Mine<');
    const copy = (await getCachedAppByOrigin(app.tab(tab.id).appId!))!;
    expect(copy.grantedPermissions).toEqual({ net: true });

    // What an edit adds is asked for.
    await type(session, 'permission.json', '"net":{"enabled":true}', '"net":{"enabled":true},"camera":{"enabled":true}');
    expect(app.tab(tab.id).consent?.capabilities).toEqual(['net', 'camera']);
  });
});

describe('an edit that changes what the app asks for', () => {
  const ASKS_NET = JSON.stringify({ permissions: { net: { enabled: true } } });

  it('opens the app again and asks the person, by the runtime’s own bar: nothing is allowed by the editor', async () => {
    const app = runtime();
    const data = bundleOf({ 'permission.json': ASKS_NET });
    const first = await app.open({ data });
    expect(first.consent?.capabilities).toEqual(['net']);
    await recordPermissionGrant(first.appId!, { net: true });
    app.close(first.id);
    const tab = await app.open({ data });
    expect(tab.consent).toBeUndefined();
    expect(tab.permissionConfig?.consentPending).not.toBe(true);

    const session = await edit(app.editing, tab.id);
    await type(session, 'permission.json', '"net":{"enabled":true}', '"net":{"enabled":true},"files":{"enabled":true}');
    expect(session.status.kind).toBe('ok');
    expect(session.status.text).toMatch(/^Opened again: What it asks permission for changed.*It asks before it uses what it now asks for\.$/);

    // The same tab, opened afresh as the same app, with the bar up and everything withheld until it is answered.
    const now = app.tab(tab.id);
    expect(now.appId).toBe(tab.appId);
    expect(now.consent?.capabilities).toEqual(['net', 'files']);
    expect(now.permissionConfig?.consentPending).toBe(true);
    // What it was allowed before is forgotten: it was allowed to what it asked then.
    expect((await getCachedAppByOrigin(tab.appId!))?.grantedPermissions).toBeUndefined();
  });

  it('is asked again even if the old answer is still on record: an answer covers what it answered, and an edit does not ride on it', async () => {
    const app = runtime();
    const data = bundleOf({ 'permission.json': ASKS_NET });
    const tab = await app.open({ data });
    const origin = tab.appId!;
    const askedBefore = declarationKey(tab.consent!.config);
    const session = await edit(app.editing, tab.id);
    // The edit asks for the same names, and more of one of them.
    await type(session, 'permission.json', '"net":{"enabled":true}', '"net":{"enabled":true,"allowed_hosts":["example.com"]}');
    await session.close();
    app.close(tab.id);

    // An answer to what it asked before the edit, as one that could not be
    // forgotten would be: on record, and dated now, with the ask it answered.
    const library = await getDB();
    const saved = (await getCachedAppByOrigin(origin))!;
    await library.put('softn-apps', { ...saved, grantedPermissions: { net: true }, permissionsPromptedAt: Date.now() + 60_000, grantedFor: askedBefore });
    const stale = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(stale.edited).toBe(true);
    expect(stale.consent?.capabilities).toEqual(['net']);
    app.close(stale.id);

    // And one from before answers were kept with their ask: it answered the
    // bundle as it was, and holds for that, not for the bundle with changes laid over it.
    await library.put('softn-apps', { ...saved, grantedPermissions: { net: true }, permissionsPromptedAt: Date.now() + 60_000 });
    const older = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(older.edited).toBe(true);
    expect(older.consent?.capabilities).toEqual(['net']);
    app.close(older.id);

    // Answered after the edit, it is remembered like any answer: for what the app asks now.
    older.consent!.onAllow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await getCachedAppByOrigin(origin))?.grantedFor).toBe(declarationKey(older.consent!.config));
    const allowed = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(allowed.consent).toBeUndefined();
  });

  it('does not close the app for a manifest it could not open with', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const session = await edit(app.editing, tab.id);
    const running = app.tab(tab.id);
    await type(session, 'manifest.json', '"main":"ui/main.ui"', '"main":"ui/gone.ui"');
    expect(session.status.kind).toBe('held');
    expect(session.status.text).toMatch(/^Not shown yet: /);
    expect(app.tab(tab.id).source).toBe(running.source);
    expect((await readDraft(tab.appId!))?.files['manifest.json']).toBeUndefined();
    // A name is not what the app runs by: no new open for it.
    await type(session, 'manifest.json', '"main":"ui/gone.ui"', '"main":"ui/main.ui"');
    await type(session, 'manifest.json', '"name":"Notes"', '"name":"Notebook"');
    expect(session.status).toEqual({ kind: 'ok', text: 'Updated.' });
  });

  it('remembers Allow, pressed on a copy, for the copy: the app it was made from is as it was', async () => {
    const app = runtime();
    const data = bundleOf({ 'permission.json': ASKS_NET });
    const tab = await app.open({ data, fromLink: true });
    const theirs = tab.appId!;
    expect(tab.consent?.capabilities).toEqual(['net']);
    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Mine<');
    const now = app.tab(tab.id);
    const copy = now.appId!;
    expect(copy).not.toBe(theirs);
    // The bar is still up, now naming the copy.
    expect(now.consent?.appName).toBe('Notes (my copy)');
    now.consent!.onAllow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect({
      original: (await getCachedAppByOrigin(theirs))?.grantedPermissions ?? null,
      copy: (await getCachedAppByOrigin(copy))?.grantedPermissions ?? null,
    }).toEqual({ original: null, copy: { net: true } });
    // And it is an answer to what the copy asks: the copy opens again without asking.
    await session.close();
    app.close(tab.id);
    const saved = (await getCachedAppByOrigin(copy))!;
    expect((await app.open({ data: saved.bundleData, cachedAppId: saved.id })).consent).toBeUndefined();
  });

  it('reads its imports from the files as edited after Allow, not from the files as it was opened', async () => {
    const app = runtime();
    const data = bundleOf({ 'permission.json': ASKS_NET, 'logic/util.logic': 'export function label() { return "old" }\n' });
    const tab = await app.open({ data });
    expect(tab.consent).toBeDefined();
    const session = await edit(app.editing, tab.id);
    await type(session, 'logic/util.logic', '"old"', '"new"');
    expect(session.status.kind).toBe('ok');
    expect(await app.tab(tab.id).importResolver!('logic/util.logic')).toContain('"new"');
    app.tab(tab.id).consent!.onAllow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(app.tab(tab.id).consent).toBeUndefined();
    expect(await app.tab(tab.id).importResolver!('logic/util.logic')).toContain('"new"');
  });

  const ASKS_HOSTS = (hosts: string[]) => JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: hosts } } });
  const runsWith = (tab: OpenTab) => (tab.permissionConfig?.permissions as { net?: { allowed_hosts?: string[] } } | undefined)?.net?.allowed_hosts ?? 'withheld';

  it('is not covered by an answer given in another tab to what the app asked before the edit', async () => {
    const one = runtime();
    const two = runtime();
    const data = bundleOf({ 'permission.json': ASKS_HOSTS(['api.example.com']) });
    // Tab one: the app is open, its bar asking for the internet as the bundle declares it. Not answered yet.
    const tabOne = await one.open({ data });
    expect(tabOne.consent?.capabilities).toEqual(['net']);
    const origin = tabOne.appId!;
    // Tab two: the same app, edited to ask for more of the same capability.
    const tabTwo = await two.open({ data });
    const session = await edit(two.editing, tabTwo.id);
    await type(session, 'permission.json', '["api.example.com"]', '["*"]');
    expect(session.status.kind).toBe('ok');
    expect(two.tab(tabTwo.id).consent?.capabilities).toEqual(['net']);
    await session.close();
    two.close(tabTwo.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Tab one: the person presses Allow on the bar that is asking for api.example.com.
    one.tab(tabOne.id).consent!.onAllow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    one.close(tabOne.id);
    // Opened again, with the edit laid over it, it asks for every host. The person was not asked that.
    const saved = (await getCachedAppByOrigin(origin))!;
    const again = await one.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(again.edited).toBe(true);
    expect({ runsWith: runsWith(again), asked: again.consent !== undefined }).toEqual({ runsWith: 'withheld', asked: true });
  });

  it('does not let the app as it was ride on an answer given to what an edit asked, when it opens without the edit', async () => {
    const app = runtime();
    const data = bundleOf({ 'permission.json': ASKS_HOSTS(['*']) });
    const tab = await app.open({ data });
    const origin = tab.appId!;
    expect(tab.consent).toBeDefined();
    const session = await edit(app.editing, tab.id);
    // Narrow what it asks, and allow that.
    await type(session, 'permission.json', '["*"]', '["api.example.com"]');
    app.tab(tab.id).consent!.onAllow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A name longer than a manifest may have is not handed to the app: the next open would refuse it.
    const long = `"name":"${'N'.repeat(300)}"`;
    await type(session, 'manifest.json', '"name":"Notes"', long);
    expect(session.status).toMatchObject({ kind: 'held', file: 'manifest.json', line: 1 });
    expect(session.status.text).toMatch(/^Not shown yet: manifest\.json, line 1: the name is longer than the 255 characters/);
    expect(app.tab(tab.id).name).toBe('Notes');
    await session.close();
    app.close(tab.id);

    // Changes the open refuses all the same, as an earlier build's editor could have kept them:
    // they pass the trial they are laid by, and the open then fails on the name.
    const kept = (await readDraft(origin))!;
    expect(kept.files['manifest.json']).toBeUndefined();
    const wrote = await writeDraft({ origin, files: { ...kept.files, 'manifest.json': kept.typed!['manifest.json']! }, removed: [] }, kept.at);
    expect(wrote.kept).toBe(true);

    // The app opens as it was, asking for every host. The answer on record was to one host.
    const saved = (await getCachedAppByOrigin(origin))!;
    const again = await app.tryOpen({ data: saved.bundleData, cachedAppId: saved.id });
    expect(again).not.toBeNull();
    expect({ edited: again!.edited, runsWith: runsWith(again!), asked: again!.consent !== undefined }).toEqual({ edited: false, runsWith: 'withheld', asked: true });
  });
});

describe('an app whose name is changed in the editor', () => {
  const reloadOpens = async (address: string, origin: string): Promise<string> => {
    const found = await getCachedAppByAddress(address);
    return found?.origin === origin ? 'this app' : found ? `ANOTHER APP: ${found.name}` : 'NOTHING';
  };

  it('is found again at the address its tab is given, though another saved app has that name', async () => {
    const app = runtime();
    const data = bundleOf();
    const other = await app.open({ data: bundleOf({ 'ui/main.ui': MAIN.replace('Notes', 'Tasks page') }, { name: 'Tasks' }) });
    app.close(other.id);
    const tab = await app.open({ data });
    const origin = tab.appId!;
    const session = await edit(app.editing, tab.id);
    await type(session, 'manifest.json', '"name":"Notes"', '"name":"Tasks"');
    expect(session.status).toEqual({ kind: 'ok', text: 'Updated.' });
    // At once, without a reload: its tab, Home and its address agree, and the address is this app's.
    expect(app.tab(tab.id).name).toBe('Tasks');
    expect((await getCachedAppByOrigin(origin))!.name).toBe('Tasks');
    expect(await reloadOpens(tabAddress(app.tab(tab.id)), origin)).toBe('this app');
    await session.close();
    app.close(tab.id);

    // The page is reloaded: the app opens from the library, with the person's changes.
    const saved = (await getCachedAppByOrigin(origin))!;
    const again = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(again.appId).toBe(origin);
    // The address the runtime writes for this tab, and what a reload at that address opens.
    const address = tabAddress(again);
    expect({ address, tabName: again.name, libraryName: saved.name, reloadOpens: await reloadOpens(address, origin) }).toEqual({
      address,
      tabName: 'Tasks',
      libraryName: 'Tasks',
      reloadOpens: 'this app',
    });
    // Two saved apps are shown as Tasks, so this one's address keeps the name its bundle gives it.
    expect(address).toBe('~Notes');
  });

  it('keeps its address where no other app has the new name either, is shown under the new name, and Discard returns its name everywhere', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const origin = tab.appId!;
    const session = await edit(app.editing, tab.id);
    await type(session, 'manifest.json', '"name":"Notes"', '"name":"Notebook"');
    await session.close();
    app.close(tab.id);
    const saved = (await getCachedAppByOrigin(origin))!;
    const again = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    const address = tabAddress(again);
    // Its address is its bundle's own name, always: a bookmark of it goes on finding it.
    expect({ address, reloadOpens: await reloadOpens(address, origin) }).toEqual({ address: '~Notes', reloadOpens: 'this app' });
    expect({ tab: again.name, home: saved.name }).toEqual({ tab: 'Notebook', home: 'Notebook' });
    // And no address is found by a name typed in the editor, which any other app may be given.
    expect(await reloadOpens('~Notebook', origin)).toBe('NOTHING');

    const reopened = await edit(app.editing, again.id);
    await reopened.discard();
    expect(reopened.status.kind).toBe('ok');
    const back = (await getCachedAppByOrigin(origin))!;
    expect({ tab: app.tab(again.id).name, home: back.name, ownName: back.ownName, address: tabAddress(app.tab(again.id)) }).toEqual({
      tab: 'Notes',
      home: 'Notes',
      ownName: undefined,
      address: '~Notes',
    });
    expect(await reloadOpens('~Notes', origin)).toBe('this app');
    expect(await reloadOpens('~Notebook', origin)).toBe('NOTHING');
  });

  it('does not bring the name of the app a copy was made from back, when a first change to the copy’s manifest is undone', async () => {
    const app = runtime();
    const data = bundleOf();
    const tab = await app.open({ data, fromLink: true });
    const theirs = tab.appId!;
    const session = await edit(app.editing, tab.id);
    // The first change, which makes the copy, is to the manifest itself.
    await type(session, 'manifest.json', '"version":"1.0.0"', '"version":"1.0.0","description":"Mine now"');
    expect(session.status.kind).toBe('ok');
    const copy = app.tab(tab.id).appId!;
    expect(copy).not.toBe(theirs);
    expect(JSON.parse(session.files.get('manifest.json')!)).toMatchObject({ name: 'Notes (my copy)', description: 'Mine now' });

    expect(session.undo('manifest.json')).toBe(true);
    await session.flush();
    expect(session.status.kind).toBe('ok');
    const undone = JSON.parse(session.files.get('manifest.json')!);
    expect({ name: undone.name, description: undone.description }).toEqual({ name: 'Notes (my copy)', description: undefined });
    expect(app.tab(tab.id).name).toBe('Notes (my copy)');
    // A reload at the copy's address opens the copy, not the app it was made from.
    expect(await reloadOpens(tabAddress(app.tab(tab.id)), copy)).toBe('this app');
    expect((await getCachedAppByOrigin(copy))!.name).toBe('Notes (my copy)');
    expect((await getCachedAppByOrigin(theirs))!.name).toBe('Notes');
  });

  it('gives a copy of an app with a long name a name that fits, so the copy opens again', async () => {
    const app = runtime();
    const long = 'N'.repeat(250);
    const data = bundleOf({}, { name: long });
    const tab = await app.open({ data, fromLink: true });
    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Mine<');
    expect(session.status.kind).toBe('ok');
    const copyOrigin = app.tab(tab.id).appId!;
    expect(copyOrigin).not.toBe(tab.appId);
    await session.close();
    app.close(tab.id);
    const copy = (await getCachedAppByOrigin(copyOrigin))!;
    expect(copy.name).toBe(`${'N'.repeat(245)} (my copy)`);
    expect(copy.name.length).toBe(255);
    const again = await app.tryOpen({ data: copy.bundleData, cachedAppId: copy.id });
    expect({ opened: again !== null, errors: app.errors.map((error) => error.message) }).toEqual({ opened: true, errors: [] });
    expect(again!.source).toContain('Mine');
  });
});

describe('an app from the directory, opened again by the editor', () => {
  it('is still the directory’s after Restart on a page a link put on screen: its slug, its address, and where it was fetched from', async () => {
    const app = runtime();
    const data = bundleOf();
    const tab = await app.open({ data, directorySlug: 'notes', fromLink: true });
    expect(tab.directorySlug).toBe('notes');
    expect(tab.mine).toBe(false);
    // Opened by address, the runtime notes where the bundle came from; a link then put another page on screen.
    app.editing.patch(tab.id, { shownPage: 'ui/main.ui', bundleUrl: 'https://softn.example/api/apps/notes/bundle' });
    const session = await edit(app.editing, tab.id);
    // Restart on such a page goes through the host's reopen.
    await session.restart();
    expect(session.status).toEqual({ kind: 'ok', text: 'Started again, clean.' });
    const now = app.tab(tab.id);
    expect({ directorySlug: now.directorySlug ?? null, address: tabAddress(now), mine: now.mine, bundleUrl: now.bundleUrl ?? null }).toEqual({
      directorySlug: 'notes',
      address: 'notes',
      mine: false,
      bundleUrl: 'https://softn.example/api/apps/notes/bundle',
    });
  });
});

describe('two tabs editing one app', () => {
  it('never write over what the other kept: the later one says so, and the person chooses', async () => {
    const one = runtime();
    const two = runtime();
    const data = bundleOf();
    const tabOne = await one.open({ data });
    const tabTwo = await two.open({ data });
    const origin = tabOne.appId!;
    const first = await edit(one.editing, tabOne.id);
    const second = await edit(two.editing, tabTwo.id);
    await type(first, 'ui/main.ui', '>Notes<', '>From tab one<');
    expect(first.status.kind).toBe('ok');
    expect((await readDraft(origin))?.files['ui/main.ui']).toContain('From tab one');

    await type(second, 'logic/main.logic', 'count + 1', 'count + 2');
    // Nothing of tab one's was written over, tab two says why its change is not saved, and its app was not handed it.
    expect(second.status).toMatchObject({ kind: 'held', choose: 'tabs' });
    expect(second.status.text).toMatch(/^This app was changed in another tab/);
    expect(second.changedElsewhere()).toBe(true);
    // What runs is tab one's, untouched. What tab two typed is set beside it as typed text, so that it is not lost if the page goes.
    const untouched = (await readDraft(origin))!;
    expect({ ui: untouched.files['ui/main.ui']?.includes('From tab one') ?? false, logic: untouched.files['logic/main.logic'] ?? null, typed: Object.keys(untouched.typed ?? {}), aside: untouched.aside ?? null }).toEqual({
      ui: true,
      logic: null,
      typed: ['logic/main.logic'],
      aside: null,
    });
    expect(untouched.typed?.['logic/main.logic']).toContain('count + 2');
    expect(two.tab(tabTwo.id).textFiles?.get('logic/main.logic')).toBe(LOGIC);
    // Typing on changes none of what runs, in the store or in the app.
    await type(second, 'logic/main.logic', 'count + 2', 'count + 3');
    const still = (await readDraft(origin))!;
    expect({ runs: still.files, typed: still.typed?.['logic/main.logic']?.includes('count + 3') }).toEqual({ runs: untouched.files, typed: true });
    expect(two.tab(tabTwo.id).textFiles?.get('logic/main.logic')).toBe(LOGIC);

    // "Take those changes": what each tab changed is kept.
    await second.takeTheirs();
    expect(second.status.kind).toBe('ok');
    expect(second.changedElsewhere()).toBe(false);
    const draft = (await readDraft(origin))!;
    expect({ ui: draft.files['ui/main.ui']?.includes('From tab one') ?? false, logic: draft.files['logic/main.logic']?.includes('count + 3') ?? false }).toEqual({ ui: true, logic: true });
    expect(two.tab(tabTwo.id).source).toContain('From tab one');
    expect(second.files.get('ui/main.ui')).toContain('From tab one');

    // Tab one is told in its turn, on its next change, and keeps its own where the two meet.
    await type(first, 'ui/main.ui', '>From tab one<', '>From tab one, again<');
    expect(first.status).toMatchObject({ kind: 'held', choose: 'tabs' });
    await first.keepMine();
    expect(first.status.kind).toBe('ok');
    const both = (await readDraft(origin))!;
    expect({ ui: both.files['ui/main.ui']?.includes('From tab one, again') ?? false, logic: both.files['logic/main.logic']?.includes('count + 3') ?? false }).toEqual({ ui: true, logic: true });
    expect(one.tab(tabOne.id).source).toContain('count + 3');
    await Promise.all([first.close(), second.close()]);
  });

  it('gives the file both changed to whoever the person chooses, with a step back to the other', async () => {
    const one = runtime();
    const two = runtime();
    const data = bundleOf();
    const tabOne = await one.open({ data });
    const tabTwo = await two.open({ data });
    const first = await edit(one.editing, tabOne.id);
    const second = await edit(two.editing, tabTwo.id);
    await type(first, 'ui/main.ui', '>Notes<', '>One<');
    await type(second, 'ui/main.ui', '>Notes<', '>Two<');
    expect(second.status.choose).toBe('tabs');
    await second.takeTheirs();
    expect(second.files.get('ui/main.ui')).toContain('>One<');
    expect((await readDraft(tabOne.appId!))!.files['ui/main.ui']).toContain('>One<');
    // What this tab had typed is one step back.
    expect(second.undo('ui/main.ui')).toBe(true);
    expect(second.files.get('ui/main.ui')).toContain('>Two<');
    await second.flush();
    expect(second.status.kind).toBe('ok');
    await Promise.all([first.close(), second.close()]);
  });

  it('answers the other tab’s newest: the question is not met by itself again when that tab has gone on since it was raised', async () => {
    const one = runtime();
    const two = runtime();
    const data = bundleOf();
    const tabOne = await one.open({ data });
    const tabTwo = await two.open({ data });
    const first = await edit(one.editing, tabOne.id);
    const second = await edit(two.editing, tabTwo.id);
    await type(first, 'ui/main.ui', '>Notes<', '>One<');
    await type(second, 'logic/main.logic', 'count + 1', 'count + 2');
    expect(second.status.choose).toBe('tabs');
    // Tab one goes on, twice. It is asked nothing: tab two has decided nothing, and written nothing.
    await type(first, 'ui/main.ui', '>One<', '>One, on<');
    expect(first.status).toEqual({ kind: 'ok', text: 'Updated.' });
    await type(first, 'ui/main.ui', '>One, on<', '>One, on and on<');
    expect(first.status).toEqual({ kind: 'ok', text: 'Updated.' });
    // Tab two answers the question it was asked a while ago.
    await second.keepMine();
    expect({ kind: second.status.kind, asked: second.changedElsewhere() }).toEqual({ kind: 'ok', asked: false });
    const kept = (await readDraft(tabOne.appId!))!;
    expect({ ui: kept.files['ui/main.ui']?.includes('One, on and on') ?? false, logic: kept.files['logic/main.logic']?.includes('count + 2') ?? false }).toEqual({ ui: true, logic: true });
    await Promise.all([first.close(), second.close()]);
  });

  it('shows, in an editor opened later, what another tab has kept since this tab opened the app', async () => {
    const one = runtime();
    const two = runtime();
    const data = bundleOf();
    const tabOne = await one.open({ data });
    const tabTwo = await two.open({ data });
    const first = await edit(one.editing, tabOne.id);
    await type(first, 'ui/main.ui', '>Notes<', '>From tab one<');
    // Tab two's app opened before that. Its editor opens on what is kept now, and hands it to the app.
    const second = await edit(two.editing, tabTwo.id);
    expect(second.files.get('ui/main.ui')).toContain('From tab one');
    await second.flush();
    expect(second.status.kind).toBe('ok');
    expect(two.tab(tabTwo.id).source).toContain('From tab one');
    expect(second.changedElsewhere()).toBe(false);
    await Promise.all([first.close(), second.close()]);
  });
});

describe('what is typed', () => {
  it('is kept while the app is still answering, and closing does not wait for an answer that cannot come', async () => {
    const app = runtime({ silent: true });
    const tab = await app.open({ data: bundleOf() });
    const session = (await EditSession.open(app.editing, tab.id, { pause: 0, closeWait: 150 }))!;
    session.type('ui/main.ui', MAIN.replace('>Notes<', '>Typed, and the app is busy<'));
    void session.flush();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const draft = await readDraft(tab.appId!);
    expect(JSON.stringify(draft ?? null)).toContain('Typed, and the app is busy');
    // Kept as typed, not as what runs: the app has not shown it.
    expect(draft?.typed?.['ui/main.ui']).toContain('Typed, and the app is busy');
    expect(hasDraft(tab.appId!)).toBe(false);

    // The editor is put away while the app has still not answered: it is given a moment, not for ever.
    const waited = (closing: Promise<void>) => Promise.race([closing.then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000))]);
    expect(await waited(session.close())).toBe('closed');

    // And a tab closed under an update in flight is not waited for at all.
    const other = runtime({ silent: true });
    const gone = await other.open({ data: bundleOf({ 'ui/main.ui': MAIN.replace('Notes', 'Other') }) });
    const second = (await EditSession.open(other.editing, gone.id, { pause: 0, closeWait: 60_000 }))!;
    second.type('ui/main.ui', second.files.get('ui/main.ui')!.replace('>Other<', '>Typed<'));
    void second.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));
    other.close(gone.id);
    expect(await waited(second.close())).toBe('closed');
  });

  it('is saved at once when the page is hidden, without waiting for the pause after the last key', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const session = (await EditSession.open(app.editing, tab.id, { pause: 60_000, makeLive: standInApp }))!;
    session.type('ui/main.ui', MAIN.replace('>Notes<', '>Typed just before the phone was put away<'));
    expect(await readDraft(tab.appId!)).toBeNull();
    await session.save();
    expect((await readDraft(tab.appId!))?.typed?.['ui/main.ui']).toContain('Typed just before the phone was put away');
    await session.close();
  });

  it('is forgotten with the app when the app is removed, though it never showed', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const origin = tab.appId!;
    const session = await edit(app.editing, tab.id);
    // A change that does not parse: kept as typed, not as what runs.
    session.type('ui/main.ui', MAIN.replace('<span class="count">', '<span class="count" else>'));
    await session.flush();
    expect(session.status.kind).toBe('held');
    expect((await readDraft(origin))?.typed?.['ui/main.ui']).toContain(' else>');
    // Nothing runs with it, so the index of apps with changes to lay does not name it.
    expect(hasDraft(origin)).toBe(false);
    await session.close();
    // What removing an app from Home does with the editor's store (App.tsx, handleRemove).
    await forgetEdits(origin);
    expect(await readDraft(origin)).toBeNull();
  });

  it('keeps only so much of a large file’s history, and always one step back', async () => {
    const app = runtime();
    const big = `<div>\n${'  <p>line</p>\n'.repeat(120_000)}</div>\n`; // about 1.7 million characters
    const tab = await app.open({ data: bundleOf({ 'ui/big.ui': big, 'data/huge.txt': 'A line of a very long file.\n'.repeat(100_000) }) });
    let now = 1000;
    const session = (await EditSession.open(app.editing, tab.id, { pause: 60_000, makeLive: standInApp, now: () => now }))!;
    // Edited, at this size; a file past two and a half million characters is shown and not edited.
    expect(session.tooLarge('ui/big.ui')).toBe(false);
    expect(session.tooLarge('ui/main.ui')).toBe(false);
    expect(session.tooLarge('data/huge.txt')).toBe(true);
    for (let step = 1; step <= 12; step++) {
      now += 5000;
      session.type('ui/big.ui', `${big}<!-- ${step} -->\n`);
    }
    let back = 0;
    while (session.undo('ui/big.ui')) back++;
    // Twelve whole copies would be twenty million characters; what is kept is under eight.
    expect(back).toBeGreaterThanOrEqual(1);
    expect(back).toBeLessThanOrEqual(4);
    await session.close();
  });
});

describe('a file added in the editor', () => {
  it('is refused under a name the bundle reader would leave out, with the reason', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const session = await edit(app.editing, tab.id);
    const refused = session.add('ui/v1..2.ui', '<div><h1>Version</h1></div>\n');
    expect(refused).toMatch(/^A name cannot have two dots together/);
    expect(session.files.has('ui/v1..2.ui')).toBe(false);
    await session.flush();
    expect(app.tab(tab.id).textFiles?.has('ui/v1..2.ui')).toBe(false);
    // A name one dot apart is a name like any other, and is in the bundle the editor hands back.
    expect(session.add('ui/v1.2.ui', '<div><h1>Version</h1></div>\n')).toBeNull();
    await session.flush();
    expect(session.status.kind).toBe('ok');
    const bytes = (await session.bundle())!;
    expect({ unsafe: openBundleArchive(bytes).unsafeNames(), opensWithIt: readZip(bytes).textFiles.has('ui/v1.2.ui') }).toEqual({ unsafe: [], opensWithIt: true });
  });
});

describe('a copy of someone else’s app', () => {
  it('carries the person’s records and none of the notes of where the app stood with sync', async () => {
    const app = runtime();
    const data = bundleOf();
    const tab = await app.open({ data, fromLink: true });
    const theirs = tab.appId!;
    localStorage.setItem(`xdb:${theirs}::p2p-room`, '1');
    localStorage.setItem(`xdb:${theirs}::sync-queue`, '[{"op":"put","collection":"notes","id":"1"}]');
    localStorage.setItem(`xdb:${theirs}::sync-pulled`, '{"notes":123}');
    localStorage.setItem(`xdb:${theirs}::removals:notes`, '["9"]');
    localStorage.setItem(`xdb:${theirs}::collections`, '["notes"]');
    localStorage.setItem(`xdb:${theirs}:notes`, '[{"id":"1"}]');
    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Mine<');
    const copy = app.tab(tab.id).appId!;
    const carried = Object.keys(localStorage).filter((key) => key.startsWith(`xdb:${copy}:`)).sort();
    expect(carried).toEqual([`xdb:${copy}::collections`, `xdb:${copy}:notes`]);
    // The app it was made from keeps every one of its own.
    expect(Object.keys(localStorage).filter((key) => key.startsWith(`xdb:${theirs}::`)).sort()).toEqual(
      ['collections', 'p2p-room', 'removals:notes', 'sync-pulled', 'sync-queue'].map((note) => `xdb:${theirs}::${note}`)
    );
  });

  it('is not allowed to sync because the app was: it is opened as any app is, and asks', async () => {
    const app = runtime();
    const ASKS_SYNC = JSON.stringify({ permissions: { net: { enabled: true }, sync: { enabled: true } } });
    const data = bundleOf({ 'permission.json': ASKS_SYNC }, { config: { server: { url: 'wss://sync.softn.example', token: 'theirs' } } });
    const first = await app.open({ data, fromLink: true });
    expect(first.consent?.capabilities).toEqual(['net', 'sync']);
    // The person allowed the published app.
    first.consent!.onAllow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    app.close(first.id);
    const tab = await app.open({ data, fromLink: true });
    expect(tab.consent).toBeUndefined();

    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Mine<');
    expect(session.status.kind).toBe('ok');
    expect(session.status.text).toMatch(/It is running as your copy, with your change\. It asks before it uses what the app was allowed/);
    const now = app.tab(tab.id);
    const copy = (await getCachedAppByOrigin(now.appId!))!;
    expect(now.appId).not.toBe(tab.appId);
    expect(now.source).toContain('Mine');
    // Nothing is allowed the copy, in this run or on record: the runtime's bar asks, as for any app.
    expect(copy.grantedPermissions).toBeUndefined();
    expect(now.consent?.capabilities).toEqual(['net', 'sync']);
    expect(now.consent?.appName).toBe('Notes (my copy)');
    expect(now.permissionConfig?.consentPending).toBe(true);
  });

  it('says which file is damaged, and changes nothing, when the app cannot be copied', async () => {
    const app = runtime();
    const filler = Array.from({ length: 4000 }, (_, i) => `row ${i} of a file the app never reads\n`).join('');
    const data = bundleOf({ 'data/unread.txt': filler });
    // The entry's compressed bytes are damaged where they lie in the archive: found by its name in its own header.
    const name = ascii('data/unread.txt');
    let header = -1;
    for (let at = 0; at + name.length < data.length && header < 0; at++) {
      if (data[at] === 0x50 && data[at + 1] === 0x4b && data[at + 2] === 3 && data[at + 3] === 4 && name.every((byte, i) => data[at + 30 + i] === byte)) header = at;
    }
    expect(header).toBeGreaterThanOrEqual(0);
    const start = header + 30 + name.length + (data[header + 28] | (data[header + 29] << 8));
    for (let i = 40; i < 80; i++) data[start + i] ^= 0xff;

    // It opens and runs: nothing reads that file.
    const tab = await app.open({ data, fromLink: true });
    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Mine<');
    expect(session.status).toEqual({ kind: 'held', text: '“data/unread.txt” in this app is damaged and cannot be read, so the app cannot be copied or written as a file.' });
    expect(app.tab(tab.id).appId).toBe(tab.appId);
    expect(await getCachedApps()).toHaveLength(1);
    // Asked for as a file, the same sentence, not a rejection nobody hears.
    await expect(session.bundle()).rejects.toThrow('“data/unread.txt” in this app is damaged and cannot be read');
  });
});

describe('changes a person made to their own app, once the same bundle has come from the directory or a link', () => {
  it('are not laid over it, are said to be kept, and are brought into a copy when the person asks', async () => {
    const app = runtime();
    const data = bundleOf();
    const own = await app.open({ data });
    const origin = own.appId!;
    const first = await edit(app.editing, own.id);
    first.type('ui/main.ui', MAIN.replace('>Notes<', '>My hours of work<'));
    await first.flush();
    expect(first.earlier()).toBe(false);
    await first.close();
    app.close(own.id);
    // The same bytes arrive once by a link (their own published copy, or a link someone sent).
    const linked = await app.open({ data, fromLink: true });
    app.close(linked.id);

    // From then on, from their own library, it is the app as published: nothing is laid over it.
    const saved = (await getCachedAppByOrigin(origin))!;
    const again = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    const session = await edit(app.editing, again.id);
    expect({
      runsTheirChanges: again.source.includes('My hours of work'),
      editorShowsThem: session.files.get('ui/main.ui')!.includes('My hours of work'),
      stillInTheStore: (await readDraft(origin))?.files['ui/main.ui']?.includes('My hours of work') ?? false,
      whose: session.whose(),
      offered: session.earlier(),
    }).toEqual({ runsTheirChanges: false, editorShowsThem: false, stillInTheStore: true, whose: 'theirs', offered: true });

    // Asked for, they become the first content of the person's own copy. The app itself is not changed.
    await session.bringEarlier();
    expect(session.status.kind).toBe('ok');
    expect(session.status.text).toMatch(/^This makes your own copy, “Notes \(my copy\)”/);
    const now = app.tab(again.id);
    expect(now.appId).not.toBe(origin);
    expect({ whose: session.whose(), runsThem: now.source.includes('My hours of work'), editorShowsThem: session.files.get('ui/main.ui')!.includes('My hours of work'), offered: session.earlier() }).toEqual({
      whose: 'mine',
      runsThem: true,
      editorShowsThem: true,
      offered: false,
    });
    expect((await readDraft(now.appId!))?.files['ui/main.ui']).toContain('My hours of work');
    // Brought, they are no longer kept beside the app they were made in.
    expect(await readDraft(origin)).toBeNull();
    expect(Array.from((await getCachedAppByOrigin(origin))!.bundleData)).toEqual(Array.from(data));
  });
});

describe('a page a link put on screen', () => {
  /** A runtime whose page answers a change the way the renderer of a linked page does: through the host, not the tab's own app. */
  function withPage(answer: (fields: Partial<OpenTab>) => AppUpdateResult | null) {
    const app = runtime();
    let listener: ((tabId: string, result: AppUpdateResult) => void) | null = null;
    const patch = app.editing.patch;
    const editing: EditHost = {
      ...app.editing,
      patch: (tabId, fields) => {
        patch(tabId, fields);
        const result = 'source' in fields && fields.source ? answer(fields) : null;
        if (result) queueMicrotask(() => listener?.(tabId, result));
      },
      onAppUpdate: (heard) => {
        listener = heard;
        return () => {
          listener = null;
        };
      },
    };
    return { ...app, editing };
  }
  const ABOUT = '<div class="about">\n  <h2>About</h2>\n</div>\n';

  it('does not leave a change the page refused on the tab, where Download and the next link would read it', async () => {
    // The page refuses anything that says "refuse me", as a renderer refuses logic that does not start.
    const app = withPage((fields) => (String(fields.textFiles?.get('ui/about.ui')).includes('refuse me') ? { outcome: 'kept', changed: [], problem: 'ui/about.ui, line 2: it does not start' } : { outcome: 'updated', changed: ['page'] }));
    const tab = await app.open({ data: bundleOf({ 'ui/about.ui': ABOUT }) });
    app.editing.patch(tab.id, { shownPage: 'ui/about.ui' });
    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/about.ui', '>About<', '>About us<');
    expect(session.status).toEqual({ kind: 'ok', text: 'Updated.' });
    const good = app.tab(tab.id);

    await type(session, 'ui/about.ui', '>About us<', '>refuse me<');
    expect(session.status).toMatchObject({ kind: 'held', file: 'ui/about.ui', line: 2 });
    const now = app.tab(tab.id);
    expect(now.textFiles?.get('ui/about.ui')).toContain('>About us<');
    expect(now.textFiles?.get('ui/about.ui')).not.toContain('refuse me');
    expect(now.source).toBe(good.source);
    // What runs is what is kept as running; what was typed is kept as typed.
    const draft = (await readDraft(tab.appId!))!;
    expect(draft.files['ui/about.ui']).toContain('>About us<');
    expect(draft.typed?.['ui/about.ui']).toContain('refuse me');
  });

  it('is not waited on for a change it has nothing to say about: a file it neither draws from nor imports', async () => {
    // As the renderer of a linked page is: silent about a change that is none to it.
    const app = withPage(() => null);
    const tab = await app.open({ data: bundleOf({ 'ui/about.ui': ABOUT, 'data/notes.txt': 'one\n' }) });
    app.editing.patch(tab.id, { shownPage: 'ui/about.ui' });
    const session = await edit(app.editing, tab.id);
    const began = Date.now();
    await type(session, 'data/notes.txt', 'one', 'two');
    expect(session.status).toEqual({ kind: 'ok', text: 'Updated.' });
    // It used to wait three seconds for an answer that was never coming.
    expect(Date.now() - began).toBeLessThan(1500);
    // The tab has the file all the same: what Download writes and a link reads.
    expect(app.tab(tab.id).textFiles?.get('data/notes.txt')).toBe('two\n');
    expect((await readDraft(tab.appId!))?.files['data/notes.txt']).toBe('two\n');
    await session.close();
  });

  it('is not handed a page that cannot be read at all', async () => {
    const patched: Array<Partial<OpenTab>> = [];
    const app = withPage((fields) => {
      patched.push(fields);
      return { outcome: 'updated', changed: ['page'] };
    });
    const tab = await app.open({ data: bundleOf({ 'ui/about.ui': ABOUT }) });
    app.editing.patch(tab.id, { shownPage: 'ui/about.ui' });
    const session = await edit(app.editing, tab.id);
    await type(session, 'ui/about.ui', '<h2>', '<h2 else>');
    expect(session.status.kind).toBe('held');
    expect(session.status.text).toMatch(/^Not shown yet: ui\/about\.ui, line 2/);
    expect(patched).toEqual([]);
    expect(app.tab(tab.id).textFiles?.get('ui/about.ui')).toBe(ABOUT);
  });
});

describe('removing an app from Home', () => {
  it('always forgets what the editor keeps for it, whatever the index of edited apps says', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(source).toMatch(/if \(going\.origin\) await forgetEdits\(going\.origin\);/);
    expect(source).not.toMatch(/hasDraft\(/);
  });
});

// The database these run over does its writes one at a time, in the order
// they were asked for, as IndexedDB does (helpers/fakeIdb.ts). Two of one
// editor's saves on their way together is what the first four are about.
describe('an editor’s own saves', () => {
  it('are never another tab’s to it: a save as the page is hidden, while a change is being kept, raises no question', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const store = watched();
    const session = await edit(app.editing, tab.id, store);
    // The person types, pauses (the change starts to be kept and handed over), and switches to another browser tab.
    session.type('ui/main.ui', MAIN.replace('>Notes<', '>Typed<'));
    const handing = session.flush();
    await Promise.resolve();
    await Promise.resolve();
    const hidden = session.save(); // EditPane.tsx: visibilitychange -> session.save()
    await Promise.all([handing, hidden]);
    await session.settled();
    expect({ writes: store.writes, changedElsewhere: session.changedElsewhere(), status: session.status.text }).toEqual({
      writes: expect.not.arrayContaining(['REFUSED: a newer draft is there']),
      changedElsewhere: false,
      status: 'Updated.',
    });
    expect(store.writes.length).toBeGreaterThan(1);

    // Back in the tab, the person types on: it still reaches the app, and is still kept.
    session.type('ui/main.ui', session.files.get('ui/main.ui')!.replace('>Typed<', '>Typed, and typed again<'));
    await session.flush();
    await session.settled();
    expect({
      statusLine: session.status.text,
      offeredAChoice: session.status.choose ?? null,
      appShowsIt: app.tab(tab.id).source.includes('typed again'),
      keptBesideTheApp: JSON.stringify(await readDraft(tab.appId!)).includes('typed again'),
    }).toEqual({ statusLine: 'Updated.', offeredAChoice: null, appShowsIt: true, keptBesideTheApp: true });
    await session.close();
  });

  it('raise no question when the page is hidden and then left, one save straight after the other', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf() });
    const store = watched();
    const session = (await EditSession.open(app.editing, tab.id, { pause: 10_000, store, makeLive: standInApp }))!;
    session.type('ui/main.ui', MAIN.replace('>Notes<', '>Typed<'));
    // visibilitychange, then pagehide (EditPane.tsx).
    const first = session.save();
    const second = session.save();
    await Promise.all([first, second]);
    expect({ changedElsewhere: session.changedElsewhere(), choose: session.status.choose ?? null, writes: store.writes }).toEqual({ changedElsewhere: false, choose: null, writes: ['kept', 'kept'] });
    expect((await readDraft(tab.appId!))?.typed?.['ui/main.ui']).toContain('>Typed<');
    await session.close();
  });

  it('leave what is kept alone where they say nothing new: leaving one of two tabs, with nothing changed in it, is no change for the other to choose about', async () => {
    const one = runtime();
    const two = runtime();
    const data = bundleOf();
    const tabOne = await one.open({ data });
    const first = await edit(one.editing, tabOne.id);
    await type(first, 'ui/main.ui', '>Notes<', '>Edited in one<');
    // Tab two opens the app (with those changes laid over it) and its editor: it has read what is kept.
    const saved = (await getCachedAppByOrigin(tabOne.appId!))!;
    const tabTwo = await two.open({ data: saved.bundleData, cachedAppId: saved.id });
    const second = await edit(two.editing, tabTwo.id);
    expect(second.files.get('ui/main.ui')).toContain('Edited in one');
    // The person goes from tab one to tab two: tab one is hidden, and saves. Nothing was typed in it.
    const before = (await readDraft(tabOne.appId!))!;
    await first.save();
    const after = (await readDraft(tabOne.appId!))!;
    // In tab two they type.
    await type(second, 'logic/main.logic', 'count + 1', 'count + 2');
    expect({ rewrittenWithNothingChanged: after.at !== before.at, tabTwoHasToChoose: second.status.choose ?? null, tabTwoStatus: second.status.text }).toEqual({
      rewrittenWithNothingChanged: false,
      tabTwoHasToChoose: null,
      tabTwoStatus: 'Started again: Its logic changed.',
    });
    await Promise.all([first.close(), second.close()]);
  });

  it('are not another tab’s to the editor opened next on the same tab: put away while the app was answering, and opened again', async () => {
    const app = runtime({ silent: 'slow' });
    const tab = await app.open({ data: bundleOf() });
    const live = () => app.tab(tab.id).live as StandIn;
    // Nothing here goes by the clock: each step waits for what it follows, so a slow machine runs the same order.
    const until = async (what: () => boolean): Promise<void> => {
      for (let i = 0; i < 4000 && !what(); i++) await tick(1);
      if (!what()) throw new Error('what the test waited for did not happen');
    };
    /** The app answers whatever it is handed, until `through` is. */
    const answering = async (through: Promise<unknown>): Promise<void> => {
      let done = false;
      void through.then(
        () => (done = true),
        () => (done = true)
      );
      while (!done) {
        live().answer();
        await tick(1);
      }
    };
    const first = (await EditSession.open(app.editing, tab.id, { pause: 0 }))!;
    first.type('ui/main.ui', MAIN.replace('>Notes<', '>One<'));
    // The app has the change and has not answered: it is in flight.
    await until(() => live().handed.length > 0);
    // Edit pressed (off): the editor is put away while the change is in flight. The pane does not wait for it.
    const closing = first.close();
    // Edit pressed again (on): a new editor on the same tab, which reads what is kept.
    const second = (await EditSession.open(app.editing, tab.id, { pause: 0 }))!;
    // The app answers the first editor's change.
    await answering(closing);
    second.type('ui/main.ui', second.files.get('ui/main.ui')!.replace('>One<', '>One, two<'));
    await answering(second.flush());
    expect({ changedElsewhere: second.changedElsewhere(), choose: second.status.choose ?? null }).toEqual({ changedElsewhere: false, choose: null });
    // And what is kept is the newer editor's: the older one wrote nothing over it once it was superseded.
    expect(JSON.stringify(await readDraft(tab.appId!))).toContain('One, two');
    await second.close();
  });

  it('are another tab’s to another tab, three tabs deep: every tab’s change is in what is kept once each has chosen', async () => {
    const data = bundleOf({ 'ui/a.ui': '<p>a</p>\n', 'ui/b.ui': '<p>b</p>\n', 'ui/c.ui': '<p>c</p>\n' });
    const one = runtime();
    const two = runtime();
    const three = runtime();
    const t1 = await one.open({ data });
    const t2 = await two.open({ data });
    const t3 = await three.open({ data });
    const origin = t1.appId!;
    const s1 = await edit(one.editing, t1.id);
    const s2 = await edit(two.editing, t2.id);
    const s3 = await edit(three.editing, t3.id);
    await type(s1, 'ui/a.ui', '<p>a</p>', '<p>a from one</p>');
    await type(s2, 'ui/b.ui', '<p>b</p>', '<p>b from two</p>');
    await type(s3, 'ui/c.ui', '<p>c</p>', '<p>c from three</p>');
    expect([s1.status.choose ?? null, s2.status.choose ?? null, s3.status.choose ?? null]).toEqual([null, 'tabs', 'tabs']);
    // Two chooses; while it does, one writes again (a third write lands).
    const choosing = s2.takeTheirs();
    await type(s1, 'ui/a.ui', 'a from one', 'a from one, again');
    await choosing;
    for (let round = 0; round < 4 && s2.changedElsewhere(); round++) await s2.takeTheirs();
    for (let round = 0; round < 4 && s3.changedElsewhere(); round++) await s3.keepMine();
    const kept = (await readDraft(origin))!;
    expect({ a: kept.files['ui/a.ui'] ?? null, b: kept.files['ui/b.ui'] ?? null, c: kept.files['ui/c.ui'] ?? null }).toEqual({ a: '<p>a from one, again</p>\n', b: '<p>b from two</p>\n', c: '<p>c from three</p>\n' });
    await Promise.all([s1.close(), s2.close(), s3.close()]);
  });
});

describe('another tab’s changes, waiting on a choice', () => {
  /** Tab one changes the main page; tab two then changes `ui/b.ui`, and is asked. */
  async function asked(twoChanges = 'ui/b.ui') {
    const one = runtime();
    const two = runtime();
    const data = bundleOf({ 'ui/b.ui': '<p>b</p>\n' });
    const t1 = await one.open({ data });
    const t2 = await two.open({ data });
    const s1 = await edit(one.editing, t1.id);
    const s2 = await edit(two.editing, t2.id);
    s1.type('ui/main.ui', MAIN.replace('>Notes<', '>From one<'));
    await s1.flush();
    if (twoChanges === 'ui/b.ui') s2.type('ui/b.ui', '<p>b, first words</p>\n');
    else s2.type('ui/main.ui', MAIN.replace('>Notes<', '>From two<'));
    await s2.flush();
    expect(s2.status.choose).toBe('tabs');
    return { one, two, t1, t2, s1, s2, origin: t1.appId! };
  }

  it('are never painted over, and are said again on every change: the editor does not go quiet', async () => {
    const { s2, two, t2 } = await asked();
    const question = s2.status.text;
    // Restart says its own line, and the question is still what stands.
    await s2.restart();
    expect(s2.status).toEqual({ kind: 'held', text: question, choose: 'tabs' });
    s2.type('ui/b.ui', '<p>b, more words</p>\n');
    await s2.flush();
    expect(s2.status).toEqual({ kind: 'held', text: question, choose: 'tabs' });
    expect(two.tab(t2.id).textFiles?.get('ui/b.ui')).toBe('<p>b</p>\n');
    await s2.keepMine();
    expect(s2.status.kind).toBe('ok');
    expect(two.tab(t2.id).textFiles?.get('ui/b.ui')).toBe('<p>b, more words</p>\n');
  });

  it('keep the editor open when the person asks to put it away: the question is said again, with that in it', async () => {
    const { s2 } = await asked();
    // What the editor's × and Edit on the bar ask first (EditPane.tsx, mayClose).
    expect(s2.remind()).toBe(true);
    expect(s2.status).toMatchObject({ kind: 'held', choose: 'tabs' });
    expect(s2.status.text).toMatch(/The editor stays open until you choose: take those changes, or keep yours\./);
    await s2.takeTheirs();
    expect(s2.remind()).toBe(false);
    expect(s2.status.kind).toBe('ok');
  });

  it('do not cost what was typed since, when the editor goes without a choice: it is kept, and this tab’s app shows it', async () => {
    const { s2, two, t2, origin } = await asked();
    // An hour of typing in tab two, in a file tab one never touched.
    s2.type('ui/b.ui', '<p>b, an hour of typing in tab two</p>\n');
    await s2.flush();
    // The tab is closed, or something else takes the editor down, without a choice.
    await s2.close();
    const kept = (await readDraft(origin))!;
    expect({ keptAnywhere: JSON.stringify(kept).includes('an hour of typing'), appInTabTwoShowsIt: (two.tab(t2.id).textFiles?.get('ui/b.ui') ?? '').includes('an hour of typing') }).toEqual({
      keptAnywhere: true,
      appInTabTwoShowsIt: true,
    });
    // As typed text, beside tab one's changes, which are still what runs: nothing of theirs was written over.
    expect(kept.typed?.['ui/b.ui']).toContain('an hour of typing');
    expect(kept.files['ui/main.ui']).toContain('From one');
    expect(kept.files['ui/b.ui']).toBeUndefined();
    expect(kept.aside).toBeUndefined();

    // The editor opened again (after a reload): both are there, and nothing is left to choose.
    two.close(t2.id);
    const saved = (await getCachedAppByOrigin(origin))!;
    const again = await two.open({ data: saved.bundleData, cachedAppId: saved.id });
    const reopened = await edit(two.editing, again.id);
    expect(reopened.files.get('ui/b.ui')).toContain('an hour of typing');
    expect(reopened.files.get('ui/main.ui')).toContain('From one');
    await reopened.flush();
    expect(reopened.status).toEqual({ kind: 'ok', text: 'Updated.' });
    expect((await readDraft(origin))!.files['ui/b.ui']).toContain('an hour of typing');
    await reopened.close();
  });

  it('are kept beside what was typed when the page is hidden, and the question is asked again for a file both changed', async () => {
    const { s2, two, t2, origin } = await asked('ui/main.ui');
    // The page is hidden with the question unanswered (a phone puts the browser away): nothing can be asked.
    await s2.save();
    const kept = (await readDraft(origin))!;
    // Tab one's page is what runs; tab two's is kept as typed; and tab one's text for the file both changed is set aside.
    expect(kept.files['ui/main.ui']).toContain('From one');
    expect(kept.typed?.['ui/main.ui']).toContain('From two');
    expect(kept.aside?.['ui/main.ui']).toContain('From one');

    // The page never comes back. Opened again, the editor shows what was typed here, and asks.
    two.close(t2.id);
    const saved = (await getCachedAppByOrigin(origin))!;
    const again = await two.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(again.source).toContain('From one');
    const reopened = await edit(two.editing, again.id);
    expect(reopened.files.get('ui/main.ui')).toContain('From two');
    expect(reopened.status).toMatchObject({ kind: 'held', choose: 'tabs' });
    expect(reopened.status.text).toMatch(/^Another tab changed ui\/main\.ui as you did, and the editor was put away before you chose/);
    // Nothing is handed to the app or written until it is answered.
    await reopened.flush();
    expect(two.tab(again.id).source).toContain('From one');
    await reopened.takeTheirs();
    expect(reopened.status.kind).toBe('ok');
    expect(reopened.files.get('ui/main.ui')).toContain('From one');
    const settled = (await readDraft(origin))!;
    expect({ runs: settled.files['ui/main.ui']?.includes('From one'), typed: settled.typed ?? null, aside: settled.aside ?? null }).toEqual({ runs: true, typed: null, aside: null });
    // What was typed here is one step back.
    expect(reopened.undo('ui/main.ui')).toBe(true);
    expect(reopened.files.get('ui/main.ui')).toContain('From two');
    await reopened.flush();
    await reopened.close();
  });
});

// What a tab types while the question waits is kept in a place of its own
// for that tab (drafts.ts, `asides`). In the one shared draft it read, to
// the other tab, as that tab's decided change: both answers then meant one
// tab's heading and every tab ended with the other's.
describe('what a tab types while another tab’s changes wait on a choice', () => {
  const OTHER = '<p>other</p>\n';
  const THIRD = '<p>third</p>\n';
  const heading = (session: EditSession): string => /<h1 id="title">([^<]*)</.exec(session.files.get('ui/main.ui') ?? '')?.[1] ?? '(none)';
  const headingIn = (text: string | null | undefined): string | undefined => /<h1 id="title">([^<]*)</.exec(text ?? '')?.[1];
  async function twoTabs() {
    const one = runtime();
    const two = runtime();
    const data = bundleOf({ 'ui/other.ui': OTHER, 'ui/third.ui': THIRD });
    const t1 = await one.open({ data });
    const t2 = await two.open({ data });
    const s1 = await edit(one.editing, t1.id);
    const s2 = await edit(two.editing, t2.id);
    return { one, two, t1, t2, s1, s2, origin: t1.appId! };
  }

  it('is not the other tab’s to take: a file both changed is the one the person chooses, in the tab that was first too', async () => {
    const { s1, s2, origin } = await twoTabs();
    // Tab one changes the heading. It is kept, and running there.
    await type(s1, 'ui/main.ui', '>Notes<', '>Heading from tab one<');
    expect(s1.status.choose).toBeUndefined();
    // Tab two, which has not seen that, changes the same heading. It is asked, and does not answer yet.
    await type(s2, 'ui/main.ui', '>Notes<', '>Heading from tab two<');
    expect(s2.status.choose).toBe('tabs');
    // Back in tab one, the person changes another file.
    await type(s1, 'ui/other.ui', 'other', 'other, changed in tab one');
    const askedInOne = s1.status.choose ?? null;
    // If tab one is asked, the person says: keep mine.
    if (s1.changedElsewhere()) await s1.keepMine();
    const inOneAfterKeepMine = heading(s1);
    // And in tab two the person says: take those changes (tab one's).
    if (s2.changedElsewhere()) await s2.takeTheirs();
    for (let round = 0; round < 3 && s1.changedElsewhere(); round++) await s1.keepMine();
    for (let round = 0; round < 3 && s2.changedElsewhere(); round++) await s2.takeTheirs();
    const kept = await readDraft(origin);
    const keptHeading = headingIn(kept?.typed?.['ui/main.ui'] ?? kept?.files['ui/main.ui']) ?? '(none)';
    expect({ askedInOne, inOneAfterKeepMine, inTwoAfterTakeTheirs: heading(s2), inOneAtTheEnd: heading(s1), kept: keptHeading }).toEqual({
      // Not asked: tab two has decided nothing and written nothing. (Asked, it took tab two's undecided heading for a change.)
      askedInOne: null,
      inOneAfterKeepMine: 'Heading from tab one',
      inTwoAfterTakeTheirs: 'Heading from tab one',
      inOneAtTheEnd: 'Heading from tab one',
      kept: 'Heading from tab one',
    });
    // Tab two took tab one's other file with it, and nothing is left set aside.
    expect(s2.files.get('ui/other.ui')).toBe('<p>other, changed in tab one</p>\n');
    expect((await readKept(origin))?.asides).toBeUndefined();
    await Promise.all([s1.close(), s2.close()]);
  });

  it('does not come back to the tab that typed it as the other tab’s: its own later words are not rolled back', async () => {
    const { s1, s2, origin } = await twoTabs();
    await type(s1, 'ui/main.ui', '>Notes<', '>One<');
    // Tab two changes a file tab one never touches. Asked; no answer yet.
    await type(s2, 'ui/other.ui', 'other', 'other from two');
    expect(s2.status.choose).toBe('tabs');
    // Tab one changes a third file. It is asked nothing: what tab two typed is tab two's alone until it answers.
    await type(s1, 'ui/third.ui', 'third', 'third, first words');
    expect(s1.status).toEqual({ kind: 'ok', text: 'Updated.' });
    // Tab two types on.
    await type(s2, 'ui/other.ui', 'other from two', 'other from two, more');
    // Tab one goes on writing its third file. There is nothing for it to take yet, and asking changes nothing.
    await type(s1, 'ui/third.ui', 'third, first words', 'third, first words and many more');
    await s1.takeTheirs();
    expect({ third: s1.files.get('ui/third.ui'), other: s1.files.get('ui/other.ui') }).toEqual({ third: '<p>third, first words and many more</p>\n', other: OTHER });
    // Tab two answers, and really writes. Now tab one is asked, at its next change, and takes tab two's file: its own is as it typed it.
    await s2.keepMine();
    expect(s2.status.kind).toBe('ok');
    await type(s1, 'ui/third.ui', 'and many more', 'and many more still');
    expect(s1.status.choose).toBe('tabs');
    await s1.takeTheirs();
    expect({ third: s1.files.get('ui/third.ui'), other: s1.files.get('ui/other.ui') }).toEqual({ third: '<p>third, first words and many more still</p>\n', other: '<p>other from two, more</p>\n' });
    const kept = (await readKept(origin))!;
    expect({ third: kept.files['ui/third.ui'], other: kept.files['ui/other.ui'], main: headingIn(kept.files['ui/main.ui']), asides: kept.asides }).toEqual({
      third: '<p>third, first words and many more still</p>\n',
      other: '<p>other from two, more</p>\n',
      main: 'One',
      asides: undefined,
    });
    await Promise.all([s1.close(), s2.close()]);
  });

  it('is there to choose between when the editor is put away with the question unanswered, then opened again', async () => {
    const { two, t2, s1, s2, origin } = await twoTabs();
    await type(s1, 'ui/main.ui', '>Notes<', '>One<');
    await type(s2, 'ui/main.ui', '>Notes<', '>Two<');
    expect(s2.status.choose).toBe('tabs');
    expect(s2.remind()).toBe(true);
    // The tab's editor goes all the same (Edit pressed on another app's bar, which is not asked).
    await s2.close();
    const draft = (await readDraft(origin))!;
    const again = await edit(two.editing, t2.id);
    expect({ runs: headingIn(draft.files['ui/main.ui']), typed: headingIn(draft.typed?.['ui/main.ui']), asked: again.status.choose ?? null, shows: heading(again), appInTwo: headingIn(two.tab(t2.id).textFiles?.get('ui/main.ui')) }).toEqual({
      runs: 'One',
      typed: 'Two',
      asked: 'tabs',
      shows: 'Two',
      appInTwo: 'Two',
    });
    await again.takeTheirs();
    expect(heading(again)).toBe('One');
    await Promise.all([s1.close(), again.close()]);
  });

  it('moves neither the draft’s time nor its writer, and is no change to any other tab', async () => {
    const { s1, s2, origin } = await twoTabs();
    await type(s1, 'ui/main.ui', '>Notes<', '>One<');
    const before = (await readKept(origin))!;
    await type(s2, 'ui/main.ui', '>Notes<', '>Two<');
    await type(s2, 'ui/other.ui', 'other', 'other from two');
    const after = (await readKept(origin))!;
    expect({ at: after.at, by: after.by, files: after.files, removed: after.removed, typed: after.typed }).toEqual({ at: before.at, by: before.by, files: before.files, removed: before.removed, typed: before.typed });
    // It is there, under tab two's own name: what it typed, and tab one's text for the file both changed.
    const sets = Object.entries(after.asides ?? {});
    expect(sets).toHaveLength(1);
    expect(sets[0][0]).not.toBe(before.by);
    expect({ typed: Object.keys(sets[0][1].typed).sort(), theirs: Object.keys(sets[0][1].theirs ?? {}) }).toEqual({ typed: ['ui/main.ui', 'ui/other.ui'], theirs: ['ui/main.ui'] });
    expect(headingIn(sets[0][1].theirs?.['ui/main.ui'])).toBe('One');
    // Tab one writes on, unasked, and tab two's text is carried along untouched.
    await type(s1, 'ui/third.ui', 'third', 'third from one');
    expect(s1.status).toEqual({ kind: 'ok', text: 'Updated.' });
    expect(Object.keys((await readKept(origin))!.asides ?? {})).toEqual([sets[0][0]]);
    await Promise.all([s1.close(), s2.close()]);
  });

  it('is cleared away: when the question is answered, when the changes are discarded, and when the app is removed', async () => {
    // Answered.
    let tabs = await twoTabs();
    await type(tabs.s1, 'ui/main.ui', '>Notes<', '>One<');
    await type(tabs.s2, 'ui/other.ui', 'other', 'other from two');
    expect(Object.keys((await readKept(tabs.origin))!.asides ?? {})).toHaveLength(1);
    await tabs.s2.takeTheirs();
    expect(tabs.s2.status.kind).toBe('ok');
    expect((await readKept(tabs.origin))!.asides).toBeUndefined();
    // Answered where the answer leaves nothing new to write: "Take those changes" over a file tab two then put back as it was.
    await type(tabs.s1, 'ui/main.ui', '>One<', '>One again<');
    // (Tab two really wrote when it answered, so tab one is asked here, and its own text is set aside until it answers.)
    expect(tabs.s1.status.choose).toBe('tabs');
    expect(Object.keys((await readKept(tabs.origin))!.asides ?? {})).toHaveLength(1);
    await tabs.s1.keepMine();
    expect((await readKept(tabs.origin))!.asides).toBeUndefined();
    await type(tabs.s2, 'ui/third.ui', 'third', 'third from two');
    expect(tabs.s2.status.choose).toBe('tabs');
    await type(tabs.s2, 'ui/third.ui', 'third from two', 'third');
    await tabs.s2.takeTheirs();
    expect(tabs.s2.changedElsewhere()).toBe(false);
    expect((await readKept(tabs.origin))!.asides).toBeUndefined();
    // Discarded, in the tab that was asked or in the other.
    await type(tabs.s1, 'ui/main.ui', '>One again<', '>One once more<');
    await type(tabs.s2, 'ui/other.ui', 'other from two', 'other from two, more');
    expect(Object.keys((await readKept(tabs.origin))!.asides ?? {})).toHaveLength(1);
    await tabs.s1.discard();
    expect(await readKept(tabs.origin)).toBeNull();
    await Promise.all([tabs.s1.close(), tabs.s2.close()]);

    // The app removed from Home (App.tsx, handleRemove).
    resetFakeIdb();
    resetAppCacheAvailability();
    resetDraftStore();
    localStorage.clear();
    tabs = await twoTabs();
    await type(tabs.s1, 'ui/main.ui', '>Notes<', '>One<');
    await type(tabs.s2, 'ui/main.ui', '>Notes<', '>Two<');
    expect(Object.keys((await readKept(tabs.origin))!.asides ?? {})).toHaveLength(1);
    await forgetEdits(tabs.origin);
    expect(await readKept(tabs.origin)).toBeNull();
  });

  it('does not pile up from tabs that never came back: the newest four for an app, and none older than thirty days', async () => {
    const origin = 'softn-app-with-many-closed-tabs';
    const day = 24 * 60 * 60 * 1000;
    const start = Date.parse('2026-11-01T00:00:00Z');
    expect((await writeDraft({ origin, files: { 'ui/main.ui': '<p>kept</p>\n' }, removed: [], by: 'one' }, 0)).kept).toBe(true);
    for (let tab = 1; tab <= 6; tab++) await setAside(origin, `tab-${tab}`, { typed: { 'ui/main.ui': `<p>typed in tab ${tab}</p>\n` } }, start + tab * 1000);
    expect(Object.keys((await readKept(origin))!.asides ?? {}).sort()).toEqual(['tab-3', 'tab-4', 'tab-5', 'tab-6']);
    // A month on, another tab sets its own aside: the old ones go, whoever's they were.
    await setAside(origin, 'tab-7', { typed: { 'ui/main.ui': '<p>typed a month later</p>\n' } }, start + 31 * day);
    expect(Object.keys((await readKept(origin))!.asides ?? {})).toEqual(['tab-7']);
    // And a real write, later still, carries none that has gone stale.
    expect((await writeDraft({ origin, files: { 'ui/main.ui': '<p>kept again</p>\n' }, removed: [], by: 'one' }, (await readKept(origin))!.at, ['one'], start + 62 * day)).kept).toBe(true);
    expect((await readKept(origin))!.asides).toBeUndefined();
    // What is kept is the draft, as it was written.
    expect((await readKept(origin))!.files['ui/main.ui']).toBe('<p>kept again</p>\n');
  });
});

describe('an app’s address', () => {
  it('is its own for each of two apps the person renames to the same name', async () => {
    const app = runtime();
    const alpha = await app.open({ data: bundleOf({ 'ui/main.ui': MAIN.replace('Notes', 'Alpha page') }, { name: 'Alpha' }) });
    const beta = await app.open({ data: bundleOf({ 'ui/main.ui': MAIN.replace('Notes', 'Beta page') }, { name: 'Beta' }) });
    const a = await edit(app.editing, alpha.id);
    await type(a, 'manifest.json', '"name":"Alpha"', '"name":"Gamma"');
    await a.close();
    await tick(2);
    const b = await edit(app.editing, beta.id);
    await type(b, 'manifest.json', '"name":"Beta"', '"name":"Gamma"');
    await b.close();
    // Both tabs are open in the runtime. The address the runtime writes for each, and what a reload at it opens.
    const addressA = tabAddress(app.tab(alpha.id));
    const addressB = tabAddress(app.tab(beta.id));
    const opens = async (address: string): Promise<string> => {
      const found = await getCachedAppByAddress(address);
      return found?.origin === alpha.appId ? 'Alpha' : found?.origin === beta.appId ? 'Beta' : 'nothing';
    };
    expect({ addressA, reloadAtA: await opens(addressA), addressB, reloadAtB: await opens(addressB) }).toEqual({ addressA: '~Alpha', reloadAtA: 'Alpha', addressB: '~Beta', reloadAtB: 'Beta' });
    // Both are shown as Gamma, on their tabs and on Home.
    expect([app.tab(alpha.id).name, app.tab(beta.id).name, ...(await getCachedApps()).map((saved) => saved.name)]).toEqual(['Gamma', 'Gamma', 'Gamma', 'Gamma']);
    expect(await opens('~Gamma')).toBe('nothing');
  });

  it('still finds an app after another app is renamed to its name', async () => {
    const app = runtime();
    const tasks = await app.open({ data: bundleOf({ 'ui/main.ui': MAIN.replace('Notes', 'Tasks page') }, { name: 'Tasks' }) });
    await tick(2);
    const notes = await app.open({ data: bundleOf() });
    const session = await edit(app.editing, notes.id);
    await type(session, 'manifest.json', '"name":"Notes"', '"name":"Tasks"');
    await session.close();
    const address = tabAddress(app.tab(tasks.id));
    const found = await getCachedAppByAddress(address);
    expect({ address, reloadOpens: found?.origin === tasks.appId ? 'Tasks (itself)' : found?.origin === notes.appId ? 'THE RENAMED APP' : 'nothing' }).toEqual({ address, reloadOpens: 'Tasks (itself)' });
    expect(tabAddress(app.tab(notes.id))).toBe('~Notes');
  });

  it('is the bundle’s own name for a name written with spaces round it, and the app is not renamed back and forth', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf({}, { name: 'Notes' }) });
    const origin = tab.appId!;
    const session = await edit(app.editing, tab.id);
    await type(session, 'manifest.json', '"name":"Notes"', '"name":"  Notes  "');
    expect(session.status).toEqual({ kind: 'ok', text: 'Updated.' });
    const saved = (await getCachedAppByOrigin(origin))!;
    expect({ tab: app.tab(tab.id).name, home: saved.name, ownName: saved.ownName, address: tabAddress(app.tab(tab.id)) }).toEqual({ tab: 'Notes', home: 'Notes', ownName: undefined, address: '~Notes' });
    await session.close();
  });
});

describe('a second copy of an app', () => {
  it('is another app, though the first copy was renamed and its name looks free', async () => {
    const app = runtime();
    const data = bundleOf();
    const first = await app.open({ data, fromLink: true });
    const theirs = first.appId!;
    const one = await edit(app.editing, first.id);
    await type(one, 'ui/main.ui', '>Notes<', '>My first copy, an evening of work<');
    const copyOne = app.tab(first.id).appId!;
    expect(app.tab(first.id).name).toBe('Notes (my copy)');
    // The person gives their copy a name of their own.
    await type(one, 'manifest.json', 'Notes (my copy)', 'My notebook');
    expect(one.status).toEqual({ kind: 'ok', text: 'Updated.' });
    expect((await getCachedAppByOrigin(copyOne))?.name).toBe('My notebook');
    await one.close();
    app.close(first.id);
    // Later: the published app again, by its link, and a first change to it.
    const second = await app.open({ data, fromLink: true });
    expect(second.appId).toBe(theirs);
    const two = await edit(app.editing, second.id);
    await type(two, 'ui/main.ui', '>Notes<', '>A second try<');
    const now = app.tab(second.id);
    expect({
      sameIdentityAsFirstCopy: now.appId === copyOne,
      status: two.status.text,
      choose: two.status.choose ?? null,
      library: (await getCachedApps()).map((saved) => saved.name).sort(),
    }).toEqual({ sameIdentityAsFirstCopy: false, status: expect.stringContaining('This makes your own copy'), choose: null, library: ['My notebook', 'Notes', 'Notes (my copy 2)'] });
    // Nothing waits on a choice, so "Keep mine" has nothing to do; and the first copy holds what it held.
    await two.keepMine();
    expect((await readDraft(copyOne))!.files['ui/main.ui']).toContain('an evening of work');
    expect((await readDraft(now.appId!))!.files['ui/main.ui']).toContain('A second try');
    await two.close();
  });

  it('is another app even under the very name of the first: each copy carries a mark of its own', async () => {
    const data = bundleOf();
    // Two copies made with no knowledge of each other (the library's names are not there to ask).
    const blind: EditStore = { ...libraryStore, libraryNames: async () => [] };
    const app = runtime();
    const first = await app.open({ data, fromLink: true });
    const one = await edit(app.editing, first.id, blind);
    await type(one, 'ui/main.ui', '>Notes<', '>One<');
    const copyOne = app.tab(first.id).appId!;
    await one.close();
    app.close(first.id);
    const second = await app.open({ data, fromLink: true });
    const two = await edit(app.editing, second.id, blind);
    await type(two, 'ui/main.ui', '>Notes<', '>Two<');
    const copyTwo = app.tab(second.id).appId!;
    expect(app.tab(second.id).name).toBe('Notes (my copy)');
    expect(copyTwo).not.toBe(copyOne);
    expect(two.status.choose).toBeUndefined();
    const marks = await Promise.all([copyOne, copyTwo].map(async (origin) => JSON.parse(textOf((await getCachedAppByOrigin(origin))!.bundleData, 'manifest.json')).copy as string));
    expect(marks[0]).toMatch(/^[a-z0-9]{8,}$/);
    expect(marks[1]).not.toBe(marks[0]);
    expect((await readDraft(copyOne))!.files['ui/main.ui']).toContain('>One<');
    await two.close();
  });
});

describe('an answer to what an app asks', () => {
  it('given before answers were kept with their ask holds for what the bundle itself asks, a changed heading or not, and not for a changed ask', async () => {
    const ASKS = JSON.stringify({ permissions: { net: { enabled: true } } });
    const app = runtime();
    const data = bundleOf({ 'permission.json': ASKS });
    const tab = await app.open({ data });
    const origin = tab.appId!;
    // As recorded before this change: no declaration.
    await recordPermissionGrant(origin, { net: true });
    expect((await getCachedAppByOrigin(origin))?.grantedFor).toBeUndefined();
    app.close(tab.id);
    const saved = (await getCachedAppByOrigin(origin))!;
    const plain = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    const plainAsked = plain.consent !== undefined;
    // The person changes a heading: nothing of what it asks.
    const session = await edit(app.editing, plain.id);
    await type(session, 'ui/main.ui', '>Notes<', '>Heading only<');
    await session.close();
    app.close(plain.id);
    const edited = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(edited.edited).toBe(true);
    // And an edit that changes what it asks, with the grant still on record (as when it could not be forgotten).
    const again = await edit(app.editing, edited.id);
    const library = await getDB();
    const before = (await getCachedAppByOrigin(origin))!;
    await type(again, 'permission.json', '"net":{"enabled":true}', '"net":{"enabled":true,"allowed_hosts":["*"]}');
    await library.put('softn-apps', { ...(await getCachedAppByOrigin(origin))!, grantedPermissions: before.grantedPermissions, permissionsPromptedAt: before.permissionsPromptedAt });
    await again.close();
    app.close(edited.id);
    const widened = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect({ plainAsked, headingEditAsked: edited.consent !== undefined, widenedAsked: widened.consent !== undefined }).toEqual({ plainAsked: false, headingEditAsked: false, widenedAsked: true });
  });

  it('holds for exactly what it answered, however the keys are ordered: the same asks rewritten are not opened again or asked again', async () => {
    const app = runtime();
    const data = bundleOf({ 'permission.json': '{"permissions":{"net":{"enabled":true,"allowed_hosts":["a.example"]},"camera":{"enabled":true}}}' });
    const tab = await app.open({ data });
    const origin = tab.appId!;
    tab.consent!.onAllow();
    await tick(10);
    app.close(tab.id);
    const saved = (await getCachedAppByOrigin(origin))!;
    expect(saved.grantedFor).toBe(declarationKey({ permissions: { camera: { enabled: true }, net: { allowed_hosts: ['a.example'], enabled: true } } }));
    const again = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(again.consent).toBeUndefined();
    // The same asks written in another order and spacing: not a new ask.
    const session = await edit(app.editing, again.id);
    await type(session, 'permission.json', '{"permissions":{"net":{"enabled":true,"allowed_hosts":["a.example"]},"camera":{"enabled":true}}}', '{ "permissions": { "camera": { "enabled": true }, "net": { "allowed_hosts": ["a.example"], "enabled": true } } }');
    const reordered = app.tab(again.id);
    expect({ status: session.status.kind, asked: reordered.consent !== undefined }).toEqual({ status: 'ok', asked: false });
    expect(session.status.text).toBe('Updated.');
    expect((await getCachedAppByOrigin(origin))?.grantedPermissions).toEqual({ net: true, camera: true });
    // Opened again with the rewritten file laid over it: still not asked.
    await session.close();
    app.close(again.id);
    const third = await app.open({ data: saved.bundleData, cachedAppId: saved.id });
    expect(third.consent).toBeUndefined();
    // One more host is a new ask.
    const widening = await edit(app.editing, third.id);
    await type(widening, 'permission.json', '"allowed_hosts": ["a.example"]', '"allowed_hosts": ["a.example", "b.example"]');
    expect(widening.status.text).toMatch(/^Opened again: What it asks permission for changed/);
    await widening.close();
  });
});
