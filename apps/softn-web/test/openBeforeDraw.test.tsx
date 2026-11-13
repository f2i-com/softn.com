/**
 * @vitest-environment jsdom
 *
 * An app asked for by address whose bundle arrives before the page has drawn
 * again.
 *
 * Opening by address puts a placeholder tab in the tab list and starts the
 * download; when the bundle is in, the page asks whether that tab is still
 * open, and drops the bundle if it is not (the person closed it). The list it
 * asked was the last draw's. A bundle that arrived before the next draw (a
 * small file from a near server, one answered from a cache) found its own tab
 * missing, was taken for closed and dropped without a word, and the app sat at
 * "Opening…" for as long as the person waited. Seen in WebKit, about one first
 * opening in eight, 2026-11-13.
 *
 * The other tests of opening mount the page inside React's `act`, which draws
 * before anything else runs, so none of them could see it. Here the page is
 * left to draw when React's own scheduler gets to it, as in a browser, and the
 * network answers at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';
import App from '../src/App';

// Not an act environment: a draw waits its turn, as in a browser.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

// jsdom gaps @softn/components' ThemeProvider trips over on mount.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// See openFromUrl.test.ts: fflate needs bytes from its own realm.
const ascii = (text: string) => strToU8(text, true);

const BUNDLE = zipSync({
  'manifest.json': ascii(JSON.stringify({ name: 'Quick Notes', version: '1.0.0', main: 'ui/main.softn', files: { ui: ['ui/main.softn'] } })),
  'ui/main.softn': ascii('page Home {\n}\n'),
});

/** Keep the page's thread busy for `ms`, as a page that is starting up is. */
function busyFor(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Nothing: the time is the point.
  }
}

/**
 * A network that answers the bundle's address at once, with nothing to wait for; the directory's
 * list is down.
 *
 * The request is made in the same turn that queued the placeholder tab's draw. React draws what
 * is queued in that same turn only while the turn has been short (its scheduler gives way after
 * 5 ms), which a test's turn is and a real page's start is not. So the turn is made a long one
 * here, as it is in a browser: the draw then waits its turn, and the bundle, which has nothing to
 * wait for, is in first. Without this the test passes whether or not the fault is there.
 */
function instantNetwork(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes('demos/index.json')) return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    if (!/\.softn(\?|$)/.test(href)) return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' } as unknown as Response;
    busyFor(40);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: href,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body: null,
      arrayBuffer: async () => BUNDLE.slice().buffer,
    } as unknown as Response;
  });
}

let container: HTMLElement;
let root: Root;

const running = (): string[] => Array.from(container.querySelectorAll('.softn-launcher-run-name')).map((el) => el.textContent ?? '');
const opening = (): boolean => /Opening /.test(container.textContent ?? '');

/** Wait, in real time, until `ready` says so or `ms` have gone. */
async function until(ready: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return ready();
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  root.unmount();
  await new Promise((resolve) => setTimeout(resolve, 20));
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('a bundle that arrives before the page has drawn again', () => {
  it('opens: its own placeholder tab is not taken for one the person closed', async () => {
    const fetch = instantNetwork();
    vi.stubGlobal('fetch', fetch);
    window.history.replaceState({}, '', '/?open=/demos/Quick.softn');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(React.createElement(App));

    expect(await until(() => running().includes('Quick Notes'))).toBe(true);
    // Downloaded once, and nothing left saying it is still on its way.
    expect(fetch.mock.calls.filter(([input]) => /Quick\.softn/.test(String(input)))).toHaveLength(1);
    expect(opening()).toBe(false);
    expect(container.querySelector('.softn-shell-error')).toBeNull();
  });
});
