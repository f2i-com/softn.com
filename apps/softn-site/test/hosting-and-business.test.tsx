// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HomePage } from '../src/pages/HomePage';
import { DirectoryPage } from '../src/pages/DirectoryPage';
import { AppPage } from '../src/pages/AppPage';
import type { AppDetail, Category } from '../src/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATEGORIES: Category[] = [
  { id: 'business', name: 'Business Apps', description: 'Full-stack business operations apps', emoji: '🏢', status: 'core', suggested: false, apps: 29 },
  { id: 'games', name: 'Games', description: 'Things to play', emoji: '🎮', status: 'core', suggested: false, apps: 15 },
];

function makeApp(overrides: Partial<AppDetail> = {}): AppDetail {
  const slug = overrides.slug ?? 'brewdesk-cafe-ops';
  return {
    slug,
    name: 'BrewDesk',
    description: 'Turnkey cafe operations desk',
    author: 'SoftN',
    category: 'business',
    tags: ['hospitality', 'php', 'sqlite'],
    capabilities: [],
    storagePolicies: {},
    execution: 'worker',
    engine: 2,
    backendRuntime: 'php',
    hosting: {
      mode: 'hybrid',
      serverHosted: true,
      browserSupported: true,
      backendUrl: `/api/apps/${slug}/backend`,
      customBackendUrl: null,
      withholdBackend: false,
      sandbox: 'zipp-safe-sandbox',
    },
    trusted: false,
    version: 1,
    size: 242473,
    primary: '#0ea5e9',
    thumbnail: `/api/apps/${slug}/thumbnail`,
    thumbnailKind: 'icon',
    icon: `/api/apps/${slug}/icon`,
    runs: 12,
    launches: 15,
    remixes: 0,
    rating: { average: 4.8, count: 4 },
    comments: 0,
    parent: null,
    source: 'folder',
    external: null,
    createdAt: '2026-11-20T00:00:00Z',
    updatedAt: '2026-11-20T00:00:00Z',
    urls: {
      page: `/app/${slug}`,
      run: `/play/${slug}`,
      play: `/play/${slug}`,
      playLocal: `/play/${slug}?mode=local`,
      runtime: `/web/app/${slug}`,
      runtimeLocal: `/web/app/${slug}?mode=local`,
      backend: `/api/apps/${slug}/backend`,
      bundle: `/api/apps/${slug}/bundle.softn`,
      download: `/api/apps/${slug}/bundle.softn?download=1`,
      studio: `/studio/?open=%2Fapi%2Fapps%2F${slug}%2Fbundle.softn`,
      builder: `/builder/?open=%2Fapi%2Fapps%2F${slug}%2Fbundle.softn`,
      remix: `/publish?remix=${slug}`,
    },
    versions: [{ version: 1, manifestVersion: '1.0.0', size: 242473, sha256: 'a'.repeat(64), notes: '', createdAt: '2026-11-20T00:00:00Z', bundle: `/api/apps/${slug}/bundle.softn?v=1` }],
    ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 3 },
    remixList: [],
    lineage: [],
    storage: { collections: 0, records: 0, keys: 0, bytes: 0 },
    manifest: { main: 'index.html', version: '1.0.0', files: {} },
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('Business Apps category & flexible hosting UI', () => {
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

  it('HomePage shows Business Apps as a directory category pill and never fetches /business-demos/', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(JSON.stringify({ ok: true, apps: [makeApp()], page: 1, perPage: 24, total: 1, pages: 1, sort: 'trending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    act(() => root.render(<HomePage categories={CATEGORIES} categoriesError={null} onRetryCategories={() => {}} />));
    await settle();

    const bizPill = [...container.querySelectorAll<HTMLAnchorElement>('.hero-pills a')].find((a) => a.getAttribute('href') === '/apps?category=business');
    expect(bizPill).toBeTruthy();
    expect(bizPill?.textContent).toContain('Business Apps');
    expect(container.textContent).toContain('BrewDesk');
    expect(requestedUrls.some((u) => u.includes('business-demos'))).toBe(false);
  });

  it('DirectoryPage renders hosting filter pills and sends hosting query param to /api/apps', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(JSON.stringify({ ok: true, apps: [makeApp()], page: 1, perPage: 24, total: 1, pages: 1, sort: 'trending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    act(() =>
      root.render(
        <DirectoryPage
          route={{ path: '/apps', query: new URLSearchParams('category=business&hosting=server') }}
          categories={CATEGORIES}
          categoriesError={null}
          onRetryCategories={() => {}}
        />
      )
    );
    await settle();

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button.pill-hosting')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Runs in browser', 'Hosted on SoftN', 'Hosted + Local', 'Includes backend']);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(requestedUrls.some((u) => u.includes('category=business') && u.includes('hosting=server'))).toBe(true);
  });

  it('AppPage shows Play hosted + Run locally in browser for hybrid apps', async () => {
    const app = makeApp();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rating')) return new Response(JSON.stringify({ ok: true, rating: { average: 4.8, count: 4, mine: null } }), { status: 200 });
      if (url.includes('/comments')) return new Response(JSON.stringify({ ok: true, comments: [], page: 1, perPage: 20, total: 0, pages: 1 }), { status: 200 });
      if (url.includes('/api/apps?')) return new Response(JSON.stringify({ ok: true, apps: [], page: 1, perPage: 9, total: 0, pages: 1, sort: 'trending' }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, app }), { status: 200 });
    }) as typeof fetch;

    act(() => root.render(<AppPage slug={app.slug} categories={CATEGORIES} route={{ path: `/app/${app.slug}`, query: new URLSearchParams() }} />));
    await settle();

    const playBtn = [...container.querySelectorAll('button')].find((b) => /Play hosted/i.test(b.textContent ?? ''));
    expect(playBtn).toBeTruthy();
    const localLink = [...container.querySelectorAll<HTMLAnchorElement>('a')].find((a) => /Run locally in browser/i.test(a.textContent ?? ''));
    expect(localLink?.getAttribute('href')).toContain('mode=local');
    expect(container.textContent).toContain('How it runs');
  });

  it('AppPage shows browser sandbox details for browser-hosted apps', async () => {
    const app = makeApp({
      hosting: {
        mode: 'browser',
        serverHosted: false,
        browserSupported: true,
        backendUrl: null,
        customBackendUrl: null,
        withholdBackend: false,
        sandbox: 'browser-wasm-sandbox',
      },
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rating')) return new Response(JSON.stringify({ ok: true, rating: { average: 4.8, count: 4, mine: null } }), { status: 200 });
      if (url.includes('/comments')) return new Response(JSON.stringify({ ok: true, comments: [], page: 1, perPage: 20, total: 0, pages: 1 }), { status: 200 });
      if (url.includes('/api/apps?')) return new Response(JSON.stringify({ ok: true, apps: [], page: 1, perPage: 9, total: 0, pages: 1, sort: 'trending' }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, app }), { status: 200 });
    }) as typeof fetch;

    act(() => root.render(<AppPage slug={app.slug} categories={CATEGORIES} route={{ path: `/app/${app.slug}`, query: new URLSearchParams() }} />));
    await settle();

    expect(container.textContent).toContain('Browser sandbox · PHP');
    expect(container.textContent).not.toContain('Run locally in browser');
    expect(container.textContent).toContain('nothing executes on the server');
  });
});
