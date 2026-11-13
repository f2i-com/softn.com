// node --test apps/formlogic-host/test/place-live.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// A link between an app's page files, followed in an app that is really
// running: core's own composer, pages, live app and renderer (from its built
// dist, as the frame's build takes them), on the ZIPP engine the frame is
// sent, in a jsdom page. The renderer is given what main.tsx gives it (the
// page on screen in its props, keyed by its file, with `onLink`, `pagesOnly`
// and a live app of its own), and the deciding goes through the frame's
// place.ts and update.ts. What is held here is what a person would see (the
// page a link went to, the records that stayed) and what the parent is told
// (`shown`, then each `place`).
//
// place.test.mjs holds the rules alone; this holds that the rules and the
// real renderer agree. main.tsx itself is a document's entry and runs only in
// a frame: protocol.test.mjs reads its wiring, which `open` below repeats.
// jsdom is not a browser: it lays nothing out and goes nowhere, so that the
// frame no longer leaves for another address is seen here as a click whose
// default was prevented. Needs `packages/@softn/core` built, and
// `packages/@softn/components` for the one test with a NavItem in it.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createUpdater, importsFrom, PAGE_GONE } from '../src/update.ts';
import { isOtherPage, linkedPage, startPlace, writePlace } from '../src/place.ts';
import { bundleLanguages } from '../src/engineInit.ts';
import { mediaUrl } from '../src/media.ts';
import { declaredThemeMode } from '../src/appTheme.ts';

// A page for the renderer to draw in, there before React or core is loaded.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://frame.test/', pretendToBeVisual: true });
for (const name of Object.getOwnPropertyNames(dom.window)) {
  if (name in globalThis) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get: () => dom.window[name],
    set: value => { Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); },
  });
}
// The page's own where Node has one of the same name: what is dispatched on the page is the page's kind of event.
for (const name of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'Event', 'CustomEvent', 'EventTarget']) {
  Object.defineProperty(globalThis, name, { configurable: true, get: () => dom.window[name] });
}
// What a click comes to once the app and the frame have had it: whether its default (the browser
// going to the address) was prevented. Then it is prevented here, because jsdom goes nowhere.
const clicks = [];
dom.window.document.addEventListener('click', event => {
  clicks.push(event.defaultPrevented);
  event.preventDefault();
});

// The renderer gives a start twenty seconds to land, and a start that landed leaves that timer
// behind it: nothing in a frame, but this file's process would sit it out. Cleared at the end.
const timers = new Set();
const setTimer = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  const timer = setTimer(...args);
  timers.add(timer);
  return timer;
};

const { createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const core = await import('@softn/core');

// The engine, as the parent posts it: bytes, configured once before any app runs.
const engine = fs.readFileSync(new URL('../../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm', import.meta.url));
core.configureZippWasmSource(engine.buffer.slice(engine.byteOffset, engine.byteOffset + engine.byteLength));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mounted = [];
after(async () => {
  for (const root of mounted) root.unmount();
  await sleep(20);
  dom.window.close();
  for (const timer of timers) clearTimeout(timer);
});

const MANIFEST = JSON.stringify({ name: 'Site', main: 'index.html', files: { logic: ['logic/main.logic'] } });
const LOGIC = `let count = 0
let currentPage = "home"
function inc() { count = count + 1 }
function go(name) { currentPage = name }
`;
/** A page of the site: its own title and links, the shared logic, and the app's one collection. */
const page = (title, links, logic = 'logic/main.logic') => `<logic src="${logic}" />
<data>
  <collection name="notes" as="notes" />
</data>
<div>
  <h1 class="title">${title}</h1>
  ${links}
  <button id="inc" @click={inc}>Add</button>
  <button id="to-settings" @click={go("settings")}>Settings</button>
  <span class="count">{count}</span>
  <span class="notes">{notes.length}</span>
  <span class="section">{currentPage}</span>
</div>`;
const HOME = page('Home', '<a id="to-about" href="about.html">About</a> <a id="to-guide" href="docs/guide.html?from=home#install">Guide</a> <a id="to-styles" href="styles.css">Styles</a> <a id="to-elsewhere" href="https://elsewhere.example/about.html">Elsewhere</a>');
const ABOUT = page('About', '<a id="to-home" href="index.html">Home</a> <a id="to-self" href="about.html#team">Team</a>');
const GUIDE = page('Guide', '<a id="to-home" href="../index.html">Home</a> <a id="to-about" href="/about.html">About</a>', '../logic/main.logic');
const client = (changes = {}) => ({
  'manifest.json': MANIFEST, 'index.html': HOME, 'about.html': ABOUT, 'docs/guide.html': GUIDE,
  'styles.css': 'h1 { color: red; }', 'logic/main.logic': LOGIC, ...changes,
});

let apps = 0;
/** Open an app as the frame's init does, at the place the parent names or none, with what its port would carry in `posted`. */
async function open({ files = client(), place } = {}) {
  const text = new Map(Object.entries(files));
  let manifest = JSON.parse(text.get('manifest.json'));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  const posted = [];
  const errors = [];
  let drawn = false;
  const appId = `frame-place-${++apps}`;
  const updates = createUpdater({
    post: reply => posted.push(reply),
    state: () => (drawn ? 'running' : 'opening'),
    languages: bundleLanguages, compose: core.composeBundleSource, mediaUrl, themeOf: declaredThemeMode,
    hasPage: (versionFiles, main, path) => isOtherPage(versionFiles, main, path, core.bundlePageAt),
  });
  // From here to `draw()`: main.tsx's own lines, with the port's messages gathered in `posted`.
  let first = core.composeBundleSource(text, manifest.main, manifest.files?.logic || []);
  let start = startPlace(place, text, core.mainPage(text), core.bundlePageAt);
  if (start.file !== null) {
    try {
      first = core.composePage(text, start.file);
    } catch {
      start = { file: null, section: null };
    }
  }
  let shown = {
    file: start.file, composed: first, live: core.createLiveApp(), imports: importsFrom(text),
    initialState: start.section === null ? undefined : { currentPage: start.section },
  };
  let section = start.section;
  let told;
  const tellPlace = () => {
    if (!drawn) return;
    const where = writePlace({ file: shown.file, section });
    if (where === told) return;
    told = where;
    posted.push({ type: 'place', place: where });
  };
  const draw = () => {
    const resolveAsset = path => updates.asset(path);
    const showing = shown;
    const { composed, live } = showing;
    root.render(createElement(core.SoftNWithXDB, {
      ...composed, app: live, appId, resumeSavedSyncRoom: false,
      key: showing.file ?? '', onLink: followLink, pagesOnly: true,
      initialState: showing.initialState,
      onPageChange: name => { if (shown === showing) { section = name; tellPlace(); } },
      permissionConfig: { permissions: {} }, scriptExecutionMode: 'main',
      assetResolver: resolveAsset, functions: { asset: (...args) => resolveAsset(String(args[0] ?? '')) },
      importResolver: showing.imports,
      onLoad: () => { if (!drawn) posted.push({ type: 'shown' }); drawn = true; tellPlace(); },
      onError: error => errors.push(error),
    }));
  };
  const show = (file, composed, imports) => {
    shown = { file, composed, live: core.createLiveApp(), imports };
    section = null;
    draw();
    tellPlace();
  };
  const followLink = href => {
    const version = updates.files();
    const main = core.mainPage(version);
    const linked = linkedPage(version, main, shown.file, href, core.bundlePageAt);
    if (linked === null || main === null) return false;
    if (linked.showing) return true;
    let composed;
    try {
      composed = core.composePage(version, linked.file ?? main);
    } catch {
      return false;
    }
    show(linked.file, composed, importsFrom(version));
    return true;
  };
  updates.open({
    files: text, media: new Map(),
    update: revision => shown.live.update(revision),
    redraw: next => { manifest = next; draw(); },
    page: () => shown.file,
    leave: revision => show(null, revision, revision.importResolver),
  });
  draw();

  const read = selector => container.querySelector(selector)?.textContent ?? null;
  const reads = async (selector, expected) => {
    for (let i = 0; i < 400 && read(selector) !== expected; i++) await sleep(15);
    assert.equal(read(selector), expected, `${selector}; the page is ${container.innerHTML.slice(0, 600)}; errors: ${errors.map(String).join(' | ')}`);
  };
  /** Click as a person does, and answer whether the frame kept the browser from going to the address. */
  const click = async selector => {
    const element = container.querySelector(selector);
    assert.ok(element, `${selector} is on the page; the page is ${container.innerHTML.slice(0, 600)}`);
    clicks.length = 0;
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await sleep(15);
    return clicks[0];
  };
  /** Post an update as the parent does, and wait for its answer. */
  const update = async (id, newer) => {
    updates.receive({ type: 'formlogic:update', id, client: newer });
    for (let i = 0; i < 800 && !posted.some(reply => reply.id === id); i++) await sleep(15);
    const reply = posted.find(entry => entry.id === id);
    assert.ok(reply, `update ${id} was answered; the page is ${container.innerHTML.slice(0, 600)}`);
    return reply;
  };
  const places = () => posted.filter(message => message.type === 'place').map(message => message.place);
  /** Wait for the parent to have been told the app is at `expected`: the renderer reports a named page a moment after it draws it. */
  const placed = async expected => {
    for (let i = 0; i < 400 && places().at(-1) !== expected; i++) await sleep(15);
    assert.equal(places().at(-1), expected, `the places told are ${places().join(' ')}; errors: ${errors.map(String).join(' | ')}`);
  };
  return { container, read, reads, click, update, posted, places, placed, appId, errors };
}
/** Long enough for a place that should not be told to have been told. */
const settled = () => sleep(120);

test('a link to another page of the app shows that page in the frame, and the parent is told where the app is', async () => {
  const app = await open();
  await app.reads('.title', 'Home');
  await app.reads('.section', 'home');
  // Shown first, then the place the app starts at: its main page, and the named page its logic starts on.
  await app.placed('/#home');
  assert.deepEqual(app.posted[0], { type: 'shown' });
  assert.equal(app.posted[1].type, 'place');
  assert.ok(app.places().every(place => place === '/' || place === '/#home'), String(app.places()));

  // The link is the frame's: the browser is kept from going to an address that is the parent's own page.
  assert.equal(await app.click('#to-about'), true);
  await app.reads('.title', 'About');
  // Told as the link is followed: the page file. Then the named page its logic starts on, once it has started.
  assert.ok(app.places().includes('/about.html'), String(app.places()));
  await app.placed('/about.html#home');
  assert.deepEqual(app.places().slice(-2), ['/about.html', '/about.html#home']);
  assert.deepEqual(app.errors, []);
});

test('another page is another run of the app, on the records it has', async () => {
  const app = await open();
  await app.reads('.count', '0');
  await app.click('#inc');
  await app.reads('.count', '1');
  // A record the app saved, as its page lists it.
  core.getXDB(app.appId).create('notes', { text: 'kept' });
  await app.reads('.notes', '1');
  await app.click('#to-about');
  await app.reads('.title', 'About');
  // Its variables start again, as a browser's do on a page it goes to; what it stored is as it was.
  await app.reads('.count', '0');
  await app.reads('.notes', '1');
  // And the page works: its own logic answers.
  await app.click('#inc');
  await app.reads('.count', '1');
});

test('a link to the main page goes back to it, from a page in a folder too', async () => {
  const app = await open();
  await app.reads('.title', 'Home');
  // A ?query and a #fragment on the link say nothing about which page it is.
  assert.equal(await app.click('#to-guide'), true);
  await app.reads('.title', 'Guide');
  assert.ok(app.places().includes('/docs/guide.html'), String(app.places()));
  // From the folder: a link from the root, and a relative one back to the main page.
  assert.equal(await app.click('#to-about'), true);
  await app.reads('.title', 'About');
  assert.ok(app.places().includes('/about.html'), String(app.places()));
  assert.equal(await app.click('#to-home'), true);
  await app.reads('.title', 'Home');
  assert.ok(app.places().lastIndexOf('/') > app.places().lastIndexOf('/about.html'), String(app.places()));
  await app.placed('/#home');
  await app.click('#to-guide');
  await app.reads('.title', 'Guide');
  assert.equal(await app.click('#to-home'), true);
  await app.reads('.title', 'Home');
  await app.placed('/#home');
  // Never the same place twice running.
  const told = app.places();
  for (let at = 1; at < told.length; at++) assert.notEqual(told[at], told[at - 1], String(told));
});

test('a link that is not to a page of the app is left to the browser, and the page stays', async () => {
  const app = await open();
  await app.reads('.title', 'Home');
  await app.placed('/#home');
  const told = app.places().length;
  // A file of the app that is not a page, and another site.
  assert.equal(await app.click('#to-styles'), false);
  assert.equal(await app.click('#to-elsewhere'), false);
  await settled();
  assert.equal(app.read('.title'), 'Home');
  assert.equal(app.places().length, told);
  // A link to the page showing is the frame's, and nothing is started again by it.
  await app.click('#to-about');
  await app.reads('.title', 'About');
  await app.click('#inc');
  await app.reads('.count', '1');
  await app.placed('/about.html#home');
  const there = app.places().length;
  assert.equal(await app.click('#to-self'), true);
  await settled();
  assert.equal(app.read('.count'), '1');
  assert.equal(app.places().length, there);
});

test('a named page inside a page is part of the place, as the renderer reports it', async () => {
  const app = await open();
  await app.placed('/#home');
  await app.click('#to-settings');
  await app.reads('.section', 'settings');
  await app.placed('/#settings');
  // On another page file it is that page's: none until its renderer reports one.
  await app.click('#to-about');
  await app.reads('.title', 'About');
  assert.equal(app.places().at(app.places().indexOf('/#settings') + 1), '/about.html', String(app.places()));
  await app.placed('/about.html#home');
  await app.click('#to-settings');
  await app.reads('.section', 'settings');
  await app.placed('/about.html#settings');
  assert.deepEqual(app.places().slice(-5), ['/#home', '/#settings', '/about.html', '/about.html#home', '/about.html#settings']);
});

test('a page chosen with a NavItem is told, and a NavItem naming a page file goes to it', async () => {
  // The components the frame registers (main.tsx's registerRuntimeComponents), from their built dist.
  const { registerRuntimeComponents } = await import('@softn/components/lazy');
  registerRuntimeComponents();
  const nav = '<NavItem class="nav-settings" page="settings" label="Settings" /> <NavItem class="nav-home" page="home" label="Home" />';
  const app = await open({ files: client({ 'index.html': page('Home', `${nav} <a id="to-about" href="about.html">About</a>`) }) });
  await app.reads('.title', 'Home');
  await app.placed('/#home');
  for (let i = 0; i < 400 && !app.container.querySelector('.nav-settings'); i++) await sleep(15);
  await app.click('.nav-settings');
  await app.reads('.section', 'settings');
  await app.placed('/#settings');
  await app.click('.nav-home');
  await app.reads('.section', 'home');
  await app.placed('/#home');
  // In an app that keeps no named page, an item's `page` is a page file of the bundle, as a link names one.
  const plain = client({
    'logic/main.logic': 'let count = 0\nfunction inc() { count = count + 1 }\nfunction go(name) { count = 0 }\n',
    'index.html': page('Home', '<NavItem class="nav-about" page="about.html" label="About" />').replace('{currentPage}', '-'),
    'about.html': ABOUT.replace('{currentPage}', '-'),
    'docs/guide.html': GUIDE.replace('{currentPage}', '-'),
  });
  const site = await open({ files: plain });
  await site.reads('.title', 'Home');
  for (let i = 0; i < 400 && !site.container.querySelector('.nav-about'); i++) await sleep(15);
  await site.click('.nav-about');
  await site.reads('.title', 'About');
  await settled();
  assert.deepEqual(site.places(), ['/', '/about.html']);
});

test('the app starts at the place its parent names', async () => {
  const about = await open({ place: '/about.html' });
  await about.reads('.title', 'About');
  await about.placed('/about.html#home');
  assert.deepEqual(about.posted[0], { type: 'shown' });
  assert.ok(about.places().every(place => place.startsWith('/about.html')), String(about.places()));
  // A page in a folder, and a named page inside it, which the app starts on in place of its own first.
  const guide = await open({ place: '/docs/guide.html#settings' });
  await guide.reads('.title', 'Guide');
  await guide.reads('.section', 'settings');
  await settled();
  assert.deepEqual(guide.places(), ['/docs/guide.html#settings']);
  // Its links are from where it stands.
  assert.equal(await guide.click('#to-home'), true);
  await guide.reads('.title', 'Home');
  // A named page on the main page.
  const settings = await open({ place: '/#settings' });
  await settings.reads('.title', 'Home');
  await settings.reads('.section', 'settings');
  await settled();
  assert.deepEqual(settings.places(), ['/#settings']);
});

test('a place that is not a place of this app starts it on its main page', async () => {
  for (const place of ['/gone.html', '/styles.css', '//evil.example', '/../x', `/${'a'.repeat(3000)}`, 7, { file: 'about.html' }]) {
    const app = await open({ place });
    await app.reads('.title', 'Home');
    await app.placed('/#home');
    assert.ok(app.places().every(told => told === '/' || told === '/#home'), `${JSON.stringify(place).slice(0, 40)}: ${app.places()}`);
    assert.deepEqual(app.errors, []);
  }
  // A name for an app that keeps no named page is not given to it: its state has no currentPage it never made.
  const plain = client({ 'logic/main.logic': 'let count = 0\nlet page = "home"\nfunction inc() { count = count + 1 }\nfunction go(name) { page = name }\n' });
  for (const name of ['index.html', 'about.html', 'docs/guide.html']) plain[name] = plain[name].replace('{currentPage}', '{page}');
  const app = await open({ files: plain, place: '/about.html#settings' });
  await app.reads('.title', 'About');
  await app.reads('.section', 'home');
  await settled();
  assert.deepEqual(app.places(), ['/about.html']);
  // And it goes on keeping its page where it keeps it.
  await app.click('#to-settings');
  await app.reads('.section', 'settings');
  await settled();
  assert.deepEqual(app.places(), ['/about.html']);
});

test('a newer version is taken by the page on screen, which stays while the version has it', async () => {
  const app = await open();
  await app.reads('.title', 'Home');
  await app.click('#to-about');
  await app.reads('.title', 'About');
  await app.click('#inc');
  await app.reads('.count', '1');
  await app.placed('/about.html#home');
  const told = app.places().length;
  // Other markup on the page showing: drawn where the app stands, on that page, with its state.
  const renamed = client({ 'about.html': ABOUT.replace('>About</h1>', '>About us</h1>'), 'index.html': HOME.replace('>Home</h1>', '>Home page</h1>') });
  const reply = await app.update(1, renamed);
  assert.deepEqual(reply, { type: 'updated', id: 1, outcome: 'updated', changed: ['page'] });
  await app.reads('.title', 'About us');
  assert.equal(app.read('.count'), '1');
  await settled();
  assert.equal(app.places().length, told, 'the app is where it was');
  // A link from it goes to the page of the version on screen.
  await app.click('#to-home');
  await app.reads('.title', 'Home page');
  // And the main page takes the next version, as ever.
  const again = await app.update(2, client({ 'index.html': HOME.replace('>Home</h1>', '>Start</h1>') }));
  assert.equal(again.outcome, 'updated');
  await app.reads('.title', 'Start');
});

test('a newer version without the page on screen opens the app at its main page, and the parent is told', async () => {
  const app = await open({ place: '/docs/guide.html' });
  await app.reads('.title', 'Guide');
  await app.placed('/docs/guide.html#home');
  const without = client({ 'index.html': HOME.replace('>Home</h1>', '>Home, without a guide</h1>').replace(/<a id="to-guide"[^>]*>Guide<\/a>/, '') });
  delete without['docs/guide.html'];
  const reply = await app.update('gone', without);
  assert.deepEqual(reply, { type: 'updated', id: 'gone', outcome: 'restarted', changed: ['page'], reason: PAGE_GONE, carried: false });
  await app.reads('.title', 'Home, without a guide');
  assert.ok(app.places().includes('/'), String(app.places()));
  await app.placed('/#home');
  // The place was told before the answer, so a parent that reads both has the place first.
  const order = app.posted.map(message => message.type === 'place' ? message.place : message.type);
  assert.ok(order.indexOf('/') < order.indexOf('updated'), String(order));
  // The app goes on from its main page: its links, and the next version.
  assert.equal(await app.click('#to-about'), true);
  await app.reads('.title', 'About');
  assert.deepEqual(app.errors, []);
});
