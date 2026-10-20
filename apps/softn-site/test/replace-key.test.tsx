/**
 * Replacing an edit key, from the two places a person holds one.
 *
 * A key is a bearer secret: anyone who has it can publish over the app,
 * change or unpublish it, and act as its publisher in its storage. Until
 * October 2026 an app's markup could reach the site's `window`, where these
 * keys are kept, so a key kept in a browser that played someone else's app
 * may have been copied, and there was no way to replace one. Pinned here:
 * "Replace key" on the update page and in "Your apps" asks first, calls the
 * directory with the key held, keeps the new key in place of the old one
 * (never the old one over it), says the old key no longer works anywhere,
 * shows the new key once and offers a fresh backup; a refusal changes
 * nothing that is kept.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppDetail } from '../src/lib/api';

const { getApp, replaceKey } = vi.hoisted(() => ({ getApp: vi.fn(), replaceKey: vi.fn() }));
vi.mock('../src/lib/api', async () => ({
  ...(await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')),
  getApp,
  replaceKey,
}));

import { ApiError } from '../src/lib/api';
import { savedKeys } from '../src/lib/keyStore';
import { PublishPage, YourApps } from '../src/pages/PublishPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEYS = 'softn.site.editKeys';
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const KEY_NEW = 'c'.repeat(40);

function detail(slug: string): AppDetail {
  return {
    slug, name: slug[0].toUpperCase() + slug.slice(1), description: '', author: 'Someone', category: 'tools', tags: [], capabilities: [], storagePolicies: {}, execution: 'main', trusted: false,
    version: 1, size: 100, primary: null, thumbnail: '', thumbnailKind: 'placeholder', icon: null, runs: 0, launches: 0, remixes: 0,
    rating: { average: 0, count: 0 }, comments: 0, parent: null, source: 'upload', external: null, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    urls: { page: `/app/${slug}`, run: '', play: '', runtime: '', bundle: '', download: '', studio: '', builder: '', remix: '' },
    versions: [], ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, remixList: [], lineage: [],
    storage: { collections: 0, records: 0, keys: 0, bytes: 0 }, manifest: null,
  };
}

let container: HTMLElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const buttons = (within: ParentNode = container) => [...within.querySelectorAll('button')];
const button = (label: string, within: ParentNode = container) => {
  const found = buttons(within).find((b) => b.textContent === label);
  if (!found) throw new Error(`no button "${label}" in: ${buttons(within).map((b) => b.textContent).join(' | ')}`);
  return found;
};

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await settle();
}

/** Set a controlled input's value the way typing does. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mountUpdate(slug: string): Promise<void> {
  await act(async () => {
    root.render(
      <PublishPage
        route={{ path: '/publish', query: new URLSearchParams({ update: slug }) }}
        categories={[{ id: 'tools', name: 'Tools', emoji: '', description: '', apps: 1, suggested: false, status: 'approved' }]}
        onCategories={() => {}}
        categoriesError={null}
        onRetryCategories={() => {}}
      />,
    );
  });
  await settle();
}

const keyField = () => container.querySelector<HTMLInputElement>('input[placeholder^="40 characters"]')!;

beforeEach(() => {
  localStorage.clear();
  getApp.mockReset();
  getApp.mockImplementation(async (slug: string) => detail(slug));
  replaceKey.mockReset();
  replaceKey.mockImplementation(async (slug: string) => ({ editKey: KEY_NEW, app: detail(slug) }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Replace key on the update page', () => {
  it('asks first, then keeps the new key in place of the old one and says the old one is dead everywhere', async () => {
    localStorage.setItem(KEYS, JSON.stringify({ notes: KEY_A, snake: KEY_B }));
    await mountUpdate('notes');

    await click(button('Replace key'));
    expect(replaceKey).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/stops working/);

    await click(button('Yes, replace it'));
    expect(replaceKey).toHaveBeenCalledWith('notes', KEY_A);
    expect(savedKeys()).toEqual({ notes: KEY_NEW, snake: KEY_B });
    // The field holds the key that works now, so the next action uses it.
    expect(keyField().value).toBe(KEY_NEW);
    const said = container.querySelector('.key-replaced')!;
    expect(said.textContent).toMatch(/old key no longer works anywhere/);
    expect(said.textContent).toMatch(/other browsers/);
    expect(said.textContent).toMatch(/scripts/);
    expect(said.textContent).toMatch(/backups/);
    expect(said.textContent).toContain(KEY_NEW);
    expect(button('Download a new backup', said)).toBeDefined();
  });

  it('does not keep the new key when the person said not to and none was kept here, and says to copy it', async () => {
    await mountUpdate('notes');
    await type(keyField(), KEY_A);
    const keep = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(keep);
    expect(keep.checked).toBe(false);

    await click(button('Replace key'));
    await click(button('Yes, replace it'));
    expect(replaceKey).toHaveBeenCalledWith('notes', KEY_A);
    expect(savedKeys()).toEqual({});
    const said = container.querySelector('.key-replaced')!;
    expect(said.textContent).toContain(KEY_NEW);
    expect(said.textContent).toMatch(/not kept in this browser/);
    // A backup of this browser's keys would not hold it, so none is offered.
    expect(buttons(said).some((b) => b.textContent === 'Download a new backup')).toBe(false);
  });

  it('changes nothing that is kept when the directory refuses the key', async () => {
    localStorage.setItem(KEYS, JSON.stringify({ notes: KEY_A }));
    replaceKey.mockRejectedValue(new ApiError(403, 'That needs the edit key this app was published with.'));
    await mountUpdate('notes');
    await click(button('Replace key'));
    await click(button('Yes, replace it'));
    expect(savedKeys()).toEqual({ notes: KEY_A });
    expect(keyField().value).toBe(KEY_A);
    expect(container.querySelector('.key-replaced')).toBeNull();
    expect(container.textContent).toMatch(/does not open this app/);
  });
});

describe('Replace key in Your apps', () => {
  it('replaces the key of one row, keeps the rest, and offers a new backup', async () => {
    localStorage.setItem(KEYS, JSON.stringify({ notes: KEY_A, snake: KEY_B }));
    await act(async () => {
      root.render(<YourApps lookup={async (slug) => detail(slug)} />);
    });
    await settle();

    const row = [...container.querySelectorAll('li.yours-item')].find((li) => li.textContent?.includes('Notes'))!;
    await click(button('Replace key', row));
    expect(replaceKey).not.toHaveBeenCalled();
    await click(button('Yes, replace it', row));

    expect(replaceKey).toHaveBeenCalledWith('notes', KEY_A);
    expect(savedKeys()).toEqual({ notes: KEY_NEW, snake: KEY_B });
    const said = container.querySelector('.key-replaced')!;
    expect(said.textContent).toMatch(/old key no longer works anywhere/);
    expect(said.textContent).toContain(KEY_NEW);
    expect(button('Download a new backup', said)).toBeDefined();
    // The other app's key is still not printed.
    expect(container.textContent).not.toContain(KEY_B);
  });
});
