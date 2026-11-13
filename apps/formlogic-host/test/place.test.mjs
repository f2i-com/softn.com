// node --test apps/formlogic-host/test/place.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// Where an app is, as the one string the frame tells its parent (`place` on
// the port) and takes back (`init.place`): how it is written, what is read
// as one, what a parent's place comes to against the app's own files, and
// what a link on a page comes to. Which files are pages is core's to say
// (bundlePageAt, mainPage), from its built dist as the frame's build takes
// them, so this needs `packages/@softn/core` built, as update-live.test.mjs
// does. main.tsx's wiring of these is read by protocol.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bundlePageAt, mainPage } from '@softn/core';
import { PLACE_LIMIT, isOtherPage, keepsNamedPage, linkedPage, readPlace, startPlace, writePlace } from '../src/place.ts';

const manifest = (main = 'index.html') => JSON.stringify({ name: 'Site', main, files: { logic: [] } });
/** A site of three pages, one in a folder, with a stylesheet and a logic file beside them. */
const site = (changes = {}) => new Map(Object.entries({
  'manifest.json': manifest(),
  'index.html': '<h1>Home</h1><a href="about.html">About</a>',
  'about.html': '<h1>About</h1><a href="index.html">Home</a>',
  'docs/guide.html': '<h1>Guide</h1><a href="../index.html">Home</a>',
  'styles.css': 'h1 { color: red; }',
  'logic/main.logic': 'let count = 0',
  ...changes,
}));
/** The same site, with logic that keeps a named page as the renderer reports one. */
const paged = () => site({ 'logic/main.logic': 'let currentPage = "home"' });
const MAIN = { file: null, section: null };
const start = (value, files = site()) => startPlace(value, files, mainPage(files), bundlePageAt);
const link = (href, shown = null, files = site()) => linkedPage(files, mainPage(files), shown, href, bundlePageAt);

test('a place is written as one string: the page file by its path, and a named page after #', () => {
  assert.equal(writePlace({ file: null, section: null }), '/');
  assert.equal(writePlace({ file: 'about.html', section: null }), '/about.html');
  assert.equal(writePlace({ file: 'docs/guide.html', section: null }), '/docs/guide.html');
  assert.equal(writePlace({ file: null, section: 'settings' }), '/#settings');
  assert.equal(writePlace({ file: 'docs/guide.html', section: 'team' }), '/docs/guide.html#team');
  // No name is no #.
  assert.equal(writePlace({ file: 'about.html', section: '' }), '/about.html');
});

test('a written place is one an address can carry, and reads back as what was written', () => {
  // Each part of the path and the name are percent-encoded, so nothing in them ends the path,
  // starts a query or a fragment, or is read by a browser as another site.
  assert.equal(writePlace({ file: 'my pages/a b.html', section: 'team members' }), '/my%20pages/a%20b.html#team%20members');
  assert.equal(writePlace({ file: 'q?x.html', section: 'a#b' }), '/q%3Fx.html#a%23b');
  assert.equal(writePlace({ file: '100%.html', section: 'a/b' }), '/100%25.html#a%2Fb');
  assert.equal(writePlace({ file: 'café.html', section: '設定' }), '/caf%C3%A9.html#%E8%A8%AD%E5%AE%9A');
  for (const place of [
    { file: null, section: null },
    { file: 'about.html', section: null },
    { file: 'docs/guide.html', section: 'team' },
    { file: null, section: 'settings' },
    { file: 'my pages/a b.html', section: 'team members' },
    { file: 'q?x.html', section: 'a#b' },
    { file: '100%.html', section: 'a/b' },
    { file: 'café.html', section: '設定' },
  ]) {
    const written = writePlace(place);
    assert.match(written, /^\/(?!\/)/, written);
    assert.doesNotMatch(written, /[\\?\s]/, written);
    assert.ok(written.length <= PLACE_LIMIT);
    assert.deepEqual(readPlace(written), place, written);
  }
});

test('a written place always starts with one / and is never longer than the limit', () => {
  assert.equal(PLACE_LIMIT, 2000);
  // A named page that would make it too long is left out; the page file still says where.
  assert.equal(writePlace({ file: 'about.html', section: 's'.repeat(3000) }), '/about.html');
  assert.equal(writePlace({ file: null, section: 's'.repeat(1998) }), `/#${'s'.repeat(1998)}`);
  assert.equal(writePlace({ file: null, section: 's'.repeat(1998) }).length, PLACE_LIMIT);
  assert.equal(writePlace({ file: null, section: 's'.repeat(1999) }), '/');
  // Counted as it is written: a character that takes nine to write counts nine.
  assert.equal(writePlace({ file: null, section: '設'.repeat(300) }), '/');
  // A path that cannot be written at all is written as the main page, and never as another site.
  assert.equal(writePlace({ file: `${'d/'.repeat(1200)}a.html`, section: 'team' }), '/');
  for (const file of ['', '/about.html', '//evil.example/a.html', 'a//b.html', '../a.html', 'a/../b.html', './a.html', 'a\\b.html', 'a\nb.html', 'a/', '\ud800.html']) {
    assert.equal(writePlace({ file, section: 'team' }), '/', JSON.stringify(file));
  }
  // A name no address can carry is left out.
  assert.equal(writePlace({ file: 'about.html', section: 'a\u0000b' }), '/about.html');
  assert.equal(writePlace({ file: 'about.html', section: '\ud800' }), '/about.html');
});

test('a place is read to a page file and a named page, or to nothing', () => {
  assert.deepEqual(readPlace('/'), { file: null, section: null });
  assert.deepEqual(readPlace('/about.html'), { file: 'about.html', section: null });
  assert.deepEqual(readPlace('/docs/guide.html'), { file: 'docs/guide.html', section: null });
  assert.deepEqual(readPlace('/#settings'), { file: null, section: 'settings' });
  assert.deepEqual(readPlace('/docs/guide.html#team'), { file: 'docs/guide.html', section: 'team' });
  // As an address bar hands it back: percent-encoded.
  assert.deepEqual(readPlace('/my%20pages/a%20b.html#team%20members'), { file: 'my pages/a b.html', section: 'team members' });
  // A # with nothing after it names no page, as in any address.
  assert.deepEqual(readPlace('/#'), { file: null, section: null });
  assert.deepEqual(readPlace('/about.html#'), { file: 'about.html', section: null });
  // Exactly the limit is read; one more is not.
  assert.deepEqual(readPlace(`/#${'s'.repeat(1998)}`), { file: null, section: 's'.repeat(1998) });
  assert.equal(readPlace(`/#${'s'.repeat(1999)}`), null);
});

test('what is not a place is read as nothing', () => {
  // Not text.
  for (const value of [undefined, null, 0, 7, true, {}, [], ['/about.html'], { place: '/about.html' }, new String('/about.html'), Symbol('/')]) {
    assert.equal(readPlace(value), null, String(value?.toString?.() ?? value));
  }
  // Too long, whatever it says.
  assert.equal(readPlace(`/${'a'.repeat(3000)}`), null);
  assert.equal(readPlace(`/about.html#${'s'.repeat(3000)}`), null);
  for (const value of [
    '',
    // No leading /, so not written by a frame.
    'about.html', '#settings', 'https://evil.example/', 'javascript:alert(1)',
    // Another site, to a browser: two slashes, or a \ it reads as one.
    '//evil.example', '//evil.example/about.html', '/\\evil.example', '/\\/evil.example', '\\\\evil.example', '/about.html\\',
    // Out of the bundle, written plainly or encoded.
    '/../x', '/..', '/.', '/docs/../about.html', '/./about.html', '/%2e%2e/x', '/%2E%2E/%2E%2E/x', '/docs/%2e%2e/about.html',
    // A part that is a path of its own, or another site's start, once decoded.
    '/a%2Fb.html', '/%2Fevil.example', '/%5Cevil.example', '/%2F%2Fevil.example',
    // Empty parts.
    '/docs/', '/a//b.html', '/about.html/',
    // A query is no part of a place.
    '/about.html?x=1', '/?next=//evil.example', '/about.html?x=1#team',
    // Not percent-encoded text, or text with a control character in it.
    '/%', '/%zz.html', '/about.html#%', '/%E0%A4%A.html', '/a\nb.html', '/a\u0000.html', '/%00.html', '/%0Aabout.html', '/#a%0Ab', '/#\t',
  ]) {
    assert.equal(readPlace(value), null, JSON.stringify(value));
  }
});

test('the app starts at the place its parent names, where the app has it', () => {
  assert.deepEqual(start('/'), MAIN);
  assert.deepEqual(start('/about.html'), { file: 'about.html', section: null });
  assert.deepEqual(start('/docs/guide.html'), { file: 'docs/guide.html', section: null });
  // The main page by its own name is the main page.
  assert.deepEqual(start('/index.html'), MAIN);
  // A named page inside a page, for an app that keeps one.
  assert.deepEqual(start('/#settings', paged()), { file: null, section: 'settings' });
  assert.deepEqual(start('/docs/guide.html#team', paged()), { file: 'docs/guide.html', section: 'team' });
  assert.deepEqual(start('/index.html#settings', paged()), { file: null, section: 'settings' });
  // A parent that names none starts the app on its main page, as it always did.
  assert.deepEqual(start(undefined), MAIN);
  assert.deepEqual(start(undefined, paged()), MAIN);
});

test('a place that is not a place of this app is its main page', () => {
  // No such file.
  assert.deepEqual(start('/gone.html'), MAIN);
  assert.deepEqual(start('/docs/about.html'), MAIN);
  assert.deepEqual(start('/About.html'), MAIN);
  // A file of the app that is not a page: its stylesheet, its logic, its manifest.
  assert.deepEqual(start('/styles.css'), MAIN);
  assert.deepEqual(start('/logic/main.logic'), MAIN);
  assert.deepEqual(start('/manifest.json'), MAIN);
  // The name that came with a page the app has not was a page inside that one: it goes too.
  assert.deepEqual(start('/gone.html#team', paged()), MAIN);
  assert.deepEqual(start('/styles.css#team', paged()), MAIN);
  // Hostile, malformed, too long, not text.
  for (const value of ['//evil.example', '/../x', '/%2e%2e/manifest.json', '/\\evil.example', `/${'a'.repeat(3000)}`, `/about.html#${'s'.repeat(3000)}`, 'about.html', 7, null, {}, ['/about.html']]) {
    assert.deepEqual(start(value), MAIN, JSON.stringify(value));
    assert.deepEqual(start(value, paged()), MAIN, JSON.stringify(value));
  }
  // A file whose name a link could not name is no page a place can name either.
  const odd = site({ 'a#b.html': '<p>odd</p>', 'q?x.html': '<p>odd</p>' });
  assert.deepEqual(start('/a%23b.html', odd), MAIN);
  assert.deepEqual(start('/q%3Fx.html', odd), MAIN);
  // An app whose manifest core does not read has no other page to start on.
  const unnamed = site({ 'manifest.json': JSON.stringify({ main: 'index.html' }) });
  assert.equal(mainPage(unnamed), null);
  assert.deepEqual(start('/about.html', unnamed), MAIN);
});

test('a named page is given only to an app that keeps one where the renderer reports it', () => {
  // The frame writes a name only when the renderer reports one, which it does for an app with a
  // currentPage. Given to an app that keeps its page under `page`, or keeps none, it would be a
  // variable the app never made, and its NavItems would set that instead of what the app reads.
  assert.equal(keepsNamedPage(site()), false);
  assert.equal(keepsNamedPage(paged()), true);
  assert.equal(keepsNamedPage(site({ 'index.html': '<If condition={currentPage == "a"}><p>A</p></If>' })), true);
  assert.equal(keepsNamedPage(site({ 'logic/app.py': 'currentPage = "home"\n' })), true);
  assert.equal(keepsNamedPage(site({ 'logic/main.logic': 'let page = "home"' })), false);
  assert.deepEqual(start('/#settings'), MAIN);
  assert.deepEqual(start('/about.html#settings'), { file: 'about.html', section: null });
  assert.deepEqual(start('/#settings', site({ 'logic/main.logic': 'let page = "home"' })), MAIN);
});

test('a link to another page of the app is that page, from where the link stands', () => {
  assert.deepEqual(link('about.html'), { file: 'about.html', showing: false });
  assert.deepEqual(link('docs/guide.html'), { file: 'docs/guide.html', showing: false });
  assert.deepEqual(link('./about.html'), { file: 'about.html', showing: false });
  // From a page in a folder, a relative link is from that folder.
  assert.deepEqual(link('../about.html', 'docs/guide.html'), { file: 'about.html', showing: false });
  assert.deepEqual(link('guide.html', 'docs/guide.html'), { file: 'docs/guide.html', showing: true });
  // And one from the root is from the root, wherever it stands.
  assert.deepEqual(link('/about.html', 'docs/guide.html'), { file: 'about.html', showing: false });
  assert.deepEqual(link('/docs/guide.html', 'about.html'), { file: 'docs/guide.html', showing: false });
});

test('a link to the main page goes back to it', () => {
  assert.deepEqual(link('index.html', 'about.html'), { file: null, showing: false });
  assert.deepEqual(link('../index.html', 'docs/guide.html'), { file: null, showing: false });
  assert.deepEqual(link('/index.html', 'docs/guide.html'), { file: null, showing: false });
  // On the main page already, it is the page showing, and nothing is started again.
  assert.deepEqual(link('index.html'), { file: null, showing: true });
  assert.deepEqual(link('about.html', 'about.html'), { file: 'about.html', showing: true });
  // A main page in a folder is the main page by its own path.
  const folder = site({ 'manifest.json': manifest('ui/main.ui'), 'ui/main.ui': '<p>Main</p>', 'ui/other.ui': '<p>Other</p>' });
  assert.deepEqual(linkedPage(folder, mainPage(folder), null, 'other.ui', bundlePageAt), { file: 'ui/other.ui', showing: false });
  assert.deepEqual(linkedPage(folder, mainPage(folder), 'ui/other.ui', 'main.ui', bundlePageAt), { file: null, showing: false });
  assert.equal(writePlace({ file: 'ui/other.ui', section: null }), '/ui/other.ui');
});

test('a #fragment or a ?query on a link says nothing about which page it is', () => {
  assert.deepEqual(link('about.html#team'), { file: 'about.html', showing: false });
  assert.deepEqual(link('about.html?ref=home'), { file: 'about.html', showing: false });
  assert.deepEqual(link('docs/guide.html?v=3#install'), { file: 'docs/guide.html', showing: false });
  assert.deepEqual(link('../index.html?x=1#top', 'docs/guide.html'), { file: null, showing: false });
  // To the page showing, it is that page: the frame goes nowhere.
  assert.deepEqual(link('about.html#team', 'about.html'), { file: 'about.html', showing: true });
});

test('a link that is not to a page of the app is left to the browser', () => {
  // A file of the app that is not a page, and a page the app has not.
  assert.equal(link('styles.css'), null);
  assert.equal(link('logic/main.logic'), null);
  assert.equal(link('manifest.json'), null);
  assert.equal(link('gone.html'), null);
  assert.equal(link('docs/'), null);
  // An absolute address, one with a scheme, one that starts at another site.
  assert.equal(link('https://example.com/about.html'), null);
  assert.equal(link('http://example.com/'), null);
  assert.equal(link('//example.com/about.html'), null);
  assert.equal(link('mailto:someone@example.com'), null);
  assert.equal(link('tel:+15550100'), null);
  assert.equal(link('javascript:void(0)'), null);
  assert.equal(link('data:text/html,<p>x</p>'), null);
  // A fragment of the page showing, and nothing at all.
  assert.equal(link('#top'), null);
  assert.equal(link(''), null);
  assert.equal(link('   '), null);
  // Out of the bundle.
  assert.equal(link('../about.html'), null);
  assert.equal(link('../../index.html', 'docs/guide.html'), null);
  assert.equal(link('/../about.html'), null);
  // Not an address.
  assert.equal(link(undefined), null);
  assert.equal(link(7), null);
  // An app whose manifest core does not read follows none, as before.
  const unnamed = site({ 'manifest.json': JSON.stringify({ main: 'index.html' }) });
  assert.equal(linkedPage(unnamed, mainPage(unnamed), null, 'about.html', bundlePageAt), null);
});

test('a version still has a page the app is showing, or it has not', () => {
  // What an update asks before it composes the version with that page (update.ts's hasPage).
  assert.equal(isOtherPage(site(), 'index.html', 'about.html', bundlePageAt), true);
  assert.equal(isOtherPage(site(), 'index.html', 'docs/guide.html', bundlePageAt), true);
  const without = site();
  without.delete('about.html');
  assert.equal(isOtherPage(without, 'index.html', 'about.html', bundlePageAt), false);
  // The main page is not another page, and a file that is no page is no page.
  assert.equal(isOtherPage(site(), 'index.html', 'index.html', bundlePageAt), false);
  assert.equal(isOtherPage(site(), 'index.html', 'styles.css', bundlePageAt), false);
  assert.equal(isOtherPage(site(), 'index.html', '../index.html', bundlePageAt), false);
});
