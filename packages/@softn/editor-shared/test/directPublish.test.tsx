// @vitest-environment jsdom
/**
 * Direct publishing from AI Studio and SoftN Builder:
 * - infers sensible starting categories & subcategories from manifest / project hints
 * - publishes a new app straight to POST /api/apps and persists edit keys in the shared store
 * - automatically switches to "Push new version" when the same project is re-opened and posts to
 *   POST /api/apps/:slug/versions with X-Edit-Key
 * - offers the standalone /publish fallback cleanly when the directory API is unreachable
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  AUTHOR_STORAGE_KEY,
  EDIT_KEYS_STORAGE_KEY,
  inferCategorySuggestion,
  savedEditorEditKeys,
  type DirectoryCategory,
} from '../src/directPublish';
import { PublishModal } from '../src/PublishModal';

const CATEGORIES: DirectoryCategory[] = [
  {
    id: 'games',
    name: 'Games',
    emoji: '🎮',
    description: 'Playable games',
    status: 'approved',
    suggested: false,
    apps: 12,
    subcategories: [
      { id: 'games/arcade', slug: 'arcade', parent: 'games', name: 'Arcade', emoji: '🕹️', description: '', status: 'approved', suggested: false, apps: 6 },
      { id: 'games/3d', slug: '3d', parent: 'games', name: '3D', emoji: '🧊', description: '', status: 'approved', suggested: false, apps: 3 },
    ],
  },
  {
    id: 'business',
    name: 'Business',
    emoji: '💼',
    description: 'Business tools',
    status: 'approved',
    suggested: false,
    apps: 8,
  },
  {
    id: 'tools',
    name: 'Tools',
    emoji: '🛠️',
    description: 'Utilities',
    status: 'approved',
    suggested: false,
    apps: 5,
  },
];

function makeBundle(manifest: Record<string, unknown>, extraFiles: Record<string, string> = {}): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({ name: 'Demo', version: '1.0.0', description: 'A demo app', main: 'ui/main.ui', ...manifest }), true),
    'ui/main.ui': strToU8('<App/>', true),
  };
  for (const [k, v] of Object.entries(extraFiles)) {
    entries[k] = strToU8(v, true);
  }
  return zipSync(entries);
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('inferCategorySuggestion', () => {
  it('prefers explicit manifest category and subcategory', () => {
    expect(
      inferCategorySuggestion(CATEGORIES, {
        name: 'Invoice Helper',
        manifestCategory: 'games',
        manifestSubcategory: '3d',
      }),
    ).toEqual({ category: 'games', subcategory: '3d' });
  });

  it('infers games/3d and business+backend heuristics when manifest omits category', () => {
    expect(
      inferCategorySuggestion(CATEGORIES, {
        name: 'Voxel 3D Racer Game',
        description: 'Fast 3d arcade racing game',
      }),
    ).toEqual({ category: 'games', subcategory: '3d' });

    expect(
      inferCategorySuggestion(CATEGORIES, {
        name: 'Shop Orders',
        description: 'Track customer orders',
        backendRuntime: 'php',
      }),
    ).toEqual({ category: 'business', subcategory: '' });
  });
});

describe('PublishModal', () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    globalThis.fetch = origFetch;
  });

  it('packages the bundle, publishes a new app directly, saves edit key, and auto-selects update on reopen', async () => {
    const editKey = 'a'.repeat(40);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/categories') {
        return new Response(JSON.stringify({ ok: true, categories: CATEGORIES }), { status: 200 });
      }
      if (url === '/api/apps' && init?.method === 'POST') {
        const fd = init.body as FormData;
        expect(fd.get('name')).toBe('Star Hopper');
        expect(fd.get('category')).toBe('games');
        expect(fd.get('subcategory')).toBe('arcade');
        return new Response(
          JSON.stringify({
            ok: true,
            app: {
              slug: 'star-hopper',
              name: 'Star Hopper',
              category: 'games',
              subcategory: 'arcade',
              version: 1,
              urls: { page: '/app/star-hopper', run: '/play/star-hopper' },
            },
            editKey,
            page: '/app/star-hopper',
          }),
          { status: 201 },
        );
      }
      if (url === '/api/apps/star-hopper/versions' && init?.method === 'POST') {
        expect((init.headers as Record<string, string>)['X-Edit-Key']).toBe(editKey);
        return new Response(
          JSON.stringify({
            ok: true,
            app: {
              slug: 'star-hopper',
              name: 'Star Hopper',
              category: 'games',
              subcategory: 'arcade',
              version: 2,
              urls: { page: '/app/star-hopper', run: '/play/star-hopper' },
            },
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: `Unexpected ${url}` }), { status: 404 });
    });

    const bytes = makeBundle({
      name: 'Star Hopper',
      description: 'Jump across stars',
      category: 'games',
      subcategory: 'arcade',
      author: 'Alex',
    });
    const onPublished = vi.fn();

    act(() =>
      root.render(
        <PublishModal
          isOpen={true}
          onClose={() => {}}
          projectKey="studio:proj-1"
          projectName="Star Hopper"
          projectDescription="Jump across stars"
          buildBundle={() => ({ bytes, fileName: 'star-hopper.softn' })}
          onPublished={onPublished}
        />,
      ),
    );
    await settle();

    const submitBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Publish app')!;
    expect(submitBtn).toBeDefined();
    expect(submitBtn.disabled).toBe(false);

    await act(async () => {
      submitBtn.click();
    });
    await settle();

    expect(host.textContent).toContain('Star Hopper is live!');
    expect(host.textContent).toContain('/app/star-hopper');
    expect(host.textContent).toContain(editKey);
    expect(savedEditorEditKeys()['star-hopper']).toBe(editKey);
    expect(localStorage.getItem(AUTHOR_STORAGE_KEY)).toBe('Alex');
    expect(JSON.parse(localStorage.getItem(EDIT_KEYS_STORAGE_KEY) ?? '{}')['star-hopper']).toBe(editKey);
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ slug: 'star-hopper', version: 1 }), false);

    // Close and re-open for the same projectKey: should default to "Push new version"
    act(() =>
      root.render(
        <PublishModal
          isOpen={false}
          onClose={() => {}}
          projectKey="studio:proj-1"
          projectName="Star Hopper"
          buildBundle={() => ({ bytes, fileName: 'star-hopper.softn' })}
          onPublished={onPublished}
        />,
      ),
    );
    act(() =>
      root.render(
        <PublishModal
          isOpen={true}
          onClose={() => {}}
          projectKey="studio:proj-1"
          projectName="Star Hopper"
          buildBundle={() => ({ bytes, fileName: 'star-hopper.softn' })}
          onPublished={onPublished}
        />,
      ),
    );
    await settle();

    const pushBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Publish new version')!;
    expect(pushBtn).toBeDefined();
    expect(pushBtn.disabled).toBe(false);

    await act(async () => {
      pushBtn.click();
    });
    await settle();

    expect(host.textContent).toContain('Star Hopper v2 is live');
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ slug: 'star-hopper', version: 2 }), true);
  });

  it('offers the standalone /publish fallback when the directory API is offline', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const onClose = vi.fn();
    const onOpenFull = vi.fn();
    const bytes = makeBundle({ name: 'Offline App' });

    act(() =>
      root.render(
        <PublishModal
          isOpen={true}
          onClose={onClose}
          projectName="Offline App"
          buildBundle={() => ({ bytes, fileName: 'offline.softn' })}
          onOpenFullPublishPage={onOpenFull}
        />,
      ),
    );
    await settle();

    expect(host.textContent).toContain('Directory API unavailable here');
    const fallbackBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Open /publish page instead'),
    )!;
    expect(fallbackBtn).toBeDefined();
    act(() => fallbackBtn.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenFull).toHaveBeenCalledTimes(1);
  });
});
