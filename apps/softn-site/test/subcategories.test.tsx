// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DirectoryPage } from '../src/pages/DirectoryPage';
import { AppPage } from '../src/pages/AppPage';
import type { AppDetail, Category } from '../src/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATEGORIES: Category[] = [
  {
    id: 'games',
    slug: 'games',
    parent: null,
    name: 'Games',
    description: 'Things to play across 3D, arcade, strategy, story and retro',
    emoji: '🎮',
    status: 'core',
    suggested: false,
    apps: 22,
    directApps: 0,
    subcategories: [
      { id: 'games/3d', slug: '3d', parent: 'games', name: '3D & First-Person', description: '3D worlds and mazes', emoji: '🧊', status: 'core', suggested: false, apps: 3 },
      { id: 'games/arcade', slug: 'arcade', parent: 'games', name: 'Arcade & Comedy', description: 'Fast reflexes and comedy', emoji: '🕹️', status: 'core', suggested: false, apps: 6 },
      { id: 'games/puzzle', slug: 'puzzle', parent: 'games', name: 'Puzzle & Brain', description: 'Logic puzzles', emoji: '🧠', status: 'core', suggested: false, apps: 0 },
    ],
  },
  {
    id: 'tools',
    slug: 'tools',
    parent: null,
    name: 'Tools',
    description: 'Utilities',
    emoji: '🧰',
    status: 'core',
    suggested: false,
    apps: 3,
    directApps: 3,
    subcategories: [],
  },
];

function makeGame(overrides: Partial<AppDetail> = {}): AppDetail {
  const slug = overrides.slug ?? 'blockscape';
  return {
    slug,
    name: 'Blockscape',
    description: '3D voxel sandbox island',
    author: 'SoftN',
    category: 'games',
    subcategory: '3d',
    categoryPath: 'games/3d',
    tags: ['3d', 'sandbox'],
    capabilities: [],
    storagePolicies: {},
    execution: 'main',
    engine: 1,
    backendRuntime: null,
    trusted: false,
    version: 1,
    size: 12000,
    primary: '#38bdf8',
    thumbnail: `/api/apps/${slug}/thumbnail`,
    thumbnailKind: 'image',
    icon: null,
    runs: 50,
    launches: 60,
    remixes: 2,
    rating: { average: 4.9, count: 10 },
    comments: 0,
    parent: null,
    source: 'seed',
    external: null,
    createdAt: '2026-11-20T00:00:00Z',
    updatedAt: '2026-11-20T00:00:00Z',
    urls: {
      page: `/app/${slug}`,
      run: `/play/${slug}`,
      play: `/play/${slug}`,
      runtime: `/web/app/${slug}`,
      bundle: `/api/apps/${slug}/bundle.softn`,
      download: `/api/apps/${slug}/bundle.softn?download=1`,
      studio: `/studio/?open=%2Fapi%2Fapps%2F${slug}%2Fbundle.softn`,
      builder: `/builder/?open=%2Fapi%2Fapps%2F${slug}%2Fbundle.softn`,
      remix: `/publish?remix=${slug}`,
    },
    versions: [{ version: 1, manifestVersion: '1.0.0', size: 12000, sha256: 'a'.repeat(64), notes: '', createdAt: '2026-11-20T00:00:00Z', bundle: `/api/apps/${slug}/bundle.softn?v=1` }],
    ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 9 },
    remixList: [],
    lineage: [],
    storage: { collections: 0, records: 0, keys: 0, bytes: 0 },
    manifest: { main: 'ui/main.ui', version: '1.0.0', files: {} },
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe('Main categories and subcategories UI', () => {
  const originalFetch = globalThis.fetch;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    window.scrollTo = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });

  it('DirectoryPage renders non-empty subcategories under Games and passes subcategory param to /api/apps', async () => {
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response(JSON.stringify({ ok: true, apps: [makeGame()], page: 1, perPage: 24, total: 1, pages: 1, sort: 'trending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    act(() =>
      root.render(
        <DirectoryPage
          route={{ path: '/apps', query: new URLSearchParams('category=games&subcategory=3d') }}
          categories={CATEGORIES}
          categoriesError={null}
          onRetryCategories={() => {}}
        />,
      ),
    );
    await settle();

    // Requested both category=games and subcategory=3d
    expect(requested.some((u) => u.includes('category=games') && u.includes('subcategory=3d'))).toBe(true);

    // Subcategory row shows All Games, 3D & First-Person, Arcade & Comedy — hides empty Puzzle & Brain
    const subPills = [...container.querySelectorAll<HTMLAnchorElement>('.pills-sub a')].map((a) => a.textContent?.trim());
    expect(subPills).toContain('All Games · 22');
    expect(subPills).toContain('🧊 3D & First-Person · 3');
    expect(subPills).toContain('🕹️ Arcade & Comedy · 6');
    expect(subPills.some((t) => t?.includes('Puzzle'))).toBe(false);

    // Section heading shows main category › subcategory
    const headingText = container.querySelector('#all-apps-title')?.textContent ?? '';
    expect(headingText).toContain('Games');
    expect(headingText).toContain('3D & First-Person');

    // Card shows main category · subcategory
    const cardCat = container.querySelector('.app-card-cat')?.textContent ?? '';
    expect(cardCat).toContain('Games');
    expect(cardCat).toContain('3D & First-Person');
  });

  it('AppPage renders main category and subcategory links in breadcrumb', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rating')) {
        return new Response(JSON.stringify({ ok: true, rating: { average: 4.9, count: 10, mine: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/comments')) {
        return new Response(JSON.stringify({ ok: true, comments: [], page: 1, perPage: 20, total: 0, pages: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/apps?')) {
        return new Response(JSON.stringify({ ok: true, apps: [], page: 1, perPage: 9, total: 0, pages: 1, sort: 'trending' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, app: makeGame() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    act(() =>
      root.render(
        <AppPage slug="blockscape" categories={CATEGORIES} route={{ path: '/app/blockscape', query: new URLSearchParams() }} />,
      ),
    );
    await settle();

    const crumbLinks = [...container.querySelectorAll<HTMLAnchorElement>('.crumbs a')].map((a) => ({
      href: a.getAttribute('href'),
      text: a.textContent?.trim(),
    }));
    expect(crumbLinks).toContainEqual({ href: '/apps?category=games', text: '🎮 Games' });
    expect(crumbLinks).toContainEqual({ href: '/apps?category=games&subcategory=3d', text: '🧊 3D & First-Person' });
  });
});
