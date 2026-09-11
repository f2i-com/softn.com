/**
 * Where focus goes when the page changes.
 *
 * Navigation scrolled to the top and left focus on the link that was
 * clicked, which by then was gone; a screen reader was told nothing and a
 * keyboard user's next Tab started from the body. Pinned here: a change of
 * path puts focus on the new page's main content; a change of query on the
 * same page — a search, a filter, a retry — leaves focus where the visitor
 * put it, so a refresh never steals it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const listApps = vi.fn();
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, listApps: (...args: unknown[]) => listApps(...args), getCategories: async () => [] };
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

beforeEach(() => {
  // jsdom has no layout; navigate() scrolls to the top.
  window.scrollTo = vi.fn();
  listApps.mockReset();
  listApps.mockResolvedValue({ items: [], page: 1, perPage: 24, total: 0, pages: 1, sort: 'trending' });
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<App />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('focus on navigation', () => {
  it('moves to the main content when the path changes', async () => {
    await settle();
    expect(document.activeElement).toBe(document.body);
    act(() => navigate('/apps'));
    await settle();
    const main = document.activeElement;
    expect(main?.tagName).toBe('MAIN');
    expect(main?.closest('.directory')).not.toBeNull();
  });

  it('stays put when only the query changes on the same page', async () => {
    act(() => navigate('/apps'));
    await settle();
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => search.focus());
    expect(document.activeElement).toBe(search);

    // A filter chip is a navigation to the same path with another query,
    // which refreshes the list; the visitor's focus is not taken from them.
    const chip = [...container.querySelectorAll<HTMLButtonElement>('button.pill-cap')][0];
    act(() => chip.focus());
    act(() => chip.click());
    await settle();
    expect(window.location.search).toContain('cap=');
    expect(listApps.mock.calls.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(chip);
  });

  it('does not take focus on the first render', async () => {
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});
