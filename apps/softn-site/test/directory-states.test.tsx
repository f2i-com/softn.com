/**
 * The directory off the happy path: an unknown route, a page number that
 * is not one, a list that fails to refresh, and a reply that arrives late.
 *
 * The site used to show the home page for any path it did not recognise,
 * so a mistyped link looked like the front door. `page=abc` was tolerated
 * by accident and `page=999` was sent to the API as it was; a failed
 * refresh threw away the list that was on screen; a slow reply for an
 * earlier search could land after a later one. Pinned here: unknown paths
 * get a not-found page with a way out; page values are bounded and the
 * address is corrected in place, never pushed; "no results" and "could not
 * load" are different messages with different actions; a superseded
 * request never paints; back/forward re-reads the filters from the URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppCard } from '../src/lib/api';

const listApps = vi.fn();
const getCategories = vi.fn();
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, listApps: (...args: unknown[]) => listApps(...args), getCategories: (...args: unknown[]) => getCategories(...args) };
});

import App from '../src/App';
import { DirectoryPage, parsePageParam } from '../src/pages/DirectoryPage';
import { selectPage } from '../src/lib/router';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function card(slug: string): AppCard {
  return {
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    description: '',
    author: 'SoftN',
    category: 'games',
    tags: [],
    capabilities: [],
    storagePolicies: {},
    execution: 'main',
    version: 1,
    size: 1000,
    primary: null,
    thumbnail: '',
    thumbnailKind: 'placeholder',
    icon: null,
    runs: 3,
    launches: 4,
    remixes: 0,
    rating: { average: 0, count: 0 },
    comments: 0,
    parent: null,
    source: 'seed',
    external: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    trusted: false,
    urls: { page: `/app/${slug}`, run: '', play: '', runtime: '', bundle: '', download: '', studio: '', builder: '', remix: '' },
  };
}

const reply = (items: AppCard[], page = 1, pages = 1) => ({ items, page, perPage: 24, total: items.length, pages, sort: 'trending' });

let container: HTMLElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function mountDirectory(search: string): void {
  window.history.replaceState({}, '', `/apps${search}`);
  act(() => {
    root.render(<DirectoryPage route={{ path: '/apps', query: new URLSearchParams(search) }} categories={[]} categoriesError={null} onRetryCategories={() => {}} />);
  });
}

function mountApp(path: string): void {
  window.history.replaceState({}, '', path);
  act(() => {
    root.render(<App />);
  });
}

beforeEach(() => {
  // jsdom has no layout; navigate() scrolls to the top.
  window.scrollTo = vi.fn();
  listApps.mockReset();
  getCategories.mockReset();
  getCategories.mockResolvedValue([]);
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('route selection', () => {
  it('owns exactly the SPA pages and sends everything else to not-found', () => {
    expect(selectPage('/')).toEqual({ kind: 'home' });
    expect(selectPage('/apps')).toEqual({ kind: 'directory' });
    expect(selectPage('/publish')).toEqual({ kind: 'publish' });
    expect(selectPage('/app/space-invaders')).toEqual({ kind: 'app', slug: 'space-invaders' });
    expect(selectPage('/app/sp%20ace')).toEqual({ kind: 'app', slug: 'sp ace' });
    expect(selectPage('/app/%E0')).toEqual({ kind: 'app', slug: '%E0' });
    expect(selectPage('/nothing-here')).toEqual({ kind: 'not-found' });
    expect(selectPage('/apps/extra')).toEqual({ kind: 'not-found' });
    expect(selectPage('/app')).toEqual({ kind: 'not-found' });
    expect(selectPage('/web')).toEqual({ kind: 'not-found' });
  });

  it('renders the not-found page, not the home page, for an unknown path', async () => {
    listApps.mockResolvedValue(reply([]));
    mountApp('/nothing-here');
    await settle();
    expect(container.textContent).toContain('There is no page at /nothing-here');
    expect(container.textContent).not.toContain('Open an app.');
    expect(document.title).toMatch(/not found/i);
    const hrefs = [...container.querySelectorAll('main a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/', '/apps', '/publish']));
    expect(listApps).not.toHaveBeenCalled();
  });
});

describe('the page parameter', () => {
  it('reads only a positive integer, and is 1 otherwise', () => {
    expect(parsePageParam(null)).toBe(1);
    expect(parsePageParam('abc')).toBe(1);
    expect(parsePageParam('-3')).toBe(1);
    expect(parsePageParam('0')).toBe(1);
    expect(parsePageParam('2.5')).toBe(1);
    expect(parsePageParam('1e3')).toBe(1);
    expect(parsePageParam(' 7')).toBe(1);
    expect(parsePageParam('7')).toBe(7);
    expect(parsePageParam('99999999999999999999')).toBe(1);
  });

  it('asks for page 1 when the address says page=abc, and corrects the address in place', async () => {
    listApps.mockResolvedValue(reply([card('notes')]));
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    mountDirectory('?q=snake&page=abc');
    await settle();
    expect(listApps).toHaveBeenCalledTimes(1);
    expect(listApps.mock.calls[0][0]).toMatchObject({ q: 'snake', page: 1 });
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalled();
    expect(window.location.search).toBe('?q=snake');
  });

  it('clamps a page past the last one after the reply says how many there are, without a history entry', async () => {
    listApps.mockImplementation(async (p: { page?: number }) => reply(p.page === 999 ? [] : [card('notes')], p.page, 3));
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    mountDirectory('?page=999');
    await settle();
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?page=3');
    // The out-of-range reply was not painted as an empty directory.
    expect(container.textContent).not.toContain('No app matches');
  });
});

describe('the list states', () => {
  it('says "no results" with a way to clear the search, distinct from a failure', async () => {
    listApps.mockResolvedValue(reply([]));
    mountDirectory('?q=zzz');
    await settle();
    expect(container.textContent).toContain('No app matches that yet.');
    expect(container.textContent).not.toContain('Could not load');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const clear = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Clear the search');
    expect(clear?.getAttribute('href')).toBe('/apps');
  });

  it('shows the not-loaded state before the first reply', () => {
    listApps.mockImplementation(() => new Promise(() => {}));
    mountDirectory('');
    expect(container.textContent).toContain('Loading…');
    expect(container.textContent).not.toContain('No app matches');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps the previous list and filters on a failed refresh, with a retry that recovers', async () => {
    let fail = false;
    listApps.mockImplementation(async (p: { q?: string }) => {
      if (fail) throw new Error('The directory answered 503.');
      return reply(p.q === 'notes' ? [card('notes')] : [card('snake')]);
    });
    mountDirectory('?q=snake');
    await settle();
    expect(container.textContent).toContain('Snake');

    fail = true;
    mountDirectory('?q=notes');
    await settle();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Could not load the apps.');
    expect(alert?.textContent).toContain('503');
    expect(container.textContent).not.toContain('No app matches');
    // What was on screen stays, and the search box shows what was asked for.
    expect(container.textContent).toContain('Snake');
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('notes');

    fail = false;
    const retry = [...alert!.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.click());
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Notes');
    expect(container.textContent).not.toContain('Snake');
  });

  it('never paints a reply for a search the visitor has moved past', async () => {
    const pending: Array<{ q: string; resolve: (r: unknown) => void }> = [];
    listApps.mockImplementation((p: { q?: string }) => new Promise((resolve) => pending.push({ q: p.q ?? '', resolve })));
    mountDirectory('?q=notes');
    mountDirectory('?q=snake');
    await settle();
    expect(pending.map((p) => p.q)).toEqual(['notes', 'snake']);
    await act(async () => {
      pending[1].resolve(reply([card('snake')]));
      await Promise.resolve();
    });
    await act(async () => {
      pending[0].resolve(reply([card('notes')]));
      await Promise.resolve();
    });
    await settle();
    expect(container.textContent).toContain('Snake');
    expect(container.textContent).not.toContain('Notes');
  });
});

describe('back and forward', () => {
  it('re-reads the filters from the address and asks for that list', async () => {
    listApps.mockImplementation(async (p: { q?: string; sort?: string; page?: number }) => reply(p.sort === 'runs' ? [] : p.q === 'notes' ? [card('notes')] : [card('snake')], p.page ?? 1, 3));
    mountApp('/apps?q=snake');
    await settle();
    expect(container.textContent).toContain('Snake');

    window.history.pushState({}, '', '/apps?q=notes&page=2');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(listApps.mock.calls.some((c) => c[0].q === 'notes' && c[0].page === 2)).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('notes');
    expect(container.textContent).toContain('Notes');
    expect(container.textContent).not.toContain('Snake');
  });
});

describe('search sorting and filter recovery', () => {
  function chooseSort(value: string): void {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Sort apps"]')!;
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('keeps Trending during a search, including page and category links', async () => {
    getCategories.mockResolvedValue([{ id: 'games', name: 'Games', emoji: '', apps: 3 }]);
    listApps.mockResolvedValue(reply([card('snake')], 1, 3));
    mountApp('/apps?q=snake');
    await settle();
    chooseSort('trending');
    await settle();
    expect(window.location.search).toBe('?q=snake&sort=trending');
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Sort apps"]')?.value).toBe('trending');
    expect(listApps.mock.lastCall?.[0]).toMatchObject({ q: 'snake', sort: 'trending' });
    expect(container.querySelector('a.page-next')?.getAttribute('href')).toBe('/apps?q=snake&sort=trending&page=2');
    const games = [...container.querySelectorAll<HTMLAnchorElement>('a.pill')].find((node) => node.textContent === 'Games · 3')!;
    expect(games.getAttribute('href')).toBe('/apps?q=snake&category=games&sort=trending');
    act(() => games.click());
    await settle();
    expect(listApps.mock.lastCall?.[0]).toMatchObject({ category: 'games', sort: 'trending' });
    chooseSort('relevance');
    await settle();
    expect(window.location.search).toBe('?q=snake&category=games');
    expect(listApps.mock.lastCall?.[0].sort).toBeUndefined();
  });

  it.each([
    ['/apps?sort=unknown', 'trending', ''],
    ['/apps?sort=relevance', 'trending', ''],
    ['/apps?q=snake&sort=unknown', 'relevance', '?q=snake'],
  ])('recovers an unsupported sort at %s without a history entry', async (url, sort, query) => {
    listApps.mockResolvedValue(reply([]));
    const push = vi.spyOn(window.history, 'pushState');
    mountApp(url);
    await settle();
    expect(window.location.search).toBe(query);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Sort apps"]')?.value).toBe(sort);
    expect(push).not.toHaveBeenCalled();
  });

  it('shows every active filter and removes only the chosen one while resetting pagination', async () => {
    listApps.mockResolvedValue(reply([card('notes')], 2, 3));
    mountApp('/apps?q=notes&category=games&author=Sam&tag=team&cap=nonet&sort=newest&page=2');
    await settle();
    const active = container.querySelector('[aria-label="Active filters"]')!;
    expect(active.querySelectorAll('a[aria-label^="Remove "]')).toHaveLength(5);
    const removeAuthor = active.querySelector<HTMLAnchorElement>('a[aria-label="Remove Author: Sam"]')!;
    act(() => removeAuthor.click());
    await settle();
    expect(window.location.search).toBe('?q=notes&category=games&tag=team&cap=nonet&sort=newest');
    expect(listApps.mock.lastCall?.[0]).toMatchObject({ q: 'notes', category: 'games', tag: 'team', cap: 'nonet', author: '', sort: 'newest', page: 1 });
    const clearAll = container.querySelector<HTMLAnchorElement>('a.directory-clear-filters')!;
    act(() => clearAll.click());
    await settle();
    expect(window.location.search).toBe('?sort=newest');
    expect(container.querySelector('[aria-label="Active filters"]')).toBeNull();
    // Choosing a sort should immediately lead with its results, not the featured shelf.
    expect(listApps.mock.calls.some(([params]) => params.sort === 'runs')).toBe(false);
  });

  it('marks a retry in progress and keeps the last results visibly busy', async () => {
    listApps.mockResolvedValueOnce(reply([card('snake')]));
    mountDirectory('?q=snake');
    await settle();
    listApps.mockRejectedValueOnce(new Error('offline'));
    mountDirectory('?q=notes');
    await settle();
    let finish!: (value: ReturnType<typeof reply>) => void;
    listApps.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    act(() => retry.click());
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toBe('Retrying…');
    expect(container.querySelector('.app-grid')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => { finish(reply([card('notes')])); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.app-grid')?.getAttribute('aria-busy')).toBe('false');
    expect(container.textContent).toContain('Notes');
  });

  it('offers the same sort-preserving clear action when no apps match', async () => {
    listApps.mockResolvedValue(reply([]));
    mountApp('/apps?q=missing&sort=newest');
    await settle();
    expect(container.querySelector('.directory-clear-filters')?.getAttribute('href')).toBe('/apps?sort=newest');
    const clear = [...container.querySelectorAll<HTMLAnchorElement>('.empty a')].find((link) => link.textContent === 'Clear the filters')!;
    expect(clear.getAttribute('href')).toBe('/apps?sort=newest');
    act(() => clear.click());
    await settle();
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Sort apps"]')?.value).toBe('newest');
  });
});
