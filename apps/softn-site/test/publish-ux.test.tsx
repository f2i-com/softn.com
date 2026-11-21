/**
 * UX improvements on /publish:
 * - quick-pick category & subcategory pills stay synchronized with the <select> elements
 * - manifest metadata (category, subcategory, author, tags) auto-fills when untouched
 * - live directory card preview reflects edits as the publisher types
 * - smart notice links to /publish?update=<slug> when this browser already holds an edit key
 * - batch upload allows removing individual rows before publishing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';
import type { Category } from '../src/lib/api';
import { PublishPage } from '../src/pages/PublishPage';
import { rememberKey } from '../src/lib/keyStore';
import { takeDroppedBundles } from '../src/lib/dropped';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATEGORIES: Category[] = [
  {
    id: 'games',
    name: 'Games',
    emoji: '🎮',
    description: 'Playable games',
    apps: 10,
    suggested: false,
    status: 'approved',
    subcategories: [
      { id: 'games/arcade', slug: 'arcade', parent: 'games', name: 'Arcade', emoji: '🕹️', description: '', apps: 4, suggested: false, status: 'approved' },
      { id: 'games/puzzle', slug: 'puzzle', parent: 'games', name: 'Puzzle', emoji: '🧩', description: '', apps: 3, suggested: false, status: 'approved' },
    ],
  },
  {
    id: 'tools',
    name: 'Tools',
    emoji: '🛠️',
    description: 'Utilities',
    apps: 5,
    suggested: false,
    status: 'approved',
  },
];

function makeBundle(name: string, extra: Record<string, unknown> = {}): File {
  const bytes = zipSync({
    'manifest.json': strToU8(
      JSON.stringify({ name, version: '1.2.0', description: `${name} summary`, main: 'ui/main.ui', ...extra }),
      true,
    ),
    'ui/main.ui': strToU8('<App/>', true),
  });
  return new File([bytes as BlobPart], `${name.toLowerCase().replace(/\s+/g, '-')}.softn`, { type: 'application/zip' });
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('PublishPage UX', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    takeDroppedBundles();
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
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
  });

  const mount = () => {
    act(() =>
      root.render(
        <PublishPage
          route={{ path: '/publish', query: new URLSearchParams() }}
          categories={CATEGORIES}
          onCategories={() => {}}
          categoriesError={null}
          onRetryCategories={() => {}}
        />,
      ),
    );
  };

  const pick = (files: File[]) => {
    const input = container.querySelector<HTMLInputElement>('.dropzone input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('auto-fills manifest metadata, renders live preview card, and syncs quick-pick category/subcategory pills', async () => {
    mount();
    expect(container.querySelector('.publish-create-strip')).not.toBeNull();

    pick([makeBundle('Neon Runner', { author: 'Kai', category: 'games', subcategory: 'arcade', tags: ['retro', 'neon'] })]);
    await settle();

    // Live card preview appears with manifest details
    const preview = container.querySelector('.publish-preview');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain('Neon Runner');
    expect(preview?.textContent).toContain('Games · Arcade');
    expect(preview?.textContent).toContain('by Kai');

    // Category select & subcategory select reflect manifest
    const selects = container.querySelectorAll<HTMLSelectElement>('form.publish-form select');
    expect(selects[0].value).toBe('games');
    expect(selects[1].value).toBe('arcade');

    // Clicking the Puzzle subcategory pill updates the subcategory select & live preview
    const puzzlePill = [...container.querySelectorAll<HTMLButtonElement>('.publish-quick-subs button')].find((b) =>
      b.textContent?.includes('Puzzle'),
    )!;
    act(() => puzzlePill.click());
    expect(selects[1].value).toBe('puzzle');
    expect(container.querySelector('.publish-preview')?.textContent).toContain('Games · Puzzle');

    // Clicking the Tools quick category pill switches category & clears subcategory
    const toolsPill = [...container.querySelectorAll<HTMLButtonElement>('.publish-quick-cats button')].find((b) =>
      b.textContent?.includes('Tools'),
    )!;
    act(() => toolsPill.click());
    expect(selects[0].value).toBe('tools');
  });

  it('shows a 1-click update link when the browser already holds an edit key for the matching slug', async () => {
    rememberKey('neon-runner', 'b'.repeat(40));
    mount();
    pick([makeBundle('Neon Runner')]);
    await settle();

    const notice = container.querySelector('.publish-owned-notice');
    expect(notice).not.toBeNull();
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/publish?update=neon-runner');
  });

  it('lets visitors remove an individual bundle row from a batch before publishing', async () => {
    mount();
    pick([makeBundle('Alpha'), makeBundle('Beta'), makeBundle('Gamma')]);
    await settle();

    expect(container.querySelectorAll('.batch-item').length).toBe(3);
    const removeBeta = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Beta"]')!;
    expect(removeBeta).not.toBeNull();
    act(() => removeBeta.click());

    expect(container.querySelectorAll('.batch-item').length).toBe(2);
    expect(container.textContent).not.toContain('Beta');
    expect(container.textContent).toContain('Publish 2 apps');
  });
});
