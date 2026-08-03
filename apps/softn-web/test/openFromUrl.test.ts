/**
 * @vitest-environment jsdom
 *
 * What the tab bar is left holding when `?open=` does not point at a bundle.
 *
 * The download gets a placeholder tab so the window is not blank while it runs,
 * and the failure worth pinning is the one where the bytes arrive and turn out
 * not to be a zip: every check that rejects them throws before the loader has
 * adopted the placeholder, so unless the code that created the tab retires it,
 * it renders "Loading …" for the rest of the session with no way to dismiss it.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { zipSync, strToU8 } from 'fflate';
import App from '../src/App';

// React reads this to decide whether to warn about updates outside `act`.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom gaps @softn/components' ThemeProvider trips over on mount.
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

/**
 * fflate decides what is a file by `instanceof Uint8Array`, and jsdom's
 * TextEncoder hands back a Uint8Array from its own realm, which fails that test
 * and gets zipped as a folder holding one entry per byte. The latin1 path
 * allocates through fflate's own constructor instead, and every fixture here is
 * ASCII.
 */
const ascii = (text: string) => strToU8(text, true);

/** The launcher's demo shelf and the bundle itself both come through `fetch`. */
function serve(bundle: { url: string; bytes: Uint8Array }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes('demos/index.json')) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: bundle.url,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body: null,
      // `.slice()` first: a Uint8Array can be a window onto a longer buffer, and
      // handing that buffer over whole would shift every offset in the zip.
      arrayBuffer: async () => bundle.bytes.slice().buffer,
    } as unknown as Response;
  });
}

/**
 * A browser fetch that stays pending long enough for Strict Mode to replay the
 * mount effects, and rejects if that synthetic cleanup aborts it.
 */
function serveAfterTask(bundle: { url: string; bytes: Uint8Array }) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input);
    if (href.includes('demos/index.json')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      } as unknown as Response);
    }

    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          url: bundle.url,
          headers: new Headers({ 'content-type': 'application/octet-stream' }),
          body: null,
          arrayBuffer: async () => bundle.bytes.slice().buffer,
        } as unknown as Response);
      }, 0);

      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        },
        { once: true }
      );
    });
  });
}

let container: HTMLElement;
let root: Root;

function mountApp(strict = false): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    const app = React.createElement(App);
    root.render(strict ? React.createElement(React.StrictMode, null, app) : app);
  });
}

/** Let the fetch → readZip → error chain run to a stop. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const tabNames = (): string[] =>
  Array.from(container.querySelectorAll('.softn-tab-app .softn-tab-label')).map(
    (el) => el.textContent ?? ''
  );

beforeEach(() => {
  // The bundle processor and the launcher both log on the way past; the test is
  // about what survives on screen, not about the console.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('?open= pointing at bytes that are not a bundle', () => {
  beforeEach(() => {
    const notAZip = new TextEncoder().encode('<!doctype html><p>404</p>');
    vi.stubGlobal(
      'fetch',
      serve({ url: `${window.location.origin}/demos/Broken.softn`, bytes: notAZip })
    );
    window.history.replaceState({}, '', '/?open=/demos/Broken.softn');
    mountApp();
  });

  it('leaves no tab loading forever', async () => {
    // The placeholder is real while the download is in flight — if it were not,
    // the assertion after `settle` would pass for the wrong reason.
    expect(tabNames()).toEqual(['Broken']);

    await settle();

    expect(tabNames()).toEqual([]);
    expect(container.textContent).not.toContain('Loading Broken');
  });

  it('says so instead of failing silently', async () => {
    await settle();

    const card = container.querySelector('.softn-shell-error');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Failed to load application');
  });

  it('goes back to a URL a reload can act on', async () => {
    await settle();

    // ?open= is one-shot: leaving it in the address bar would reproduce the
    // same failure on every refresh.
    expect(window.location.search).toBe('');
  });
});

describe('?open= pointing at a bundle that does open', () => {
  it('keeps the placeholder and fills it in', async () => {
    const manifest = {
      name: 'AI Chat',
      version: '1.0.0',
      main: 'ui/main.softn',
      files: { ui: ['ui/main.softn'] },
    };
    const bundle = zipSync({
      'manifest.json': ascii(JSON.stringify(manifest)),
      'ui/main.softn': ascii('page Home {\n}\n'),
    });

    vi.stubGlobal(
      'fetch',
      serve({ url: `${window.location.origin}/demos/AIChat.softn`, bytes: bundle })
    );
    window.history.replaceState({}, '', '/?open=/demos/AIChat.softn');
    mountApp();

    // Named after the file while it downloads, and after the manifest once it
    // has been read — the same tab throughout, which is what the cleanup on the
    // failure path has to be careful not to throw away.
    expect(tabNames()).toEqual(['AIChat']);

    await settle();

    expect(tabNames()).toEqual(['AI Chat']);
    expect(container.querySelector('.softn-shell-error')).toBeNull();
  });

  it('survives Strict Mode replay while the entry-point bundle is downloading', async () => {
    const manifest = {
      name: 'PromptlyUnemployed',
      version: '1.0.0',
      main: 'ui/main.softn',
      files: { ui: ['ui/main.softn'] },
    };
    const bundle = zipSync({
      'manifest.json': ascii(JSON.stringify(manifest)),
      'ui/main.softn': ascii('page Home {\n}\n'),
    });

    vi.stubGlobal(
      'fetch',
      serveAfterTask({
        url: `${window.location.origin}/demos/PromptlyUnemployed.softn`,
        bytes: bundle,
      })
    );
    window.history.replaceState({}, '', '/?open=/demos/PromptlyUnemployed.softn');
    mountApp(true);

    expect(tabNames()).toEqual(['PromptlyUnemployed']);

    await settle();

    expect(tabNames()).toEqual(['PromptlyUnemployed']);
    expect(container.textContent).not.toContain('Loading PromptlyUnemployed');
    expect(container.querySelector('.softn-shell-error')).toBeNull();
  });
});
