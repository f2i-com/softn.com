/**
 * @vitest-environment jsdom
 *
 * A second press on an app whose download is still running joins that
 * download rather than starting another (App.tsx's openFromUrl). The press is
 * still the person's latest navigation: Run, Home, then Run again on the same
 * app has to show the app, as it does for an app saved on Home
 * (handleOpenCached). It used to join the download and leave the screen where
 * it was, so the press did nothing, and the app opened behind Home.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';
import App from '../src/App';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  'manifest.json': ascii(JSON.stringify({ name: 'Fieldnotes', version: '1.0.0', main: 'ui/main.softn', files: { ui: ['ui/main.softn'] } })),
  'ui/main.softn': ascii('page Home {\n}\n'),
});

const listing = {
  ok: true,
  status: 200,
  text: async (): Promise<string> =>
    JSON.stringify({
      ok: true,
      apps: [{ slug: 'fieldnotes', name: 'Fieldnotes', description: 'Notes', urls: { bundle: '/api/apps/fieldnotes/bundle.softn' }, external: null, thumbnail: '' }],
      total: 1,
      pages: 1,
      page: 1,
      perPage: 6,
    }),
} as unknown as Response;

/** The directory lists one app; its bundle arrives when the test lets it. */
function network() {
  let release: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const downloads: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes('bundle.softn')) {
      downloads.push(href);
      await arrived;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: href,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        body: null,
        arrayBuffer: async () => BUNDLE.slice().buffer,
      } as unknown as Response;
    }
    if (href.includes('/api/apps?')) return listing;
    return { ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), json: async () => ({}), text: async () => '' } as unknown as Response;
  });
  return { fetch, release: () => release(), downloads };
}

let container: HTMLElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Whether an app's tab is the one on screen: the bar over a running app is drawn for it alone. */
const appOnScreen = (): boolean => container.querySelector('.softn-frame-bar') !== null;
const run = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[aria-label="Run Fieldnotes"]')!;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('a second press on an app that is still downloading', () => {
  it('shows the app it joins: Run, Home, then Run again', async () => {
    const net = network();
    vi.stubGlobal('fetch', net.fetch);
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();
    expect(run()).toBeTruthy();

    act(() => run().click());
    await settle();
    expect(appOnScreen()).toBe(true);

    // Home, while the bundle is on its way.
    act(() => container.querySelector<HTMLButtonElement>('.softn-frame-home')!.click());
    await settle();
    expect(appOnScreen()).toBe(false);

    // The same app again: the download already running is the one it waits on.
    act(() => run().click());
    await settle();
    expect(net.downloads).toHaveLength(1);
    expect(appOnScreen()).toBe(true);

    net.release();
    await settle();
    expect(appOnScreen()).toBe(true);
    expect(container.querySelector('.softn-frame-name-label')?.textContent).toBe('Fieldnotes');
  });
});
