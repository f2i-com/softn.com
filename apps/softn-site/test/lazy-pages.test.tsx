/**
 * The pages fetched the first time they are visited (an app's page, the
 * publish page), as a visitor reaches them before their code has arrived.
 *
 * Each test loads the site afresh, so those pages are still loading when it
 * navigates; route-focus.test.tsx covers the pages already in the bundle.
 * jsdom focuses hidden elements as readily as shown ones, so focus is checked
 * by the page it landed in, not by its being a <main>.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    listApps: async () => ({ items: [], page: 1, perPage: 24, total: 0, pages: 1, sort: 'trending' }),
    getCategories: async () => [],
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** The site, loaded afresh at `/`, and its navigate. */
async function openSite(): Promise<(path: string) => void> {
  vi.resetModules();
  window.scrollTo = vi.fn();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  const { default: App } = await import('../src/App');
  const { navigate } = await import('../src/lib/router');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<App />));
  await settle();
  return navigate;
}

/** Waits for focus to land inside the page whose main carries this class. */
async function focusReaches(page: string): Promise<void> {
  await vi.waitFor(async () => {
    await settle();
    expect(document.activeElement?.closest(`main.${page}`)).not.toBeNull();
    expect(container!.contains(document.activeElement)).toBe(true);
  }, { timeout: 10_000 });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.doUnmock('../src/pages/AppPage');
  vi.restoreAllMocks();
});

describe('a page fetched on demand', () => {
  // The directory used to stay mounted, hidden, while the app's page loaded:
  // focus went to the directory's main, and once the app's page arrived the
  // path counted as handled and focus was lost with the directory.
  it('takes focus when it arrives after another page of the site', async () => {
    const navigate = await openSite();
    act(() => navigate('/apps'));
    await focusReaches('directory');
    act(() => navigate('/app/some-app'));
    await focusReaches('app-page');
  });

  // Two such pages in a row shared one Arrived, which never said the second had arrived.
  it('takes focus when it arrives after another page fetched on demand', async () => {
    const navigate = await openSite();
    act(() => navigate('/app/some-app'));
    await focusReaches('app-page');
    act(() => navigate('/publish'));
    await focusReaches('publish');
    expect(container!.querySelector('main.app-page')).toBeNull();
  });

  // Home's main is outside the boundary the publish page loads in: the move
  // to /publish found no main and waited, and the path then counted as
  // handled, so going back home before it arrived moved focus nowhere.
  it('gives focus to the page gone back to while it was still loading', async () => {
    const navigate = await openSite();
    act(() => navigate('/publish'));
    act(() => navigate('/'));
    await vi.waitFor(async () => {
      await settle();
      const main = container!.querySelector('main');
      expect(main?.className).toBe('');
      expect(document.activeElement).toBe(main);
    }, { timeout: 10_000 });
  });

  it('says it did not load when its code cannot be fetched, and the rest of the site stays', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('../src/pages/AppPage', () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    const navigate = await openSite();
    act(() => navigate('/app/some-app'));
    await vi.waitFor(async () => {
      await settle();
      expect(container!.textContent).toContain('This page did not load.');
    }, { timeout: 10_000 });
    expect(container!.querySelector('nav')).not.toBeNull();
    // Another page is drawn as usual.
    act(() => navigate('/apps'));
    await focusReaches('directory');
  });
});
