/**
 * @vitest-environment jsdom
 *
 * The editor opens again where it was left for an app: the file, and the
 * caret in it (edit/place.ts). Put away, it noted the caret as at the start:
 * by the time its page let go of it, the field the caret was in was gone, and
 * a reload was the only way it was ever noted where it was.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';

vi.mock('idb', () => import('./helpers/fakeIdb'));

import { resetFakeIdb } from './helpers/fakeIdb';
import { resetAppCacheAvailability } from '../src/lib/appCache';
import { resetDraftStore } from '../src/edit/drafts';
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

// See openFromUrl.test.ts: fflate needs bytes from its own realm.
const ascii = (text: string) => strToU8(text, true);
const MAIN = '<div class="page">\n  <h1 id="title">Plain</h1>\n  <p class="words">Some words</p>\n</div>\n';
const BUNDLE = zipSync({
  'manifest.json': ascii(JSON.stringify({ name: 'Plain Page', version: '1.0.0', main: 'ui/main.ui' })),
  'ui/main.ui': ascii(MAIN),
});

let container: HTMLElement;
let root: Root;

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function until(what: () => unknown, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries && !what(); i++) await settle(1);
  expect(what(), label).toBeTruthy();
}

const code = (): HTMLTextAreaElement | null => container.querySelector<HTMLTextAreaElement>('.softn-edit textarea');
const editButton = (): HTMLButtonElement | null => container.querySelector('.softn-frame-edit');
const kept = (): Array<[string, { file?: string; caret?: number }]> => JSON.parse(localStorage.getItem('softn.web.editor') ?? '[]');

beforeEach(() => {
  resetFakeIdb();
  resetAppCacheAvailability();
  resetDraftStore();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      if (!/\.softn(\?|$)/.test(href)) return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' } as unknown as Response;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: href,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        body: null,
        arrayBuffer: async () => BUNDLE.slice().buffer,
      } as unknown as Response;
    })
  );
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('where the editor was left', () => {
  it('is the caret’s place when the editor is put away, and it opens there again', async () => {
    window.history.replaceState({}, '', '/?open=/demos/plain.softn');
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await until(() => container.querySelector('.softn-runner-app #title'), 'the app is drawn');

    await act(async () => editButton()!.click());
    await until(() => code(), 'the editor opened');
    const caret = MAIN.indexOf('Some words') + 5;
    await act(async () => {
      code()!.focus();
      code()!.setSelectionRange(caret, caret);
    });

    // Put away from the bar.
    await act(async () => editButton()!.click());
    await settle();
    expect(code()).toBeNull();
    expect(kept().map(([, place]) => place)).toEqual([{ file: 'ui/main.ui', caret }]);

    // Opened again: where it was.
    await act(async () => editButton()!.click());
    await until(() => code(), 'the editor opened again');
    await until(() => code()!.selectionStart === caret, `the caret is back at ${caret} (it is at ${code()?.selectionStart})`, 80);
  });
});
