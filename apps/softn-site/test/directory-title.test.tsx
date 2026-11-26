/**
 * The directory's title names the list it shows, on every way of arriving.
 *
 * Two effects set it: the directory's own, which names the search, the
 * author or the category by its name, and the app's head effect (lib/meta),
 * which writes the route's generic title. React runs a child's effects
 * before its parent's, so whenever both ran in one commit — the first
 * arrival on /apps?q=…, a change of category — the generic one landed last:
 * a search tab read "Apps Directory — SoftN", and the category "ai" read
 * "Ai Apps" where the directory had said "AI & Agents Apps". A later search
 * on the same page, where only the directory's effect ran, did get its own
 * title, so the tab said one thing or the other by the way you came.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Category } from '../src/lib/api';

const listApps = vi.fn();
const categories: Category[] = [
  { id: 'ai', name: 'AI & Agents', emoji: '', description: '', apps: 3, suggested: false, status: 'approved' },
];
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, listApps: (...args: unknown[]) => listApps(...args), getCategories: async () => categories };
});

import App from '../src/App';
import { navigate } from '../src/lib/router';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(async () => {
  window.scrollTo = vi.fn();
  listApps.mockReset();
  listApps.mockResolvedValue({ items: [], page: 1, perPage: 24, total: 0, pages: 1, sort: 'trending' });
  window.history.replaceState({}, '', '/');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<App />);
  });
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the directory title', () => {
  it('names a search on the first arrival, as it does on a second search', async () => {
    act(() => navigate('/apps?q=snake'));
    await settle();
    expect(document.title).toBe('snake — apps on SoftN');
    act(() => navigate('/apps?q=tetris'));
    await settle();
    expect(document.title).toBe('tetris — apps on SoftN');
  });

  it('names a category by its name, not by its id', async () => {
    act(() => navigate('/apps?category=ai'));
    await settle();
    expect(document.title).toBe('AI & Agents Apps — SoftN');
  });

  it('names an author', async () => {
    act(() => navigate('/apps?author=Ada'));
    await settle();
    expect(document.title).toBe('Apps by Ada — SoftN');
  });
});
