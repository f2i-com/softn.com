/**
 * The remembered featured shelf is read back as carefully as it is drawn.
 *
 * The front page keeps the last shelf the directory gave it in this
 * browser's storage and shows it when the directory is not answering. That
 * storage belongs to the origin, not to this page: Studio, Builder, the
 * runtime and anything that runs in them can write the same key. What was
 * read back was held to one thing — each item has a `slug` — and then drawn:
 * its page address into links, its picture address into images, its colour
 * into a style. So a stored item could put a `javascript:` address behind a
 * card on the front page, or a picture and a colour that call out to another
 * site, and one with nothing but a slug threw while drawing and left the
 * front page blank for as long as the directory was down.
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

import { HomePage, recallFeatured } from '../src/pages/HomePage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORE = 'softn.site.featured';

/** A card as the directory sends it (apps/softn-api/lib/apps.php, Apps::card). */
function card(slug: string, overrides: Record<string, unknown> = {}): AppCard {
  return {
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    description: 'Does a thing',
    author: 'SoftN',
    category: 'games',
    tags: [],
    capabilities: [],
    storagePolicies: {},
    execution: 'main',
    version: 1,
    size: 1000,
    primary: '#336699',
    thumbnail: `/api/apps/${slug}/thumbnail?v=1`,
    thumbnailKind: 'image',
    icon: null,
    runs: 3,
    launches: 4,
    remixes: 0,
    rating: { average: 4, count: 2 },
    comments: 0,
    parent: null,
    source: 'upload',
    external: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    trusted: false,
    urls: { page: `/app/${slug}`, run: `/play/${slug}`, play: `/play/${slug}`, runtime: '', bundle: '', download: '', studio: '', builder: '', remix: '' },
    ...overrides,
  } as AppCard;
}

const store = (items: unknown[]) => localStorage.setItem(STORE, JSON.stringify({ at: Date.UTC(2026, 8, 1), items }));
const recalled = () => (recallFeatured()?.items ?? []).map((a) => a.slug);

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  listApps.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the remembered shelf', () => {
  it('keeps the cards the directory sent, linked apps included', () => {
    store([card('pocket'), card('notes', { thumbnailKind: 'placeholder', thumbnail: '', primary: null }), card('trains', { external: { url: 'https://trains.example/play', host: 'trains.example' } })]);
    expect(recalled()).toEqual(['pocket', 'notes', 'trains']);
  });

  it('leaves out an item whose links are not this site’s page for it', () => {
    store([
      card('pocket'),
      card('one', { urls: { ...card('one').urls, page: 'javascript:alert(document.domain)' } }),
      card('two', { urls: { ...card('two').urls, page: 'https://elsewhere.example/app/two' } }),
      card('three', { urls: { ...card('three').urls, page: '//elsewhere.example/app/three' } }),
      card('four', { external: { url: 'javascript:alert(1)', host: 'softn.com' } }),
      card('five', { urls: null }),
    ]);
    expect(recalled()).toEqual(['pocket']);
  });

  it('leaves out an item whose picture or colour is not the directory’s', () => {
    store([
      card('pocket'),
      card('one', { thumbnail: 'https://elsewhere.example/seen.gif' }),
      card('two', { thumbnail: '//elsewhere.example/seen.gif' }),
      card('three', { primary: 'red, transparent), url(https://elsewhere.example/seen.gif' }),
      card('four', { thumbnailKind: 'video' }),
    ]);
    expect(recalled()).toEqual(['pocket']);
  });

  it('leaves out an item that is not a card at all', () => {
    store([card('pocket'), { slug: 'bare' }, card('one', { name: 7 }), card('two', { rating: null }), card('three', { runs: 'many' }), card('Not A Slug'), 'text', null]);
    expect(recalled()).toEqual(['pocket']);
  });

  it('draws the front page during an outage whatever was stored', async () => {
    store([{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }, card('pocket'), card('notes'), card('snake')]);
    listApps.mockImplementation(async (params: { sort?: string }) => {
      if (params.sort === 'runs') throw new Error('offline');
      return { items: [], page: 1, perPage: 8, total: 0, pages: 1, sort: 'trending' };
    });
    await act(async () => {
      root.render(<HomePage categories={[]} categoriesError={null} onRetryCategories={() => {}} />);
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    const shelf = container.querySelector('.hero-shelf');
    expect(shelf?.textContent).toContain('Pocket');
    expect(shelf?.textContent).toContain('This shelf is as it was on');
    const pages = [...shelf!.querySelectorAll('a.featured-link, a.featured-about')].map((a) => a.getAttribute('href'));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.every((href) => /^\/app\/(pocket|notes|snake)$/.test(href ?? ''))).toBe(true);
  });
});
