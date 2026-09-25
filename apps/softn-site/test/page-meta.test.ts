/**
 * Every route declares itself, not the front page, as canonical; an app's
 * page can replace the route's description with the app's own; and a path
 * the site does not have asks not to be indexed.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyMeta, HOME_DESCRIPTION, metaFor, setDescription } from '../src/lib/meta';
import { selectPage } from '../src/lib/router';

beforeEach(() => {
  document.head.innerHTML = `
    <link rel="canonical" href="https://softn.com/" />
    <meta name="description" content="old" />
    <meta property="og:url" content="https://softn.com/" />
    <meta property="og:description" content="old" />`;
});
afterEach(() => {
  document.head.innerHTML = '';
});

const canonical = () => document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href;
const content = (selector: string) => document.head.querySelector<HTMLMetaElement>(selector)?.content;

it('points each page at its own URL on the declared origin', () => {
  applyMeta(metaFor(selectPage('/apps')));
  expect(canonical()).toBe('https://softn.com/apps');
  expect(content('meta[property="og:url"]')).toBe('https://softn.com/apps');
  expect(content('meta[name="description"]')).toMatch(/^Apps people made with SoftN/);

  applyMeta(metaFor(selectPage('/app/soft-dos')));
  expect(canonical()).toBe('https://softn.com/app/soft-dos');

  applyMeta(metaFor(selectPage('/')));
  expect(canonical()).toBe('https://softn.com/');
  expect(content('meta[name="description"]')).toBe(HOME_DESCRIPTION);
  expect(HOME_DESCRIPTION).toContain('JavaScript or Python');
});

it('marks a missing page noindex, and a found one no longer', () => {
  applyMeta(metaFor(selectPage('/no-such-page')));
  expect(content('meta[name="robots"]')).toBe('noindex');
  applyMeta(metaFor(selectPage('/publish')));
  expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  expect(canonical()).toBe('https://softn.com/publish');
});

it('lets a page describe itself, and ignores an empty description', () => {
  setDescription('An x86 PC emulator.');
  expect(content('meta[name="description"]')).toBe('An x86 PC emulator.');
  expect(content('meta[property="og:description"]')).toBe('An x86 PC emulator.');
  setDescription('   ');
  expect(content('meta[name="description"]')).toBe('An x86 PC emulator.');
});

it('creates the tags a stripped-down head lacks, on this page’s origin', () => {
  document.head.innerHTML = '';
  applyMeta(metaFor(selectPage('/apps')));
  expect(canonical()).toBe(`${window.location.origin}/apps`);
  expect(content('meta[name="description"]')).toBeTruthy();
});
