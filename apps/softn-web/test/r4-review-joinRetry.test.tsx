/**
 * @vitest-environment jsdom
 *
 * Audit round 4: "Try again" on the card of a download that a second press
 * joined (App.tsx's openFromUrl).
 *
 * Round 3 made the card's "Try again" forget an address once another app is
 * asked for (retryOffer.test.tsx) and made a press on an app still
 * downloading join that download and show it (openJoin.test.tsx). The joining
 * press did not say which address it was, so the card its failure showed
 * still offered whatever was asked for before: Run Fieldnotes, Home, Run
 * Second, Home, Run Fieldnotes again, and Fieldnotes' download fails. "Try
 * again" asked for Second. Regression test: it failed on 0e839a1f.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

const listing = {
  ok: true,
  status: 200,
  text: async (): Promise<string> =>
    JSON.stringify({
      ok: true,
      apps: [
        { slug: 'fieldnotes', name: 'Fieldnotes', description: 'Notes', urls: { bundle: '/api/apps/fieldnotes/bundle.softn' }, external: null, thumbnail: '' },
        { slug: 'second', name: 'Second', description: 'Another', urls: { bundle: '/api/apps/second/bundle.softn' }, external: null, thumbnail: '' },
      ],
      total: 2,
      pages: 1,
      page: 1,
      perPage: 6,
    }),
} as unknown as Response;

/** Both bundles are slow; Fieldnotes' first download fails when the test says so, and Second's never arrives. */
function network() {
  let fail: () => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = () => reject(new TypeError('Failed to fetch'));
  });
  failed.catch(() => {});
  const downloads: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes('bundle.softn')) {
      downloads.push(href);
      if (href.includes('fieldnotes') && downloads.filter((d) => d.includes('fieldnotes')).length === 1) await failed;
      await new Promise(() => {});
    }
    if (href.includes('/api/apps?')) return listing;
    return { ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), json: async () => ({}), text: async () => '' } as unknown as Response;
  });
  return { fetch, fail: () => fail(), downloads };
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

const run = (name: string): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`[aria-label="Run ${name}"]`)!;
const home = (): void => act(() => container.querySelector<HTMLButtonElement>('.softn-frame-home')!.click());
const heading = (): string | null | undefined => container.querySelector('.softn-shell-error h2')?.textContent;
const action = (label: string): HTMLElement | undefined =>
  Array.from(container.querySelectorAll<HTMLElement>('.softn-shell-error-actions > *')).find((el) => el.textContent === label);

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

describe('the card of a download a second press joined', () => {
  it('offers to try again the app that failed, not one asked for in between', async () => {
    const net = network();
    vi.stubGlobal('fetch', net.fetch);
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();

    act(() => run('Fieldnotes').click());
    await settle();
    home();
    await settle();
    act(() => run('Second').click());
    await settle();
    home();
    await settle();
    // Fieldnotes again: it joins the download already running.
    act(() => run('Fieldnotes').click());
    await settle();
    const fieldnotes = (): number => net.downloads.filter((href) => href.includes('fieldnotes')).length;
    expect(fieldnotes()).toBe(1);

    net.fail();
    await settle();
    expect(heading()).toBe('The app couldn’t be downloaded');
    const retry = action('Try again');
    expect(retry).toBeDefined();

    act(() => retry!.click());
    await settle();
    // Fieldnotes is asked for again; Second, still on its way, is not what this card was about.
    expect(fieldnotes()).toBe(2);
  });
});
