/**
 * @vitest-environment jsdom
 *
 * A hand-off the launcher cannot read must not strand it (audit-apps H2).
 *
 * `?open=handoff&handoff=<id>` used to be the one branch of `openFromUrl`
 * with no catch, and its caller waited on the promise to set `urlReady`; a
 * rejected IndexedDB read left the address bar carrying the hand-off, no
 * error on screen, and every later URL canonicalisation gated off for the
 * rest of the session. Pinned here: the error card appears, and the URL
 * still becomes one a reload can act on.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@softn/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  takeBundleHandoff: vi.fn(() => Promise.reject(new Error('IndexedDB is unavailable'))),
}));

import App from '../src/App';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

let container: HTMLElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response)
  );
  window.history.replaceState({}, '', '/?open=handoff&handoff=abcdefghijklmnop');
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(App));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('a hand-off whose read rejects', () => {
  it('shows the failure instead of failing silently', async () => {
    await settle();
    const card = container.querySelector('.softn-shell-error');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('IndexedDB is unavailable');
  });

  it('still leaves the address bar on a URL a reload can act on', async () => {
    await settle();
    // The canonicalisation is gated on `urlReady`; a stranded launcher would
    // keep `?open=handoff&handoff=…` here forever.
    expect(window.location.search).toBe('');
  });
});
