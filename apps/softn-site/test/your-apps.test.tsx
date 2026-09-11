/**
 * A listing refresh never deletes a publishing key.
 *
 * The "Your apps" section looks each saved slug up to show its card. It
 * used to turn every failed lookup into "not found" and forget the key for
 * every slug the lookups did not return — a 500, a rate limit, a dropped
 * connection or a reply that was not JSON while the page loaded deleted the
 * only proof of ownership of every app in the list. Pinned here: every
 * failure category leaves the key map byte-for-byte as it was; a confirmed
 * 404 shows the app as gone, with its key, and forgetting is a deliberate
 * click scoped to that one slug.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ApiError, forgetKey, importKeys, rememberKey, savedKeys, savedKeysUnreadable, type AppDetail } from '../src/lib/api';
import { YourApps, lookupOwnedApps } from '../src/pages/PublishPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEYS = 'softn.site.editKeys';
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

function detail(slug: string): AppDetail {
  return {
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    description: '',
    author: 'Someone',
    category: 'games',
    tags: [],
    capabilities: [],
    storagePolicies: {},
    execution: 'main',
    trusted: false,
    version: 2,
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
    source: 'upload',
    external: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    urls: { page: `/app/${slug}`, run: '', play: '', runtime: '', bundle: '', download: '', studio: '', builder: '', remix: '' },
    versions: [],
    ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    remixList: [],
    lineage: [],
    storage: { collections: 0, records: 0, keys: 0, bytes: 0 },
    manifest: null,
  };
}

let container: HTMLElement;
let root: Root;

function mount(lookup: (slug: string) => Promise<AppDetail>): void {
  act(() => {
    root.render(<YourApps lookup={lookup} />);
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(KEYS, JSON.stringify({ notes: KEY_A, snake: KEY_B }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const stored = () => localStorage.getItem(KEYS);

describe('lookupOwnedApps', () => {
  it('classifies a 404 as missing and everything else as unavailable, without throwing', async () => {
    const lookup = vi.fn(async (slug: string) => {
      if (slug === 'notes') return detail('notes');
      if (slug === 'gone') throw new ApiError(404, 'No such app.');
      if (slug === 'busy') throw new ApiError(429, 'Slow down.', 120);
      if (slug === 'broken') throw new ApiError(500, 'The directory answered 500.');
      throw new TypeError('Failed to fetch');
    });
    const result = await lookupOwnedApps(['notes', 'gone', 'busy', 'broken', 'offline'], undefined, lookup);
    expect(result.map((r) => r.state)).toEqual(['loaded', 'missing', 'unavailable', 'unavailable', 'unavailable']);
  });
});

describe('the Your apps listing', () => {
  it.each([
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 429', () => Promise.reject(new ApiError(429, 'Slow down.', 60))],
    ['a 500', () => Promise.reject(new ApiError(500, 'The directory answered 500.'))],
    ['a reply that was not JSON', () => Promise.reject(new ApiError(502, 'The directory is not available on this host.'))],
  ])('leaves both keys byte-for-byte unchanged when one lookup fails with %s', async (_what, fail) => {
    const before = stored();
    mount((slug) => (slug === 'notes' ? Promise.resolve(detail('notes')) : fail()));
    await settle();

    expect(stored()).toBe(before);
    expect(savedKeys()).toEqual({ notes: KEY_A, snake: KEY_B });
    // The app that loaded is shown; the one that did not keeps a row and a retry.
    expect(container.textContent).toContain('Notes');
    expect(container.textContent).toContain('snake');
    expect(container.textContent).toContain('could not be checked');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(true);
  });

  it('keeps the key when every lookup fails', async () => {
    const before = stored();
    mount(() => Promise.reject(new TypeError('Failed to fetch')));
    await settle();
    expect(stored()).toBe(before);
    expect(container.textContent).toContain('2 apps could not be checked');
  });

  it('shows a confirmed 404 as gone, with its key, and does not forget it by itself', async () => {
    const before = stored();
    mount((slug) => (slug === 'notes' ? Promise.resolve(detail('notes')) : Promise.reject(new ApiError(404, 'No such app.'))));
    await settle();

    expect(stored()).toBe(before);
    expect(container.textContent).toContain('Not in the directory any more');
    expect(container.textContent).toContain(KEY_B);
    const forget = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Forget this key');
    expect(forget).toBeDefined();
  });

  it('forgets a key only after an explicit confirmed click, and only that slug', async () => {
    mount((slug) => (slug === 'notes' ? Promise.resolve(detail('notes')) : Promise.reject(new ApiError(404, 'No such app.'))));
    await settle();

    const forget = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Forget this key')!;
    act(() => forget.click());
    // A warning and a second step, not a deletion.
    expect(savedKeys()).toEqual({ notes: KEY_A, snake: KEY_B });
    expect(container.textContent).toContain('cannot be recovered');

    const keep = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Keep it')!;
    act(() => keep.click());
    expect(savedKeys()).toEqual({ notes: KEY_A, snake: KEY_B });

    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Forget this key')!.click());
    const yes = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Yes, forget it')!;
    act(() => yes.click());
    await settle();
    expect(savedKeys()).toEqual({ notes: KEY_A });
  });

  it('says so, and touches nothing, when the stored map cannot be read', async () => {
    localStorage.setItem(KEYS, '{not json');
    mount(() => Promise.resolve(detail('notes')));
    await settle();
    expect(container.textContent).toContain('could not be read');
    expect(stored()).toBe('{not json');
  });
});

describe('the key store', () => {
  it('reports a blocked write instead of pretending the key was kept', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    try {
      expect(rememberKey('new', KEY_A)).toBe('blocked');
    } finally {
      Storage.prototype.setItem = original;
    }
    expect(savedKeys()).toEqual({ notes: KEY_A, snake: KEY_B });
  });

  it('refuses to replace a map it cannot read with a map holding one key', () => {
    localStorage.setItem(KEYS, '{not json');
    expect(savedKeysUnreadable()).toBe(true);
    expect(rememberKey('new', KEY_A)).toBe('unreadable');
    expect(forgetKey('notes')).toBe('unreadable');
    expect(localStorage.getItem(KEYS)).toBe('{not json');
  });

  it('forgets one slug and leaves the rest', () => {
    expect(forgetKey('notes')).toBe('stored');
    expect(savedKeys()).toEqual({ snake: KEY_B });
    expect(forgetKey('never-there')).toBe('stored');
    expect(savedKeys()).toEqual({ snake: KEY_B });
  });

  it('imports a backup entry by entry: bad entries rejected, held keys not replaced silently', () => {
    const result = importKeys(JSON.stringify({ format: 'softn-edit-keys', version: 1, keys: { notes: KEY_B, snake: KEY_B, fresh: 'c'.repeat(40), bad: 'nope', 'no slug!': KEY_A } }));
    expect(result.added).toEqual(['fresh']);
    expect(result.unchanged).toEqual(['snake']);
    expect(result.conflicts).toEqual(['notes']);
    expect(result.rejected).toEqual(['bad', 'no slug!']);
    expect(savedKeys()).toEqual({ notes: KEY_A, snake: KEY_B, fresh: 'c'.repeat(40) });
  });

  it('changes nothing for a file that is not a key map', () => {
    const before = stored();
    expect(importKeys('not json').rejected.length).toBe(1);
    expect(importKeys('[1,2]').rejected.length).toBe(1);
    expect(stored()).toBe(before);
  });
});
