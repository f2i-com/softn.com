/**
 * What a visitor meets first, on the front page and on the Apps page.
 *
 * The front page began under two bars of links, and the list under its shelf
 * of five apps began with the same five. The Apps page began with that shelf
 * too, so its list started below the first screen, and each app in it was a
 * picture with no visible way to run it until a mouse was over it. A phone
 * had the filters as five rows. When the directory was down the page said so
 * twice, once for the categories and once for the list, with a Retry each.
 *
 * Pinned here: one bar; the hero's own three places; a list that leaves out
 * what the shelf shows; no shelf request on the Apps page; a Play link on
 * every row; the filters as fields; one notice for one failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppCard, Category } from '../src/lib/api';

const listApps = vi.fn();
const getCategories = vi.fn();
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, listApps: (...args: unknown[]) => listApps(...args), getCategories: (...args: unknown[]) => getCategories(...args) };
});

import App from '../src/App';
import { HomePage } from '../src/pages/HomePage';
import { DirectoryPage } from '../src/pages/DirectoryPage';
import { shelfApps } from '../src/components/directory/AppCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function card(slug: string, overrides: Partial<AppCard> = {}): AppCard {
  return {
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    description: `What ${slug} does`,
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
    runs: 0,
    launches: 0,
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
    ...overrides,
  };
}

const GAMES: Category = { id: 'games', name: 'Games', description: '', emoji: '', status: 'approved', suggested: false, apps: 3 };
const reply = (items: AppCard[]) => ({ items, page: 1, perPage: 24, total: items.length, pages: 1, sort: 'trending' });

let container: HTMLElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const listed = (): string[] => [...container.querySelectorAll('.app-grid a.app-card-name')].map((a) => a.textContent ?? '');

beforeEach(() => {
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

describe('the front page', () => {
  const shelf = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((slug) => card(slug, { runs: 9 }));
  const others = ['zeta', 'eta', 'theta', 'iota'].map((slug) => card(slug));

  it('has one bar, and the hero leads to its three places', async () => {
    listApps.mockResolvedValue(reply([]));
    window.history.replaceState({}, '', '/');
    act(() => root.render(<App />));
    await settle();

    expect(container.querySelectorAll('nav[aria-label="SoftN"]')).toHaveLength(1);
    expect(container.querySelector('nav[aria-label="On this page"]')).toBeNull();
    const hero = container.querySelector('#top')!;
    const places = [...hero.querySelectorAll<HTMLAnchorElement>('.hero-cta a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(places).toEqual([
      ['Explore all apps', '/apps'],
      ['Create an app', '#create'],
      ['How it works', '#how'],
    ]);
    // Each place the hero names is on the page.
    expect(container.querySelector('#create')).not.toBeNull();
    expect(container.querySelector('#how')).not.toBeNull();
  });

  it('lists more apps under the shelf, not the shelf’s own again', async () => {
    listApps.mockImplementation(async (params: { sort?: string }) => reply(params.sort === 'runs' ? shelf : [...shelf, ...others]));
    act(() => root.render(<HomePage categories={[]} categoriesError={null} onRetryCategories={() => {}} />));
    await settle();

    const onShelf = [...container.querySelectorAll('.hero-shelf a.featured-name')].map((a) => a.textContent);
    expect(onShelf).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
    expect(listed()).toEqual(['Zeta', 'Eta', 'Theta', 'Iota']);
    // Asked for enough that the list is still full once the shelf's apps are out of it.
    const asked = listApps.mock.calls.map(([params]) => params as { sort?: string; perPage?: number }).find((p) => p.sort === 'trending');
    expect(asked?.perPage).toBe(17);
  });

  it('keeps the list whole in a directory too small to have three more', async () => {
    const four = shelf.slice(0, 4);
    listApps.mockImplementation(async () => reply(four));
    act(() => root.render(<HomePage categories={[]} categoriesError={null} onRetryCategories={() => {}} />));
    await settle();
    // Four apps make a shelf of three; one more is not a list.
    expect(shelfApps(four).map((a) => a.slug)).toEqual(['alpha', 'beta', 'gamma']);
    expect(listed()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  it('says one thing, with one Retry for both, when the directory is down', async () => {
    listApps.mockRejectedValue(new Error('The directory is not available on this host.'));
    const onRetryCategories = vi.fn();
    act(() => root.render(<HomePage categories={[]} categoriesError="The directory is not available on this host." onRetryCategories={onRetryCategories} />));
    await settle();

    expect(container.textContent).toContain('This list could not be loaded');
    expect(container.textContent).not.toContain('Categories could not be loaded');
    const retries = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Retry');
    expect(retries).toHaveLength(1);
    const calls = listApps.mock.calls.length;
    act(() => retries[0].click());
    await settle();
    expect(onRetryCategories).toHaveBeenCalledTimes(1);
    expect(listApps.mock.calls.length).toBeGreaterThan(calls);
  });
});

describe('the Apps page', () => {
  function mount(search = '', props: { categories?: Category[]; categoriesError?: string | null; onRetryCategories?: () => void } = {}): void {
    window.history.replaceState({}, '', `/apps${search}`);
    act(() => {
      root.render(
        <DirectoryPage
          route={{ path: '/apps', query: new URLSearchParams(search) }}
          categories={props.categories ?? []}
          categoriesError={props.categoriesError ?? null}
          onRetryCategories={props.onRetryCategories ?? (() => {})}
        />,
      );
    });
  }

  it('is the list, with no shelf in front of it and a way to run each app on its row', async () => {
    listApps.mockResolvedValue(reply([card('alpha', { runs: 3 }), card('beta', { author: 'Sam', source: 'upload' })]));
    mount('', { categories: [GAMES] });
    await settle();

    expect(listApps.mock.calls.some(([params]) => (params as { sort?: string }).sort === 'runs')).toBe(false);
    expect(container.querySelector('.featured')).toBeNull();
    const rows = [...container.querySelectorAll('.app-card')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Play is a link of the row itself, not a child of its picture, and it is there without a pointer over it.
      const play = row.querySelector(':scope > a.app-card-play');
      expect(play?.getAttribute('aria-label')).toMatch(/^Play /);
      expect(play?.textContent).toBe('Play');
    }
    // What a visitor decides on, and nothing that says nothing: no count of zero.
    expect(rows[0].querySelector('.app-card-meta')?.textContent).toContain('3 runs');
    expect(rows[1].querySelector('.app-card-meta')?.textContent).not.toMatch(/\b0\b/);
    expect(rows[1].querySelector('.app-card-meta')?.textContent).toContain('Sam');
    expect(rows[1].querySelector('.app-card-official')).toBeNull();
    // An app that ships with the site and is by SoftN says SoftN once.
    expect(rows[0].querySelector('.app-card-author')?.textContent?.trim()).toBe('SoftN');
  });

  it('has what an app can reach as a field too, for a phone, and it filters the same list', async () => {
    listApps.mockResolvedValue(reply([card('alpha')]));
    mount();
    await settle();

    const reach = container.querySelector<HTMLSelectElement>('select[aria-label="Filter apps by what they can reach"]')!;
    expect([...reach.options].map((o) => o.value)).toEqual(['', 'nonet', 'none', 'storage', 'worker']);
    expect(reach.value).toBe('');
    act(() => {
      reach.value = 'storage';
      reach.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(window.location.search).toBe('?cap=storage');
  });

  it('shows the field with the filter that is on', async () => {
    listApps.mockResolvedValue(reply([card('alpha')]));
    mount('?cap=nonet');
    await settle();
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Filter apps by what they can reach"]')?.value).toBe('nonet');
    expect(container.querySelector('.pill-cap.on')?.textContent).toBe('No general network');
  });

  it('says one thing, with one Retry for both, when the directory is down', async () => {
    listApps.mockRejectedValue(new Error('The directory is not available on this host.'));
    const onRetryCategories = vi.fn();
    mount('', { categoriesError: 'The directory is not available on this host.', onRetryCategories });
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load the apps');
    expect(container.textContent).not.toContain('Categories could not be loaded');
    const retries = [...container.querySelectorAll('button')].filter((b) => /^Retry/.test(b.textContent ?? ''));
    expect(retries).toHaveLength(1);
    act(() => retries[0].click());
    await settle();
    expect(onRetryCategories).toHaveBeenCalledTimes(1);
  });

  it('still says the categories are missing when the list itself loaded', async () => {
    listApps.mockResolvedValue(reply([card('alpha')]));
    mount('', { categoriesError: 'The directory answered 500.' });
    await settle();
    expect(container.textContent).toContain('Categories could not be loaded');
    expect(listed()).toEqual(['Alpha']);
  });
});
