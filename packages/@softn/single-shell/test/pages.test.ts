/**
 * The pages of a bundle a link goes to (pages.ts): `<a href="about.html">` on
 * an app written as a site.
 */
import { describe, expect, it } from 'vitest';
import { bundlePageAt, composePage, mainPage, pageTitle } from '../src/pages';

const files = new Map<string, string>([
  ['manifest.json', JSON.stringify({ name: 'Site', main: 'index.html', files: { ui: ['index.html', 'pages/about.html'], logic: ['main.js'] } })],
  ['index.html', '<script src="main.js"></script><title>Home</title><a href="pages/about.html">About</a>'],
  ['pages/about.html', '<script src="../main.js"></script><title>About us</title><p>{greeting}</p><a href="../index.html">Home</a>'],
  ['main.js', 'let greeting = "hello"'],
  ['styles.css', 'p {}'],
]);

describe('a link to a page of the bundle', () => {
  it('names the page from the page it is on', () => {
    expect(bundlePageAt(files, 'index.html', 'pages/about.html')).toBe('pages/about.html');
    expect(bundlePageAt(files, 'index.html', './pages/about.html?tab=2#team')).toBe('pages/about.html');
    expect(bundlePageAt(files, 'pages/about.html', '../index.html')).toBe('index.html');
    expect(bundlePageAt(files, 'pages/about.html', '/index.html')).toBe('index.html');
  });

  it('names nothing for another site, a fragment, a file that is no page, or one the bundle has not', () => {
    for (const href of ['https://example.com/index.html', '//example.com/x.html', '#top', 'mailto:a@b.c', 'styles.css', 'missing.html', '../../out.html', '']) {
      expect(bundlePageAt(files, 'index.html', href)).toBeNull();
    }
  });

  it('is the app composed with that page as its main page, its title its own', () => {
    expect(mainPage(files)).toBe('index.html');
    const composed = composePage(files, 'pages/about.html');
    expect(composed.source).toContain('{greeting}');
    expect(composed.source).toContain('let greeting = "hello"');
    expect(pageTitle(files, 'pages/about.html')).toBe('About us');
    expect(pageTitle(files, 'missing.html')).toBeUndefined();
  });
});
