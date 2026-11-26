// node --test apps/formlogic-host/test/navigate-live.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// Back and Forward in the parent, in an app that is really running. FormLogic keeps each place the
// frame tells it as a step of its history, and Back or Forward to one is posted on the port as
// `{ type: 'formlogic:navigate', to: place }`; the classic frame (main.tsx's navigatePlace) shows
// the app there. Core's own composer, pages, live app and renderer (from its built dist, as the
// frame's build takes them), on the ZIPP engine the frame is sent, in a jsdom page, given what
// main.tsx gives them: place-live.test.mjs's harness, with navigatePlace beside it, line for line.
// protocol.test.mjs holds main.tsx to these lines.
//
// A named page shown again on the same page file stayed where the app was: the renderer reads a
// named page only as a page starts, and the frame drew the same page again with the name handed in
// as a change, which the renderer takes only when it differs from the name the frame handed it the
// time before. So after a NavItem chose another page, Back to the page the frame had last been sent
// to showed nothing new. And a place with no name on the page on screen drew it again: the page
// stayed on its named page, and the parent was told it was at the page alone.
// Needs `packages/@softn/core` built.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createUpdater, importsFrom } from '../src/update.ts';
import { isOtherPage, linkedPage, startPlace, writePlace } from '../src/place.ts';
import { bundleLanguages } from '../src/engineInit.ts';
import { mediaUrl } from '../src/media.ts';
import { declaredThemeMode } from '../src/appTheme.ts';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://frame.test/', pretendToBeVisual: true });
for (const name of Object.getOwnPropertyNames(dom.window)) {
  if (name in globalThis) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get: () => dom.window[name],
    set: value => { Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); },
  });
}
for (const name of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'Event', 'CustomEvent', 'EventTarget']) {
  Object.defineProperty(globalThis, name, { configurable: true, get: () => dom.window[name] });
}
// jsdom goes nowhere, and a link the frame does not take would try to.
dom.window.document.addEventListener('click', event => { event.preventDefault(); });

// The renderer leaves a start's timer behind it, which this file's process would sit out. Cleared at the end.
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
const page = (title, links) => `<logic src="logic/main.logic" />
<div>
  <h1 class="title">${title}</h1>
  ${links}
  <button id="inc" @click={inc}>Add</button>
  <button id="to-settings" @click={go("settings")}>Settings</button>
  <button id="to-home" @click={go("home")}>Home</button>
  <span class="count">{count}</span>
  <span class="section">{currentPage}</span>
</div>`;
const client = () => ({
  'manifest.json': MANIFEST,
  'index.html': page('Home', '<a id="to-about" href="about.html">About</a>'),
  'about.html': page('About', '<a id="to-index" href="index.html">Home</a>'),
  'logic/main.logic': LOGIC,
});

let apps = 0;
// main.tsx's own counter of the places the parent sent the app to.
let visits = 0;
/** Open an app as the frame's init does, with what its port would carry in `posted`, and `navigate` as the port's navigate. */
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
  const appId = `frame-navigate-${++apps}`;
  const updates = createUpdater({
    post: reply => posted.push(reply),
    state: () => (drawn ? 'running' : 'opening'),
    languages: bundleLanguages, compose: core.composeBundleSource, mediaUrl, themeOf: declaredThemeMode,
    hasPage: (versionFiles, main, path) => isOtherPage(versionFiles, main, path, core.bundlePageAt),
  });
  // From here to the end of navigatePlace: main.tsx's own lines, with the port's messages in `posted`.
  let first = core.composeBundleSource(text, manifest.main, manifest.files?.logic || []);
  let start = startPlace(place, text, core.mainPage(text), core.bundlePageAt);
  if (start.file !== null) {
    try { first = core.composePage(text, start.file); } catch { start = { file: null, section: null }; }
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
      key: `${showing.visit ?? 0}/${showing.file ?? ''}`, onLink: followLink, pagesOnly: true,
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
    try { composed = core.composePage(version, linked.file ?? main); } catch { return false; }
    show(linked.file, composed, importsFrom(version));
    return true;
  };
  const navigatePlace = to => {
    const version = updates.files();
    const main = core.mainPage(version);
    const dest = startPlace(to, version, main, core.bundlePageAt);
    const targetPath = dest.file ?? main;
    if (!targetPath) return;
    if (dest.file === shown.file && (dest.section === null || dest.section === section)) return;
    try {
      const composed = core.composePage(version, targetPath);
      shown = { file: dest.file, composed, live: core.createLiveApp(), imports: importsFrom(version), visit: ++visits, ...(dest.section ? { initialState: { currentPage: dest.section } } : {}) };
      section = dest.section;
      draw();
    } catch (problem) {
      errors.push(problem);
    }
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
  const click = async selector => {
    const element = container.querySelector(selector);
    assert.ok(element, `${selector} is on the page; the page is ${container.innerHTML.slice(0, 600)}`);
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await sleep(15);
  };
  const places = () => posted.filter(message => message.type === 'place').map(message => message.place);
  const placed = async expected => {
    for (let i = 0; i < 400 && places().at(-1) !== expected; i++) await sleep(15);
    assert.equal(places().at(-1), expected, `the places told are ${places().join(' ')}; errors: ${errors.map(String).join(' | ')}`);
  };
  return { read, reads, click, places, placed, navigate: navigatePlace, errors };
}
/** Long enough for a place that should not be told to have been told. */
const settled = () => sleep(150);

test('Back and Forward between named pages of a page show the page the parent names, after the app chose another too', async () => {
  const app = await open();
  await app.reads('.section', 'home');
  await app.placed('/#home');
  await app.click('#to-settings');
  await app.reads('.section', 'settings');
  await app.placed('/#settings');
  app.navigate('/#home');
  await app.reads('.section', 'home');
  app.navigate('/#settings');
  await app.reads('.section', 'settings');
  app.navigate('/#home');
  await app.reads('.section', 'home');
  // The app chooses a page of its own, and the person goes Back to the one the parent last sent it to.
  await app.click('#to-settings');
  await app.reads('.section', 'settings');
  await app.placed('/#settings');
  app.navigate('/#home');
  await app.reads('.section', 'home');
  // The place the parent went to is the place it is told, and nothing after it.
  await app.placed('/#home');
  await settled();
  assert.equal(app.places().at(-1), '/#home');
  assert.deepEqual(app.errors, []);
});

test('the same named page asked for again leaves the app as it is, its variables and all', async () => {
  const app = await open();
  await app.reads('.section', 'home');
  await app.click('#inc');
  await app.reads('.count', '1');
  await app.placed('/#home');
  const told = app.places().length;
  app.navigate('/#home');
  await settled();
  assert.equal(app.read('.count'), '1');
  assert.equal(app.places().length, told);
});

test('the page on screen asked for with no named page stays as it is, and the parent is told nothing new', async () => {
  // A parent that keeps each place as a step of its history has `/` then `/#home` for an app whose
  // logic starts on a named page. Back to `/` run the page again would tell `/#home` again, a step
  // the parent would keep, and Back would come back to it for ever.
  const app = await open();
  await app.reads('.section', 'home');
  await app.click('#inc');
  await app.reads('.count', '1');
  await app.placed('/#home');
  const told = app.places().length;
  app.navigate('/');
  await settled();
  assert.equal(app.read('.section'), 'home');
  assert.equal(app.read('.count'), '1', 'not started again');
  assert.deepEqual(app.places().slice(told), [], 'and nothing told: the app is where it was');
  // Elsewhere on it, the same: drawn again, the page stayed on its named page and the parent was told `/`.
  await app.click('#to-settings');
  await app.reads('.section', 'settings');
  await app.placed('/#settings');
  const before = app.places().length;
  app.navigate('/');
  await settled();
  assert.equal(app.read('.section'), 'settings');
  assert.deepEqual(app.places().slice(before), []);
});

test('a place the parent sent while the app was opening is where it opens', async () => {
  // main.tsx takes such a navigate right after its first drawing, before the page has loaded.
  const app = await open();
  app.navigate('/about.html#settings');
  await app.reads('.title', 'About');
  await app.reads('.section', 'settings');
  await app.placed('/about.html#settings');
  await settled();
  assert.deepEqual(app.places(), ['/about.html#settings'], 'the first place told is the one the parent went to');
  // And on the page it opens on, a named page asked for while it opens.
  const named = await open();
  named.navigate('/#settings');
  await named.reads('.section', 'settings');
  await settled();
  assert.deepEqual(named.places(), ['/#settings']);
  assert.deepEqual([...app.errors, ...named.errors], []);
});

test('Back and Forward between page files open each page there', async () => {
  const app = await open();
  await app.reads('.title', 'Home');
  await app.click('#to-about');
  await app.reads('.title', 'About');
  await app.placed('/about.html#home');
  app.navigate('/#home');
  await app.reads('.title', 'Home');
  await app.placed('/#home');
  app.navigate('/about.html#settings');
  await app.reads('.title', 'About');
  await app.reads('.section', 'settings');
  await app.placed('/about.html#settings');
  // A place that is no page of the app is its main page.
  app.navigate('/gone.html');
  await app.reads('.title', 'Home');
  assert.deepEqual(app.errors, []);
});
