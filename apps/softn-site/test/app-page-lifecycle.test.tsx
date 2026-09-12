import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDetail, Rating } from '../src/lib/api';

const { getApp, getRating, rate } = vi.hoisted(() => ({ getApp: vi.fn(), getRating: vi.fn(), rate: vi.fn() }));
vi.mock('../src/lib/api', async () => ({
  ...await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api'),
  getApp, getRating, rate,
  listApps: async () => ({ items: [] }),
  getComments: async () => ({ items: [], pages: 1, total: 0 }),
}));
import { AppPage } from '../src/pages/AppPage';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
function app(slug: string): AppDetail {
  return {
    slug, name: slug, description: 'Example app', author: 'Example', category: 'tools', tags: [], capabilities: [], storagePolicies: {}, execution: 'main', trusted: false,
    version: 1, size: 100, primary: null, thumbnail: '', thumbnailKind: 'placeholder', icon: null, runs: 0, launches: 0, remixes: 0,
    rating: { average: 0, count: 0 }, comments: 0, parent: null, source: 'upload', external: null, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    urls: { page: `/app/${slug}`, run: '', play: '', runtime: '', bundle: '', download: '', studio: '', builder: '', remix: '' },
    versions: [], ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, remixList: [], lineage: [],
    storage: { collections: 0, records: 0, keys: 0, bytes: 0 }, manifest: null,
  };
}
async function render(slug: string): Promise<void> {
  await act(async () => root.render(<AppPage slug={slug} categories={[]} route={{ path: `/app/${slug}`, query: new URLSearchParams() }} />));
}
beforeEach(() => {
  vi.resetAllMocks();
  getApp.mockImplementation(async (slug: string) => app(slug));
  getRating.mockResolvedValue({ average: 0, count: 0, mine: null });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('app listing lifecycle', () => {
  it('keeps a newly submitted vote when the initial rating read finishes late', async () => {
    let finish!: (value: Rating) => void;
    getRating.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    rate.mockResolvedValue({ average: 5, count: 1, mine: 5 });
    await render('demo');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="5 stars"]')!.click());
    await act(async () => finish({ average: 0, count: 0, mine: null }));
    expect(container.querySelector('[aria-label="5 stars"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('does not let a pending rating restore an app after navigating away', async () => {
    let finish!: (value: Rating) => void;
    rate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render('first');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="5 stars"]')!.click());
    await render('second');
    await act(async () => finish({ average: 5, count: 1, mine: 5 }));
    expect(container.querySelector('h1')?.textContent).toBe('second');
    expect(container.querySelector('[aria-label="5 stars"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('ignores a stale detail response and its page title', async () => {
    let finish!: (value: AppDetail) => void;
    getApp.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render('first');
    await render('second');
    await act(async () => finish(app('first')));
    expect(container.querySelector('h1')?.textContent).toBe('second');
    expect(document.title).toBe('second — SoftN');
  });

  it('offers an in-place retry for a temporary app failure', async () => {
    getApp.mockRejectedValueOnce(new Error('Temporary outage'));
    await render('demo');
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry loading app')!;
    await act(async () => retry.click());
    expect(container.querySelector('h1')?.textContent).toBe('demo');
    expect(container.textContent).not.toContain('Temporary outage');
  });
});
