/**
 * @vitest-environment jsdom
 *
 * The hosted backend an app from the directory is pointed at.
 *
 * The directory's API says where it is, and an app may name one of its own
 * there (softn-api's `backend_url`). The app's frontend then speaks to that
 * address through the runtime, which sends requests on its own origin with
 * what the browser holds for it: the visitor's cookies, for one. An address
 * on the runtime's own origin was used as it came, so an app that named
 * `/api/apps/<another>/backend`, or the site itself, spoke to that as the
 * visitor. The one address on this origin an app is pointed at is its own
 * hosted backend, `/api/apps/<slug>/backend`.
 *
 * Pinned here with the real open of a bundle over an in-memory library: the
 * address a tab is given, and the one its record keeps, for an open from the
 * directory and for an app opened again from Home whose record an earlier
 * build wrote.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';

vi.mock('idb', () => import('./helpers/fakeIdb'));

import { resetFakeIdb } from './helpers/fakeIdb';
import { getCachedApps, resetAppCacheAvailability } from '../src/lib/appCache';
import { getDB } from '../src/lib/appCacheDb';
import { hostedBackendUrl } from '../src/lib/hostedBackend';
import { openBundle, type OpenBundleHost, type OpenBundleRequest, type OpenTab } from '../src/lib/openBundle';

// See openFromUrl.test.ts: fflate needs bytes from its own realm.
const ascii = (text: string) => strToU8(text, true);

function bundleOf(name: string): Uint8Array {
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify({ name, version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } }),
    'ui/main.ui': '<logic src="../logic/main.logic" />\n<div class="page"><h1>Desk</h1></div>\n',
    'logic/main.logic': 'let count = 0\n',
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, ascii(text)])));
}

/** The runtime around an open, as far as an open asks of it; `open` answers the tab it made. */
function runtime() {
  let tabs: OpenTab[] = [];
  let active: string | null = null;
  const errors: Error[] = [];
  const set = <T>(update: T | ((before: T) => T), before: T): T => (typeof update === 'function' ? (update as (before: T) => T)(before) : update);
  const host: OpenBundleHost = {
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
  const open = async (request: Omit<OpenBundleRequest, 'fileName'>): Promise<OpenTab> => {
    const had = new Set(tabs.map((tab) => tab.id));
    const name = await openBundle(host, { fileName: 'app.softn', ...request });
    expect(errors.map((error) => error.message)).toEqual([]);
    expect(name).not.toBeNull();
    const opened = tabs.find((tab) => !had.has(tab.id))!;
    // One tab at a time here: the next open is of the app again, not a visit to its tab.
    tabs = [];
    return opened;
  };
  return { open };
}

/** The one record these tests keep. */
const record = async () => (await getCachedApps())[0];

beforeEach(() => {
  resetFakeIdb();
  resetAppCacheAvailability();
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the rule, for a runtime served at https://softn.example', () => {
  const at = (given: unknown, slug: string | undefined = 'desk') => hostedBackendUrl(given, slug, 'https://softn.example');

  it('takes the app’s own hosted backend, however it is written, as its path', () => {
    for (const own of ['/api/apps/desk/backend', '/api/apps/desk/backend/', 'https://softn.example/api/apps/desk/backend', 'HTTPS://SOFTN.EXAMPLE:443/api/apps/desk/backend/', '//softn.example/api/apps/desk/backend']) {
      expect(at(own), own).toBe('/api/apps/desk/backend');
    }
  });

  it('takes nothing else on its own origin', () => {
    for (const other of [
      '/api/apps/victim/backend',
      '/api/apps/desk',
      '/api/apps/desk/backend/items',
      '/api/apps/Desk/backend',
      '/api/apps/desk/%62ackend',
      '/api/apps/desk/backend#x',
      '/api/apps/desk/backend?',
      'api/apps/desk/backend/..',
      'https://softn.example',
      'https://user:secret@softn.example/api/apps/desk/backend',
      'https:softn.example/api/apps/victim/backend',
      ' /api/apps/victim/backend',
    ]) {
      expect(at(other), other).toBeNull();
    }
    // Its own path is some app's only for the app whose slug it is.
    expect(at('/api/apps/desk/backend', 'other')).toBeNull();
    expect(hostedBackendUrl('/api/apps/desk/backend', undefined, 'https://softn.example')).toBeNull();
    expect(at('/api/apps/../admin/backend', '..')).toBeNull();
  });

  it('takes an http(s) address elsewhere as it was given, and nothing that is not one', () => {
    for (const elsewhere of ['https://backend.example/api', 'http://softn.example/api', 'https://softn.example:8443/api', 'https://www.softn.example/api/apps/desk/backend']) {
      expect(at(elsewhere), elsewhere).toBe(elsewhere);
    }
    for (const none of ['', '   ', null, undefined, 42, {}, 'javascript:alert(1)', 'blob:https://softn.example/1', 'wss://backend.example/api', 'https://']) {
      expect(at(none), String(none)).toBeNull();
    }
  });
});

describe('the backend an app opened from the directory is given', () => {
  it('is its own hosted backend, and no other address on the runtime’s origin', async () => {
    const app = runtime();
    const data = bundleOf('Desk');
    const own = '/api/apps/desk/backend';

    const hosted = await app.open({ data, directorySlug: 'desk', backendUrl: own, fromLink: true });
    expect(hosted.backendUrl).toBe(own);
    expect((await record()).backendUrl).toBe(own);

    // What the directory would have to have been told by the app's publisher: each is this
    // origin, and none is this app's backend. The tab has no backend, and the record lets go
    // of the one it had, as it does when the directory says the app has none.
    for (const borrowed of [
      '/api/apps/victim/backend',
      '/api/apps',
      '/',
      `${window.location.origin}/api/apps/victim/backend`,
      `${window.location.origin}/api/admin`,
      '/api/apps/desk/backend/../../victim/backend',
      '/api/apps/desk/backendx',
      '/api/apps/desk/backend?as=another',
      '\\api\\apps\\victim\\backend',
      `//${window.location.host}/api/apps/victim/backend`,
    ]) {
      await app.open({ data, directorySlug: 'desk', backendUrl: own, fromLink: true });
      const tab = await app.open({ data, directorySlug: 'desk', backendUrl: borrowed, fromLink: true });
      expect(tab.backendUrl, borrowed).toBeUndefined();
      expect('backendUrl' in (await record()), borrowed).toBe(false);
    }

    // Its own, written in full, is its own: the tab is given the path.
    const inFull = await app.open({ data, directorySlug: 'desk', backendUrl: `${window.location.origin}${own}/`, fromLink: true });
    expect(inFull.backendUrl).toBe(own);
    expect((await record()).backendUrl).toBe(own);
  });

  it('may be a backend elsewhere, which the runtime reaches without the visitor’s session', async () => {
    const app = runtime();
    const tab = await app.open({ data: bundleOf('Desk'), directorySlug: 'desk', backendUrl: 'https://backend.example/api', fromLink: true });
    expect(tab.backendUrl).toBe('https://backend.example/api');
    expect((await record()).backendUrl).toBe('https://backend.example/api');
  });

  it('is none for an address that is no web address', async () => {
    const app = runtime();
    for (const odd of ['javascript:alert(1)', 'data:text/plain,backend', 'ftp://backend.example/api', 'https://']) {
      const tab = await app.open({ data: bundleOf('Desk'), directorySlug: 'desk', backendUrl: odd, fromLink: true });
      expect(tab.backendUrl, odd).toBeUndefined();
      expect('backendUrl' in (await record()), odd).toBe(false);
    }
  });
});

describe('an app opened again from Home', () => {
  it('is not pointed at an address on this origin that a record from an earlier build kept', async () => {
    // The record is written when an app is opened and read when it is opened again from Home,
    // with no directory to ask: one saved before the address was checked still holds it.
    const app = runtime();
    const data = bundleOf('Desk');
    await app.open({ data, directorySlug: 'desk', backendUrl: '/api/apps/desk/backend', fromLink: true });
    const saved = await record();
    const db = await getDB();
    await db.put('softn-apps', { ...saved, backendUrl: '/api/apps/victim/backend' });
    expect((await record()).backendUrl).toBe('/api/apps/victim/backend');

    // As App.tsx opens a card on Home: the record's bytes, its slug and the address it kept.
    const kept = await record();
    const tab = await app.open({ data: kept.bundleData, cachedAppId: kept.id, directorySlug: kept.directorySlug, backendUrl: kept.backendUrl });
    expect(tab.backendUrl).toBeUndefined();
    expect('backendUrl' in (await record())).toBe(false);
  });

  it('keeps its own hosted backend, and has none without a slug to say which that is', async () => {
    const app = runtime();
    const data = bundleOf('Desk');
    await app.open({ data, directorySlug: 'desk', backendUrl: '/api/apps/desk/backend', fromLink: true });
    const kept = await record();
    const again = await app.open({ data: kept.bundleData, cachedAppId: kept.id, directorySlug: kept.directorySlug, backendUrl: kept.backendUrl });
    expect(again.backendUrl).toBe('/api/apps/desk/backend');

    // A file of the person's own has no place in the directory, and so no backend there.
    const file = await app.open({ data: bundleOf('Loose'), backendUrl: '/api/apps/desk/backend' });
    expect(file.backendUrl).toBeUndefined();
  });
});
