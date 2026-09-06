/**
 * The front page when one directory request fails and the others do not.
 *
 * Categories, the featured shelf and the list are three requests. The page
 * used to treat a failed categories request as "the directory is down" and
 * skip the list, so an optional taxonomy endpoint could make a working
 * directory look empty. Pinned here: the apps and their Play links are shown
 * whatever the categories did; a failed list has its own retry; a
 * recovered endpoint does not need a reload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppCard } from '../src/lib/api';

const listApps = vi.fn();
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, listApps: (...args: unknown[]) => listApps(...args) };
});

import { HomePage, recallFeatured, rememberFeatured } from '../src/pages/HomePage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function card(slug: string, overrides: Partial<AppCard> = {}): AppCard {
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
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    urls: { page: `/app/${slug}`, run: '', bundle: '', download: '', studio: '', builder: '', remix: '' },
    ...overrides,
  };
}

const page = (items: AppCard[]) => ({ items, page: 1, perPage: 8, total: items.length, pages: 1, sort: 'trending' });

let container: HTMLElement;
let root: Root;

function mount(props: { categoriesError: string | null; onRetryCategories?: () => void }): void {
  act(() => {
    root.render(<HomePage categories={[]} categoriesError={props.categoriesError} onRetryCategories={props.onRetryCategories ?? (() => {})} />);
  });
}

async function settle(): Promise<void> {
  // Let the mocked requests resolve and React commit what they returned.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  listApps.mockReset();
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the front page with the categories request failed', () => {
  it('still asks for and shows the apps, with their Play links', async () => {
    listApps.mockImplementation(async (params: { sort?: string }) => page(params.sort === 'runs' ? [] : [card('notes'), card('snake')]));
    mount({ categoriesError: 'The directory answered 500.' });
    await settle();

    expect(listApps).toHaveBeenCalled();
    expect(container.textContent).toContain('Notes');
    expect(container.textContent).toContain('Snake');
    const plays = [...container.querySelectorAll('a[aria-label^="Play "]')];
    expect(plays.length).toBe(2);
    // The failure is a notice about categories, with a retry — not "the directory is not answering".
    expect(container.textContent).toContain('Categories could not be loaded');
    expect(container.textContent).not.toContain('The directory is not answering');
  });

  it('offers to retry the categories in place', async () => {
    listApps.mockImplementation(async () => page([card('notes')]));
    const onRetryCategories = vi.fn();
    mount({ categoriesError: 'boom', onRetryCategories });
    await settle();
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry' && b.closest('[role="status"]')?.textContent?.includes('Categories'));
    expect(retry).toBeDefined();
    act(() => retry!.click());
    expect(onRetryCategories).toHaveBeenCalledTimes(1);
  });
});

describe('the front page with only the list failed', () => {
  it('shows the list failure with its own retry, and recovers without a reload', async () => {
    let listFails = true;
    listApps.mockImplementation(async (params: { sort?: string }) => {
      if (params.sort === 'runs') return page([]);
      if (listFails) throw new Error('The directory answered 503.');
      return page([card('notes')]);
    });
    mount({ categoriesError: null });
    await settle();
    expect(container.textContent).toContain('This list could not be loaded');
    expect(container.textContent).not.toContain('Categories could not be loaded');

    listFails = false;
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    expect(retry).toBeDefined();
    act(() => retry!.click());
    await settle();
    expect(container.textContent).toContain('Notes');
    expect(container.textContent).not.toContain('could not be loaded');
  });
});

describe('the featured shelf during an outage', () => {
  it('shows the last shelf this browser saw, marked with when', async () => {
    rememberFeatured([card('pocket'), card('notes'), card('snake')], Date.UTC(2026, 8, 1));
    listApps.mockImplementation(async (params: { sort?: string }) => {
      if (params.sort === 'runs') throw new Error('offline');
      return page([]);
    });
    mount({ categoriesError: null });
    await settle();
    const shelf = container.querySelector('.hero-shelf');
    expect(shelf?.textContent).toContain('Pocket');
    expect(shelf?.textContent).toContain('This shelf is as it was on');
  });

  it('remembers a live shelf and shows it unmarked', async () => {
    listApps.mockImplementation(async (params: { sort?: string }) => page(params.sort === 'runs' ? [card('pocket'), card('notes'), card('snake'), card('doom')] : []));
    mount({ categoriesError: null });
    await settle();
    expect(container.querySelector('.hero-shelf')?.textContent).not.toContain('as it was on');
    expect(recallFeatured()?.items.map((a) => a.slug)).toContain('pocket');
  });

  it('ignores a remembered shelf that does not parse', () => {
    localStorage.setItem('softn.site.featured', '{not json');
    expect(recallFeatured()).toBeNull();
    localStorage.setItem('softn.site.featured', JSON.stringify({ at: 'yesterday', items: [] }));
    expect(recallFeatured()).toBeNull();
  });
});
