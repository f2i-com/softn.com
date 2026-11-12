/**
 * @vitest-environment jsdom
 *
 * The editor's code is fetched when it is asked for (src/edit/, three chunks
 * of the build), and a fetch can fail: the device is offline and the chunk
 * was never fetched, or a deployment replaced the hashed files while this
 * page stayed open. That is the editor's loss alone. Pressing Edit must not
 * take the runtime down, with every app running in it; and an app the person
 * has edited must still open, without their changes, and say so.
 *
 * A dynamic import that fails is stood in for by a module whose loading
 * throws, which is what the import of a missing chunk does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';

vi.mock('idb', () => import('./helpers/fakeIdb'));
vi.mock('../src/edit/EditPane', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/EditPane-BFCsvlqr.js');
});
vi.mock('../src/edit/drafts', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/drafts-Drt5MEbe.js');
});

import { resetFakeIdb } from './helpers/fakeIdb';
import { computeAppOrigin, resetAppCacheAvailability } from '../src/lib/appCache';
import { forgetEdits } from '../src/lib/editIndex';
import { openBundle, type OpenBundleHost, type OpenTab } from '../src/lib/openBundle';
import App from '../src/App';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom gaps @softn/components' ThemeProvider trips over on mount.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as unknown as MediaQueryList;
}

// See openFromUrl.test.ts: fflate needs bytes from its own realm.
const ascii = (text: string) => strToU8(text, true);
const BUNDLE = zipSync({
  'manifest.json': ascii(JSON.stringify({ name: 'Plain Page', version: '1.0.0', main: 'ui/main.ui' })),
  'ui/main.ui': ascii('<div class="page"><h1 id="title">Plain</h1></div>\n'),
});

function serve(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes('demos/index.json')) return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    if (!/\.softn(\?|$)/.test(href)) return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' } as unknown as Response;
    return { ok: true, status: 200, statusText: 'OK', url: href, headers: new Headers({ 'content-type': 'application/octet-stream' }), body: null, arrayBuffer: async () => BUNDLE.slice().buffer } as unknown as Response;
  });
}

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

beforeEach(() => {
  resetFakeIdb();
  resetAppCacheAvailability();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  vi.stubGlobal('fetch', serve());
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('a part of the editor that cannot be fetched', () => {
  it('leaves the running app on screen when Edit is pressed, puts the editor away, and says so', async () => {
    window.history.replaceState({}, '', '/?open=/demos/plain.softn');
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    for (let i = 0; i < 400 && !container.querySelector('.softn-runner-app #title'); i++) await settle(1);
    expect(container.querySelector('.softn-runner-app #title')?.textContent).toBe('Plain');
    const app = container.querySelector('.softn-runner-app #title');

    let thrown: unknown = null;
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.softn-frame-edit')!.click();
      });
      await settle(10);
    } catch (problem) {
      thrown = problem;
    }
    const left = {
      appStillDrawn: container.querySelector('.softn-runner-app #title') !== null,
      barStillDrawn: container.querySelector('.softn-frame-bar') !== null,
      runtimeMarkupLength: container.innerHTML.length,
      thrown: thrown instanceof Error ? thrown.message.slice(0, 80) : thrown,
    };
    // The same app, not one started again: its element is the one that was there.
    const sameApp = container.querySelector('.softn-runner-app #title') === app;
    const said = container.querySelector('.softn-shell-notice--over-app')?.textContent ?? '';
    // The line and its Dismiss are the runtime's own: an app is told of no press on them.
    const marked = container.querySelector('.softn-shell-notice--over-app')?.getAttribute('data-softn-host');
    const editPressed = container.querySelector('.softn-frame-edit')?.getAttribute('aria-pressed');
    const editorDrawn = container.querySelector('.softn-edit') !== null;

    // Pressed again, it is asked for again (and here fails again): not remembered as failed for good, and still nothing is lost.
    let again: unknown = null;
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.softn-frame-edit')?.click();
      });
      await settle(10);
    } catch (problem) {
      again = problem;
    }
    const afterSecond = { appStillDrawn: container.querySelector('.softn-runner-app #title') === app, thrown: again };

    try {
      act(() => root.unmount());
    } catch {
      // Already gone.
    }
    container.remove();
    expect(left).toEqual({ appStillDrawn: true, barStillDrawn: true, runtimeMarkupLength: expect.any(Number), thrown: null });
    expect({ sameApp, editPressed, editorDrawn }).toEqual({ sameApp: true, editPressed: 'false', editorDrawn: false });
    expect(said).toMatch(/^The editor could not be loaded just now/);
    expect(marked).toBe('');
    expect(afterSecond).toEqual({ appStillDrawn: true, thrown: null });
  }, 60_000);

  it('still opens an app the person edited, without their changes, and says that is what it did', async () => {
    let tabs: OpenTab[] = [];
    let active: string | null = null;
    const errors: string[] = [];
    const told: string[] = [];
    const set = <T,>(update: T | ((before: T) => T), before: T): T => (typeof update === 'function' ? (update as (before: T) => T)(before) : update);
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
        if (error) errors.push(error.message);
      },
      showOpening: () => {},
      hideOpening: () => {},
      appsChanged: () => {},
      notify: (text) => told.push(text),
      installOffline: () => {},
    };
    // From a file: the person's own. It opens.
    expect(await openBundle(host, { data: BUNDLE, fileName: 'plain.softn' })).toBe('Plain Page');
    expect(told).toEqual([]);
    tabs = [];
    // The person has edited it at some time: the index says there are changes to lay (lib/editIndex.ts).
    localStorage.setItem('softn.web.edited', JSON.stringify([await computeAppOrigin(BUNDLE)]));
    const opened = await openBundle(host, { data: BUNDLE, fileName: 'plain.softn' });
    expect({ opened, errors }).toEqual({ opened: 'Plain Page', errors: [] });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ edited: false, mine: true });
    expect(tabs[0].source).toContain('Plain');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/^This app is open without the changes you made to it in the editor/);
  });

  it('does not stop an app being removed: what the editor kept for it is asked for again another time', async () => {
    const origin = await computeAppOrigin(BUNDLE);
    localStorage.setItem('softn.web.edited', JSON.stringify([origin]));
    await expect(forgetEdits(origin)).resolves.toBeUndefined();
    expect(localStorage.getItem('softn.web.edited')).toBe('[]');
  });
});
