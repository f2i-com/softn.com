import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDetail, Rating } from '../src/lib/api';

const { getApp, getRating, rate, updateListing, keys } = vi.hoisted(() => ({ getApp: vi.fn(), getRating: vi.fn(), rate: vi.fn(), updateListing: vi.fn(), keys: {} as Record<string, string> }));
vi.mock('../src/lib/api', async () => ({
  ...await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api'),
  getApp, getRating, rate, updateListing,
  listApps: async () => ({ items: [] }),
  getComments: async () => ({ items: [], pages: 1, total: 0 }),
}));
vi.mock('../src/lib/keyStore', async () => ({
  ...await vi.importActual<typeof import('../src/lib/keyStore')>('../src/lib/keyStore'),
  savedKey: (slug: string) => keys[slug] ?? null,
}));
import { AppPage, breakdownAfterVote } from '../src/pages/AppPage';
import { ApiError } from '../src/lib/api';
import { applyMeta, metaFor } from '../src/lib/meta';
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
  for (const slug of Object.keys(keys)) delete keys[slug];
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

  it('says an unknown app is not found, in the title too, and asks for it not to be indexed under its own address', async () => {
    document.title = 'SoftN — create, refine and run your own apps';
    applyMeta(metaFor({ kind: 'app', slug: 'no-such-app' }));
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toContain('/app/no-such-app');
    getApp.mockRejectedValueOnce(new ApiError(404, 'No app is published under that name.'));
    await render('no-such-app');
    expect(container.querySelector('h1')?.textContent).toBe('No app is published under that name.');
    expect(document.title).toBe('App not found — SoftN');
    expect(document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content).toBe('noindex');
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).not.toContain('no-such-app');
    expect(document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content).not.toContain('no-such-app');
    // A real app's page puts its own head back.
    applyMeta(metaFor({ kind: 'app', slug: 'demo' }));
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
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

describe('the rating breakdown after a vote', () => {
  /** The bars' counts, by star. */
  const bars = () =>
    Object.fromEntries(
      [...container.querySelectorAll('.breakdown-row')].map((row) => [row.querySelector('.breakdown-n')?.textContent, Number(row.querySelector('.breakdown-count')?.textContent)]),
    );
  const vote = async (stars: number) => {
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${stars} star${stars === 1 ? '' : 's'}"]`)!.click());
  };

  it('counts a first vote under its star', async () => {
    rate.mockResolvedValue({ average: 4, count: 1, mine: 4 });
    await render('demo');
    expect(bars()).toEqual({ '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 });
    await vote(4);
    expect(bars()).toEqual({ '5': 0, '4': 1, '3': 0, '2': 0, '1': 0 });
  });

  it('moves a changed vote from its old star to the new one', async () => {
    getApp.mockImplementation(async (slug: string) => ({ ...app(slug), rating: { average: 4, count: 2 }, ratingBreakdown: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 1 } }));
    getRating.mockResolvedValue({ average: 4, count: 2, mine: 5 });
    rate.mockResolvedValue({ average: 2.5, count: 2, mine: 2 });
    await render('demo');
    await vote(2);
    expect(bars()).toEqual({ '5': 0, '4': 0, '3': 1, '2': 1, '1': 0 });
    expect(container.querySelector('.stat strong')?.textContent).toBe('2.5');
  });

  it('counts a vote as a first one by the count when the visitor’s earlier stars are not known yet', async () => {
    getRating.mockImplementation(() => new Promise(() => {}));
    rate.mockResolvedValue({ average: 3, count: 1, mine: 3 });
    await render('demo');
    await vote(3);
    expect(bars()['3']).toBe(1);
  });

  it('leaves the bars alone for a changed vote whose old star is not known', async () => {
    getApp.mockImplementation(async (slug: string) => ({ ...app(slug), rating: { average: 5, count: 1 }, ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 } }));
    getRating.mockImplementation(() => new Promise(() => {}));
    rate.mockResolvedValue({ average: 1, count: 1, mine: 1 });
    await render('demo');
    await vote(1);
    expect(bars()).toEqual({ '5': 1, '4': 0, '3': 0, '2': 0, '1': 0 });
  });
});

describe('breakdownAfterVote', () => {
  const empty = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  it('does nothing for a vote that did not change', () => {
    const b = { ...empty, '4': 2 };
    expect(breakdownAfterVote(b, 4, 4, false)).toBe(b);
  });
  it('never takes a bar below zero', () => {
    expect(breakdownAfterVote(empty, 2, 5, false)).toEqual({ ...empty, '5': 1 });
  });
});

describe('the remixes an owner hides', () => {
  const remix = (slug: string) => ({ slug, name: `${slug} remix`, author: 'Someone', createdAt: '2026-09-12T00:00:00Z' });
  const withRemixes = (slug: string, shown: string[], hidden: string[]): AppDetail => ({ ...app(slug), remixes: shown.length, remixList: shown.map(remix), hiddenRemixes: hidden });
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

  it('takes a remix off the page and puts it back, with the edit key', async () => {
    keys.demo = 'key-for-demo';
    getApp.mockResolvedValue(withRemixes('demo', ['fan', 'spam'], []));
    updateListing.mockImplementation(async (_slug: string, _key: string, fields: { hiddenRemixes: string[] }) =>
      withRemixes('demo', ['fan', 'spam'].filter((s) => !fields.hiddenRemixes.includes(s)), fields.hiddenRemixes));
    await render('demo');
    await act(async () => button('Hide spam remix from this page')!.click());
    expect(updateListing).toHaveBeenLastCalledWith('demo', 'key-for-demo', { hiddenRemixes: ['spam'] });
    expect(container.textContent).toContain('Hidden from this page by you');
    expect(button('Hide spam remix from this page')).toBeNull();
    await act(async () => button('Show spam on this page again')!.click());
    expect(updateListing).toHaveBeenLastCalledWith('demo', 'key-for-demo', { hiddenRemixes: [] });
    expect(button('Hide spam remix from this page')).not.toBeNull();
  });

  it('offers nothing to a visitor without the key', async () => {
    getApp.mockResolvedValue(withRemixes('demo', ['fan'], ['spam']));
    await render('demo');
    expect(container.textContent).toContain('fan remix');
    expect(button('Hide fan remix from this page')).toBeNull();
    expect(container.textContent).not.toContain('Hidden from this page');
  });
});