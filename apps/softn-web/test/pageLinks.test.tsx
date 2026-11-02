/** @vitest-environment jsdom */
/**
 * A link between an app's pages stays in the app.
 *
 * Only the single-app host followed them. Here, and so on a directory's play page, `<a href="about.html">` was an address
 * the host page has no such file at: the person left the app for a failed load of an app called "pages". The runner and
 * the page finder are the real ones; the renderer is a stand-in that shows what it was given.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Given = { source: string; onLink: (href: string) => boolean; pagesOnly?: boolean };
let given: Given;

vi.mock('@softn/core', async (original) => ({
  ...(await original<typeof import('@softn/core')>()),
  SoftNWithXDB: (props: Given) => {
    given = props;
    return <main>{props.source}</main>;
  },
}));

import { AppRunner } from '../src/components/AppRunner';

const manifest = JSON.stringify({ id: 'local.site', name: 'Site', version: '1.0.0', main: 'index.html' });
const textFiles = new Map([
  ['manifest.json', manifest],
  ['index.html', '<h1>Home</h1>'],
  ['pages/about.html', '<h1>About us</h1>'],
  ['styles.css', 'h1 {}'],
]);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function follow(href: string): Promise<boolean> {
  let followed = false;
  await act(async () => { followed = given.onLink(href); });
  return followed;
}

describe('links between an app’s pages', () => {
  it('show the page in the app, and the way back', async () => {
    await act(async () => { root.render(<AppRunner source="the home page" appName="Site" active textFiles={textFiles} />); });
    expect(given.pagesOnly, 'the code of an app from anyone goes to its own pages and nowhere else on the site').toBe(true);

    expect(await follow('pages/about.html?from=home')).toBe(true);
    expect(given.source).toContain('About us');
    // From where that page stands.
    expect(await follow('../index.html')).toBe(true);
    expect(given.source).toBe('the home page');
  });

  it('leave anything else to the browser', async () => {
    await act(async () => { root.render(<AppRunner source="the home page" appName="Site" active textFiles={textFiles} />); });
    expect(await follow('styles.css')).toBe(false);
    expect(await follow('https://example.com/index.html')).toBe(false);
    expect(await follow('missing.html')).toBe(false);
    expect(given.source).toBe('the home page');
  });

  it('are the browser’s for a runner given no files, as the front page’s preview is', async () => {
    await act(async () => { root.render(<AppRunner source="the home page" appName="Site" active />); });
    expect(await follow('pages/about.html')).toBe(false);
  });
});
