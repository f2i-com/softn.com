/**
 * @vitest-environment jsdom
 *
 * What the error card offers when an app asked for by address does not open.
 *
 * It said "Check your connection and the address, then try again" over one
 * button, "Back to home"; the address had been rewritten to the runtime's
 * home by then, so a reload did not try again either. Pinned here: a download
 * that failed can be asked for again from the card and opens when the network
 * is back; an address with nothing at it is sent to the directory instead; and
 * an app opened from a page of the site is offered the way back to that page.
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
  'manifest.json': ascii(JSON.stringify({ name: 'Flaky Notes', version: '1.0.0', main: 'ui/main.softn', files: { ui: ['ui/main.softn'] } })),
  'ui/main.softn': ascii('page Home {\n}\n'),
});

type Answer = 'offline' | 'missing' | 'bundle';

/** The bundle's address answers as the test says, in turn; the directory's list is down throughout. */
function network(answers: Answer[]): ReturnType<typeof vi.fn> {
  let asked = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes('demos/index.json')) return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    if (!/\.softn(\?|$)/.test(href)) return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' } as unknown as Response;
    const answer = answers[Math.min(asked, answers.length - 1)];
    asked += 1;
    if (answer === 'offline') throw new TypeError('Failed to fetch');
    if (answer === 'missing') {
      return { ok: false, status: 404, statusText: 'Not Found', url: href, headers: new Headers(), body: null } as unknown as Response;
    }
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

function mountAt(address: string): void {
  window.history.replaceState({}, '', address);
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(App));
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const card = (): Element | null => container.querySelector('.softn-shell-error');
const action = (label: string): HTMLElement | undefined =>
  Array.from(container.querySelectorAll<HTMLElement>('.softn-shell-error-actions > *')).find((el) => el.textContent === label);
const running = (): string[] => Array.from(container.querySelectorAll('.softn-launcher-run-name')).map((el) => el.textContent ?? '');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('an app asked for by address whose download failed', () => {
  it('can be asked for again from the card, and opens once the network is back', async () => {
    const fetch = network(['offline', 'bundle']);
    vi.stubGlobal('fetch', fetch);
    mountAt('/?open=/demos/Flaky.softn');
    await settle();

    expect(card()?.querySelector('h2')?.textContent).toBe('The app couldn’t be downloaded');
    const again = action('Try again');
    expect(again, 'the card offers what its words say to do').toBeDefined();
    // The one primary action is the one that may fix it.
    expect(again!.className).toContain('softn-shell-error-btn--primary');
    expect(action('Back to home')!.className).not.toContain('softn-shell-error-btn--primary');

    act(() => again!.click());
    await settle();

    expect(card()).toBeNull();
    expect(running()).toEqual(['Flaky Notes']);
    expect(fetch.mock.calls.filter(([input]) => /Flaky\.softn/.test(String(input)))).toHaveLength(2);
  });

  it('says so again, with the same offer, when asking again fails too', async () => {
    vi.stubGlobal('fetch', network(['offline']));
    mountAt('/?open=/demos/Flaky.softn');
    await settle();
    act(() => action('Try again')!.click());
    await settle();
    expect(card()?.querySelector('h2')?.textContent).toBe('The app couldn’t be downloaded');
    expect(action('Try again')).toBeDefined();
    expect(running()).toEqual([]);
  });

  it('forgets the address once the person has gone home', async () => {
    vi.stubGlobal('fetch', network(['offline']));
    mountAt('/?open=/demos/Flaky.softn');
    await settle();
    act(() => action('Back to home')!.click());
    await settle();
    expect(card()).toBeNull();
    expect(container.querySelector('.softn-launcher-title')).not.toBeNull();
  });
});

describe('an address with nothing at it', () => {
  it('is sent to the directory, and is not offered the same address again', async () => {
    vi.stubGlobal('fetch', network(['missing']));
    mountAt('/?open=/demos/Nope.softn');
    await settle();

    expect(card()?.querySelector('h2')?.textContent).toBe('This app wasn’t found');
    expect(action('Try again')).toBeUndefined();
    const browse = action('Browse apps') as HTMLAnchorElement | undefined;
    expect(browse?.getAttribute('href')).toBe('/apps');
    expect(browse!.className).toContain('softn-shell-error-btn--primary');
    expect(action('Back to home')).toBeDefined();
  });
});

describe('an app opened from a page of the site', () => {
  it('is offered the way back to that page, not the runtime’s home', async () => {
    vi.stubGlobal('fetch', network(['offline']));
    mountAt('/?open=/demos/Flaky.softn&back=%2Fapp%2Fflaky');
    await settle();

    const back = action('Go back') as HTMLAnchorElement | undefined;
    expect(back?.getAttribute('href')).toBe('/app/flaky');
    expect(action('Back to home')).toBeUndefined();
    expect(action('Try again')).toBeDefined();
  });
});
