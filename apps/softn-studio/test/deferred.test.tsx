/** @vitest-environment jsdom */
/**
 * A screen Studio fetches the first time it opens, when that fetch fails.
 * React used to take all of Studio down with the one screen; the screen now
 * says it did not load, with Reload, and what is around it stays.
 */

import React, { act, lazy } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Deferred } from '../src/components/Deferred';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

async function draw(element: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  return container;
}

it('draws the screen once its code has arrived', async () => {
  const Screen = lazy(async () => ({ default: () => <p>Settings</p> }));
  const shown = await draw(<Deferred><Screen /></Deferred>);
  expect(shown.textContent).toBe('Settings');
});

it('says the screen did not load when its code cannot be fetched, and leaves the rest', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const Screen = lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
  const shown = await draw(<main><h1>Studio</h1><Deferred><Screen /></Deferred></main>);
  expect(shown.querySelector('h1')?.textContent).toBe('Studio');
  expect(shown.querySelector('[role="alert"]')?.textContent).toContain('did not load');
  expect(shown.querySelector('[role="alert"] button')?.textContent).toBe('Reload');
});
