/**
 * @vitest-environment jsdom
 *
 * Every open app stays mounted, and drawing one evaluates its whole page:
 * about 4 ms for a page of 300 rows in this environment. A tab's runner is
 * drawn again when its tab changes or it comes on or off screen, and not for
 * every drawing of the runtime around it: folding the bar away, a line on
 * Home, a toast or a change to another tab drew every app again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';

/** How many times each app's renderer was drawn, by the app's identity. */
const drawings = new Map<string, number>();

vi.mock('@softn/core', async (original) => ({
  ...(await original<typeof import('@softn/core')>()),
  SoftNWithXDB: (props: { appId?: string; source: string }) => {
    drawings.set(props.appId ?? '', (drawings.get(props.appId ?? '') ?? 0) + 1);
    return <main className="stand-in">{props.source.length}</main>;
  },
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

// See openFromUrl.test.ts: fflate needs bytes from its own realm.
const ascii = (text: string) => strToU8(text, true);

const BUNDLE = zipSync({
  'manifest.json': ascii(JSON.stringify({ name: 'Rows', version: '1.0.0', main: 'ui/main.softn', files: { ui: ['ui/main.softn'] } })),
  'ui/main.softn': ascii('page Home {\n}\n'),
});

let container: HTMLElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const press = (selector: string): void => {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).toBeTruthy();
  act(() => button!.click());
};

beforeEach(() => {
  drawings.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.endsWith('.softn')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          url: href,
          headers: new Headers({ 'content-type': 'application/octet-stream' }),
          body: null,
          arrayBuffer: async () => BUNDLE.slice().buffer,
        } as unknown as Response;
      }
      return { ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), json: async () => ({}), text: async () => '' } as unknown as Response;
    })
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  try {
    localStorage.removeItem('softn.web.chromeHidden');
  } catch {
    // Nothing kept.
  }
});

describe('an open app, as the runtime around it changes', () => {
  it('is not drawn again when the bar is folded away and brought back', async () => {
    window.history.replaceState({}, '', '/?open=/demos/Rows.softn');
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();
    expect(container.querySelector('.stand-in')).toBeTruthy();
    const [app] = [...drawings.keys()];
    const before = drawings.get(app)!;

    press('[aria-label="Hide bar"]');
    await settle();
    expect(container.querySelector('.softn-frame-bar')).toBeNull();
    press('.softn-chrome-peek');
    await settle();
    expect(container.querySelector('.softn-frame-bar')).toBeTruthy();

    expect(drawings.get(app)).toBe(before);
  });
});
