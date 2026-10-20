/**
 * The update page, where an app's owner changes it with the edit key.
 *
 * A bundle dropped beside the zone: the page-wide drop handler takes a file
 * dropped anywhere on a publish page and stashes it for "the form", and its
 * overlay says so. Only the new-app form took the stash. On the update page
 * the drop was swallowed — nothing appeared in the zone — and the file stayed
 * stashed until the visitor next opened the new-app form, which then showed
 * a bundle they had dropped somewhere else for something else.
 *
 * A screenshot the browser cannot decode: the picture is resized before
 * upload, and a file that is not the image its name says made that throw
 * with nobody listening, so choosing it did nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';
import type { AppDetail } from '../src/lib/api';

const { getApp, unpublish } = vi.hoisted(() => ({ getApp: vi.fn(), unpublish: vi.fn() }));
vi.mock('../src/lib/api', async () => ({
  ...(await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')),
  getApp,
  unpublish,
}));

import { ApiError } from '../src/lib/api';
import { savedKeys } from '../src/lib/keyStore';
import { PublishPage } from '../src/pages/PublishPage';
import { stashDroppedBundles, takeDroppedBundles } from '../src/lib/dropped';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function detail(slug: string): AppDetail {
  return {
    slug, name: 'Notes', description: 'Keeps notes', author: 'Someone', category: 'tools', tags: [], capabilities: [], storagePolicies: {}, execution: 'main', trusted: false,
    version: 1, size: 100, primary: null, thumbnail: '', thumbnailKind: 'placeholder', icon: null, runs: 0, launches: 0, remixes: 0,
    rating: { average: 0, count: 0 }, comments: 0, parent: null, source: 'upload', external: null, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    urls: { page: `/app/${slug}`, run: '', play: '', runtime: '', bundle: '', download: '', studio: '', builder: '', remix: '' },
    versions: [], ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, remixList: [], lineage: [],
    storage: { collections: 0, records: 0, keys: 0, bytes: 0 }, manifest: null,
  };
}

function bundleFile(name: string, fileName: string): File {
  const bytes = zipSync({
    'manifest.json': strToU8(JSON.stringify({ name, version: '2.0.0', description: 'A newer one', main: 'ui/main.ui' }), true),
    'ui/main.ui': strToU8('<App/>', true),
  });
  return new File([bytes as BlobPart], fileName, { type: 'application/zip' });
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

beforeEach(() => {
  localStorage.clear();
  takeDroppedBundles();
  getApp.mockReset();
  getApp.mockImplementation(async (slug: string) => detail(slug));
  unpublish.mockReset();
  // jsdom's File has no arrayBuffer(); FileReader does the job.
  Object.defineProperty(File.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value(this: File) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (File.prototype as unknown as { arrayBuffer?: unknown }).arrayBuffer;
  vi.unstubAllGlobals();
});

describe('the update page', () => {
  it('takes a bundle dropped beside its zone as the new version, and leaves none stashed', async () => {
    await mountUpdate('notes');
    expect(container.querySelector('h1')?.textContent).toBe('Notes');

    // What the page-wide handler does with a drop that missed the zone.
    act(() => {
      stashDroppedBundles([bundleFile('Notes', 'notes-next.softn'), bundleFile('Other', 'other.softn')]);
    });
    await settle();

    const zone = container.querySelector('.dropzone')!;
    expect(zone.textContent).toContain('notes-next.softn');
    expect(zone.textContent).toContain('Notes v2.0.0');
    // Nothing is left for the new-app form to find later.
    expect(takeDroppedBundles()).toEqual([]);
  });

  it('says so when the chosen screenshot cannot be read as a picture', async () => {
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new DOMException('The source image could not be decoded.', 'InvalidStateError')));
    await mountUpdate('notes');
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept^="image/"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['not a png'], 'shot.png', { type: 'image/png' })], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/could not be read as a picture/i);
    const use = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Use this picture')!;
    expect(use.disabled).toBe(true);
  });

  it('forgets the key of an app it unpublished, with "Keep it in this browser" checked', async () => {
    // Every action stored the key it used once it succeeded, unpublishing
    // included: the key was forgotten and then written straight back, so
    // "Your apps" listed the app as gone with a key that opened nothing.
    localStorage.setItem('softn.site.editKeys', JSON.stringify({ notes: 'a'.repeat(40), other: 'b'.repeat(40) }));
    unpublish.mockResolvedValue(undefined);
    // Unpublishing goes on to the directory, which scrolls; jsdom has no scrolling.
    vi.stubGlobal('scrollTo', vi.fn());
    await mountUpdate('notes');
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    const press = async (label: string) => {
      const b = [...container.querySelectorAll('button')].find((x) => x.textContent === label)!;
      await act(async () => {
        b.click();
      });
      await settle();
    };
    await press('Unpublish Notes');
    await press('Yes, unpublish it');
    expect(unpublish).toHaveBeenCalledWith('notes', 'a'.repeat(40));
    expect(savedKeys()).toEqual({ other: 'b'.repeat(40) });
  });

  it('offers to try again when the app could not be loaded, and loads it when asked', async () => {
    getApp.mockRejectedValueOnce(new ApiError(500, 'The directory answered 500.'));
    await mountUpdate('notes');
    expect(container.textContent).toContain('The directory answered 500.');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });
    await settle();
    expect(getApp).toHaveBeenCalledTimes(2);
    expect(container.querySelector('h1')?.textContent).toBe('Notes');
  });

  it('offers no retry for an app the directory says is not there', async () => {
    getApp.mockRejectedValue(new ApiError(404, 'No such app.'));
    await mountUpdate('gone');
    expect(container.textContent).toContain('No such app.');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(false);
  });

  it('says the same on the form for a new app', async () => {
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new DOMException('The source image could not be decoded.', 'InvalidStateError')));
    await act(async () => {
      root.render(<PublishPage route={{ path: '/publish', query: new URLSearchParams() }} categories={[]} onCategories={() => {}} categoriesError={null} onRetryCategories={() => {}} />);
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept^="image/"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['not a png'], 'shot.png', { type: 'image/png' })], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/shot\.png could not be read as a picture/i);
    expect(container.querySelector('.thumb-preview')).toBeNull();
  });
});
