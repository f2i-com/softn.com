/**
 * @vitest-environment jsdom
 *
 * A line the runtime says over a running app about that app ("This app is
 * open without the changes you made to it in the editor") is said over that
 * app. It was said over whichever app was on screen, so after opening another
 * app the line went on naming "this app" over an app it was not about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';

vi.mock('idb', () => import('./helpers/fakeIdb'));
// The editor's store could not be fetched (no network, or a deployment replaced it).
vi.mock('../src/edit/drafts', () => {
  throw new Error('The editor’s code could not be fetched');
});

import { resetFakeIdb } from './helpers/fakeIdb';
import { cacheApp, computeAppOrigin, resetAppCacheAvailability } from '../src/lib/appCache';
import { noteDraft } from '../src/lib/editIndex';
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
const bundle = (name: string) =>
  zipSync({
    'manifest.json': ascii(JSON.stringify({ name, version: '1.0.0', main: 'ui/main.softn', files: { ui: ['ui/main.softn'] } })),
    'ui/main.softn': ascii('page Home {\n}\n'),
  });

let container: HTMLElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const press = (selector: string): void => {
  const button = container.querySelector<HTMLElement>(selector);
  expect(button, selector).toBeTruthy();
  act(() => button!.click());
};
const notice = (): string | null => container.querySelector('.softn-shell-notice--over-app')?.textContent ?? null;
const onScreen = (): string | null | undefined => container.querySelector('.softn-frame-name-label')?.textContent;

beforeEach(() => {
  resetFakeIdb();
  resetAppCacheAvailability();
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), json: async () => ({}), text: async () => '' }) as unknown as Response));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('a line over a running app about that app', () => {
  it('is said over that app, and not over another one opened after it', async () => {
    const edited = bundle('Edited');
    await cacheApp(edited, { name: 'Edited', version: '1.0.0' });
    await cacheApp(bundle('Other'), { name: 'Other', version: '1.0.0' });
    // The person changed Edited in the editor; the changes are kept beside it.
    noteDraft(await computeAppOrigin(edited), true);

    window.history.replaceState({}, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();

    press('[aria-label="Open Edited"]');
    await settle();
    expect(onScreen()).toBe('Edited');
    expect(notice()).toContain('without the changes you made');

    press('.softn-frame-home');
    await settle();
    press('[aria-label="Open Other"]');
    await settle();
    expect(onScreen()).toBe('Other');
    expect(notice()).toBeNull();

    // Back to the app it is about: said there still, until it is dismissed.
    press('.softn-frame-home');
    await settle();
    press('.softn-launcher-run-open[title="Back to Edited"]');
    await settle();
    expect(onScreen()).toBe('Edited');
    expect(notice()).toContain('without the changes you made');
  });
});
