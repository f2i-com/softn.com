/**
 * @vitest-environment jsdom
 *
 * A bundle zipped as its folder (`Notes/manifest.json`, `Notes/ui/main.ui`,
 * …) opens as the folder's contents (runtime-shell's
 * unwrapContainerZipEntries): the tab's files are named without the folder.
 * The editor reads the bundle's own text again, and that read has to name its
 * files the way the open did, or every file is a change before anything was
 * typed, and the bundle it writes back mixes the two spellings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { AppRevision, AppUpdateResult, LiveApp } from '@softn/core';
import { readZip } from '@softn/runtime-shell/bundleProcessor';
import { unwrapContainerZipEntries } from '@softn/runtime-shell/containerBundle';

vi.mock('idb', () => import('./helpers/fakeIdb'));

import { resetFakeIdb } from './helpers/fakeIdb';
import { resetAppCacheAvailability } from '../src/lib/appCache';
import { openBundle, type OpenBundleHost, type OpenTab } from '../src/lib/openBundle';
import { resetDraftStore } from '../src/edit/drafts';
import type { EditHost } from '../src/edit/host';
import { EditSession } from '../src/edit/session';
import { bundleWith } from '../src/edit/bundle';

// See openFromUrl.test.ts: fflate needs bytes from its own realm.
const ascii = (text: string) => strToU8(text, true);

const MANIFEST = JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } });
const MAIN = '<logic src="../logic/main.logic" />\n<div class="page">\n  <h1 id="title">Notes</h1>\n</div>\n';
const LOGIC = 'let count = 0\n';
const PICTURE = Uint8Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 0xff);

/** The same app, zipped as its folder. */
const wrapped = zipSync({
  'Notes/manifest.json': ascii(MANIFEST),
  'Notes/ui/main.ui': ascii(MAIN),
  'Notes/logic/main.logic': ascii(LOGIC),
  'Notes/assets/dot.png': PICTURE,
});

/** A running app that takes every change it is handed. */
function standIn(): LiveApp {
  let shown: AppRevision | null = null;
  return {
    update: async (revision: AppRevision): Promise<AppUpdateResult> => {
      shown = revision;
      return { outcome: 'updated', changed: ['page'] };
    },
    restart: async (): Promise<AppUpdateResult> => ({ outcome: 'restarted', changed: [], reason: 'asked' }),
    get shown() {
      return shown ?? { source: '' };
    },
    get wanted() {
      return shown;
    },
  } as LiveApp;
}

function runtime() {
  let tabs: OpenTab[] = [];
  let active: string | null = null;
  const errors: Error[] = [];
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
    installOffline: () => {},
  };
  const editing: EditHost = {
    tab: (tabId) => tabs.find((tab) => tab.id === tabId),
    patch: (tabId, fields) => {
      tabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, ...fields } : tab));
    },
    reopen: async () => false,
    close: () => {},
    guardClose: () => () => {},
    libraryChanged: () => {},
    onAppUpdate: () => () => {},
  };
  const open = async (data: Uint8Array): Promise<OpenTab> => {
    const name = await openBundle(opening, { data, fileName: 'Notes.zip' });
    expect(errors.map((error) => error.message)).toEqual([]);
    expect(name).toBe('Notes');
    tabs = tabs.map((tab) => ({ ...tab, live: standIn() }));
    return tabs[tabs.length - 1];
  };
  return { open, editing, tab: (tabId: string) => tabs.find((tab) => tab.id === tabId)! };
}

/** The files a bundle opens with, as the runtime names them. */
function opened(bundle: Uint8Array): { texts: Map<string, string>; binaries: string[] } {
  const zip = readZip(bundle);
  const { textFiles, binaryFiles } = unwrapContainerZipEntries(zip.textFiles, zip.binaryFiles);
  return { texts: new Map(textFiles), binaries: [...binaryFiles.keys()].sort() };
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

describe('an app zipped as its folder, in the editor', () => {
  it('is the app as it was opened until something is typed, its files named as the tab names them', async () => {
    const app = runtime();
    const tab = await app.open(wrapped);
    expect(tab.textFiles?.has('manifest.json')).toBe(true);

    const session = (await EditSession.open(app.editing, tab.id, { pause: 0, makeLive: standIn }))!;
    expect(session.runningChanges()).toBe(false);
    expect(session.holding()).toBe(false);
    expect(session.entries().filter((entry) => entry.changed).map((entry) => entry.path)).toEqual([]);
    expect(session.entries().map((entry) => entry.path).sort()).toEqual(['assets/dot.png', 'logic/main.logic', 'manifest.json', 'ui/main.ui']);
    await session.close();
  });

  it('writes back a bundle that opens as the edited app, its picture where its pages look for it', async () => {
    const app = runtime();
    const tab = await app.open(wrapped);
    const session = (await EditSession.open(app.editing, tab.id, { pause: 0, makeLive: standIn }))!;
    session.type('ui/main.ui', MAIN.replace('>Notes<', '>My notes<'));
    await session.flush();
    expect(session.status.kind).toBe('ok');

    const bundle = (await session.bundle())!;
    const { texts, binaries } = opened(bundle);
    expect([...texts.keys()].sort()).toEqual(['logic/main.logic', 'manifest.json', 'ui/main.ui']);
    expect(texts.get('ui/main.ui')).toContain('My notes');
    expect(texts.get('logic/main.logic')).toBe(LOGIC);
    expect(binaries).toEqual(['assets/dot.png']);
    await session.close();
  });

  it('is written back with the tab’s files, wherever the bundle kept them', async () => {
    const edited = await bundleWith(wrapped, new Map([
      ['manifest.json', MANIFEST],
      ['ui/main.ui', MAIN.replace('>Notes<', '>Changed<')],
      ['logic/main.logic', LOGIC],
    ]));
    const { texts, binaries } = opened(edited);
    expect([...texts.keys()].sort()).toEqual(['logic/main.logic', 'manifest.json', 'ui/main.ui']);
    expect(texts.get('ui/main.ui')).toContain('Changed');
    expect(binaries).toEqual(['assets/dot.png']);
  });
});
