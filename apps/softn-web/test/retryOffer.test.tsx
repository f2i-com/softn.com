/**
 * @vitest-environment jsdom
 *
 * "Try again" on the error card asks again for the app last asked for by
 * address that did not open (openRetry.test.tsx). That address is forgotten
 * once the person asks for another app some other way: the card that follows
 * is about that app, and its "Try again" downloaded the one asked for before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const heading = (): string | null | undefined => container.querySelector('.softn-shell-error h2')?.textContent;
const action = (label: string): HTMLElement | undefined =>
  Array.from(container.querySelectorAll<HTMLElement>('.softn-shell-error-actions > *')).find((el) => el.textContent === label);

/** A file dropped on the window, as a browser hands it over. */
async function drop(file: File): Promise<void> {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  await act(async () => {
    container.querySelector('.softn-shell')!.dispatchEvent(event);
  });
}

beforeEach(() => {
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

describe('the error card after another app was asked for', () => {
  it('offers to try again only the app it is about', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (/\.softn(\?|$)/.test(String(input))) throw new TypeError('Failed to fetch');
      return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '', json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetch);
    window.history.replaceState({}, '', '/?open=/demos/Flaky.softn');
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();
    expect(heading()).toBe('The app couldn’t be downloaded');
    expect(action('Try again')).toBeDefined();

    // A file of the person's own, which turns out to be damaged.
    const bytes = new TextEncoder().encode('not a zip at all');
    await drop({ name: 'broken.softn', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } as unknown as File);
    await settle();
    expect(heading()).not.toBe('The app couldn’t be downloaded');
    expect(container.querySelector('.softn-shell-error')).not.toBeNull();
    // Nothing on this card is the download asked for before.
    expect(action('Try again')).toBeUndefined();
    const asked = fetch.mock.calls.filter(([input]) => /Flaky\.softn/.test(String(input))).length;
    expect(asked).toBe(1);
  });
});
