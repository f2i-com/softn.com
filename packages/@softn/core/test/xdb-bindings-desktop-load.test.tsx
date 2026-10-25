/**
 * The desktop's store loads its records from the native database after it starts, and the
 * loader mounted the app at once: a script's first change of a record it knew (a settings
 * record by its id) met a store that had none of them yet. SoftNWithXDB starts the app once its
 * store has loaded.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SoftNWithXDB } from '../src/loader/xdb-bindings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let release: () => void;
let loaded: Promise<void>;

beforeEach(() => {
  loaded = new Promise((resolve) => { release = resolve; });
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'get_collections') return ['notes'];
    if (cmd === 'get_collection') {
      await loaded;
      return [];
    }
    return null;
  });
  (globalThis as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } };
});

afterEach(() => {
  delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
});

it('starts the app once the desktop store has loaded', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(<SoftNWithXDB source="<div>started</div>" appId={`desktop-load-${Math.random().toString(36).slice(2)}`} />);
  });
  expect(container.textContent).not.toContain('started');
  await act(async () => {
    release();
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain('started');
  await act(async () => root.unmount());
});

it('starts the app at once on a store loaded from the start (the browser)', async () => {
  delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(<SoftNWithXDB source="<div>started</div>" appId={`browser-load-${Math.random().toString(36).slice(2)}`} />);
  });
  expect(container.textContent).toContain('started');
  await act(async () => root.unmount());
});
