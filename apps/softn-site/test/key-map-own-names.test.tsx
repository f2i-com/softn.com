/**
 * The key map answers for the slugs it holds and for nothing else.
 *
 * The map is a plain object read with `[slug]`, and a plain object also
 * answers for the names every object inherits. A slug is whatever the
 * directory made of the app's name, so an app called "Constructor" has the
 * slug `constructor` — and `savedKeys()['constructor']` was the `Object`
 * function. Its page told every visitor "This browser holds the edit key",
 * its update page threw on the first render (`key.trim` on a function), and a
 * backup holding its real key was reported as a conflict and not restored.
 * `/publish?update=toString` threw the same way for any visitor at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppDetail } from '../src/lib/api';

const { getApp } = vi.hoisted(() => ({ getApp: vi.fn() }));
vi.mock('../src/lib/api', async () => ({
  ...(await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')),
  getApp,
  getRating: async () => ({ average: 0, count: 0, mine: null }),
  listApps: async () => ({ items: [] }),
  getComments: async () => ({ items: [], pages: 1, total: 0 }),
}));

import { forgetKey, importKeys, rememberKey, savedKey, savedKeys } from '../src/lib/keyStore';
import { AppPage } from '../src/pages/AppPage';
import { PublishPage } from '../src/pages/PublishPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

function detail(slug: string): AppDetail {
  return {
    slug, name: 'Constructor', description: 'Builds things', author: 'Someone', category: 'tools', tags: [], capabilities: [], storagePolicies: {}, execution: 'main', trusted: false,
    version: 1, size: 100, primary: null, thumbnail: '', thumbnailKind: 'placeholder', icon: null, runs: 0, launches: 0, remixes: 0,
    rating: { average: 0, count: 0 }, comments: 0, parent: null, source: 'upload', external: null, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    urls: { page: `/app/${slug}`, run: '', play: '', runtime: '', bundle: '', download: '', studio: '', builder: '', remix: '' },
    versions: [], ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, remixList: [], lineage: [],
    storage: { collections: 0, records: 0, keys: 0, bytes: 0 }, manifest: null,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  getApp.mockReset();
  getApp.mockImplementation(async (slug: string) => detail(slug));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the key map and the names every object has', () => {
  it('holds no key for a slug nobody stored one for, whatever the slug spells', () => {
    for (const slug of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(savedKey(slug), slug).toBeNull();
    }
    expect(Object.keys(savedKeys())).toEqual([]);
  });

  it('keeps, reads back and forgets the key of an app whose slug is constructor', () => {
    expect(rememberKey('constructor', KEY_A)).toBe('stored');
    expect(savedKey('constructor')).toBe(KEY_A);
    expect(forgetKey('constructor')).toBe('stored');
    expect(savedKey('constructor')).toBeNull();
  });

  it('restores such a key from a backup instead of calling it a conflict', () => {
    const result = importKeys(JSON.stringify({ format: 'softn-edit-keys', version: 1, keys: { constructor: KEY_A, snake: KEY_B } }));
    expect(result.conflicts).toEqual([]);
    expect(result.added).toEqual(['constructor', 'snake']);
    expect(savedKey('constructor')).toBe(KEY_A);
  });

  it('restores the key of an app whose slug is the name of a backup field', () => {
    // An app called "Version" or "Format" has that slug. The backup's own
    // fields were passed over by name inside its `keys` too, so their keys
    // were neither restored nor reported: the restore said nothing about them.
    const backup = JSON.stringify({ format: 'softn-edit-keys', version: 1, keys: { version: KEY_A, format: KEY_B } });
    const result = importKeys(backup);
    expect(result.added.sort()).toEqual(['format', 'version']);
    expect(savedKey('version')).toBe(KEY_A);
    expect(savedKey('format')).toBe(KEY_B);
    // A map at the top of the file (an older backup) still skips the two fields quietly.
    const top = importKeys(JSON.stringify({ format: 'softn-edit-keys', version: 1, snake: KEY_B }));
    expect(top.rejected).toEqual([]);
    expect(top.added).toEqual(['snake']);
  });

  it('does not tell every visitor that the app is theirs', async () => {
    await act(async () => root.render(<AppPage slug="constructor" categories={[]} route={{ path: '/app/constructor', query: new URLSearchParams() }} />));
    expect(container.querySelector('h1')?.textContent).toBe('Constructor');
    expect(container.textContent).not.toContain('This browser holds the edit key');
    expect(container.querySelector('a.cta-edit')).toBeNull();
  });

  it('knows the app is yours when the link spelled its name loosely', async () => {
    // The directory answers `/app/Space Invaders` with the app whose slug is
    // `space-invaders`, and the page moves the address there; the key kept for
    // that slug was looked up under the address's spelling, so the owner saw
    // "Yours to update?" and no Update button.
    getApp.mockImplementation(async () => ({ ...detail('space-invaders'), name: 'Space Invaders' }));
    rememberKey('space-invaders', KEY_A);
    await act(async () => root.render(<AppPage slug="Space Invaders" categories={[]} route={{ path: '/app/Space Invaders', query: new URLSearchParams() }} />));
    expect(container.querySelector('h1')?.textContent).toBe('Space Invaders');
    expect(container.querySelector<HTMLAnchorElement>('a.cta-edit')?.getAttribute('href')).toBe('/publish?update=space-invaders');
    expect(container.textContent).toContain('This browser holds the edit key');
  });

  it('opens the update page of such an app with an empty key field', async () => {
    for (const slug of ['constructor', 'toString']) {
      await act(async () =>
        root.render(
          <PublishPage
            key={slug}
            route={{ path: '/publish', query: new URLSearchParams({ update: slug }) }}
            categories={[]}
            onCategories={() => undefined}
            categoriesError={null}
            onRetryCategories={() => undefined}
          />,
        ),
      );
      const field = container.querySelector<HTMLInputElement>('input[placeholder^="40 characters"]');
      expect(field, slug).not.toBeNull();
      expect(field!.value).toBe('');
    }
  });
});
