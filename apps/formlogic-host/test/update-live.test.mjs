// node --test apps/formlogic-host/test/update-live.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// An update handed to an app that is really running: core's own composer, live
// app and renderer (from its built dist, as the frame's build takes them), on
// the ZIPP engine the frame is sent, in a jsdom page. The renderer is given
// what main.tsx gives it (the version the app opens with in its props, which
// never change after, and `app={live}`), and the updates go through the frame's
// update.ts. What is held here is what a person would see: the page that
// changed, the count that stayed.
//
// update.test.mjs holds the rules with stand-ins; this holds that the rules
// and the real renderer agree. main.tsx itself is a document's entry and runs
// only in a frame: protocol.test.mjs reads its wiring.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveObjectURL } from 'node:buffer';
import { JSDOM } from 'jsdom';
import { createUpdater, importsFrom } from '../src/update.ts';
import { bundleLanguages } from '../src/engineInit.ts';
import { mediaUrl, releaseMedia, sameMedia } from '../src/media.ts';
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

const MANIFEST = JSON.stringify({ name: 'Counter', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } });
const LOGIC = `import "./words.logic"
let count = 0
let inits = 0
function _init() { inits = inits + 1 }
function inc() { count = count + 1 }
`;
const PAGE = `<logic src="../logic/main.logic" />
<div>
  <button id="inc" @click={inc}>Add</button>
  <span class="count">{count}</span>
  <span class="inits">{inits}</span>
  <span class="word">{word()}</span>
  <img class="dot" src={asset("assets/dot.png")} />
</div>`;
const WORDS = 'function word() { return "first" }\n';
const client = (changes = {}) => ({ 'manifest.json': MANIFEST, 'ui/main.ui': PAGE, 'logic/main.logic': LOGIC, 'logic/words.logic': WORDS, ...changes });

let apps = 0;
/** Open an app as the frame's init does, clicked to a count of three, with an updater on its port. */
async function open(files = client(), assets = { 'assets/dot.png': 'AAAA' }) {
  const text = new Map(Object.entries(files));
  let manifest = JSON.parse(text.get('manifest.json'));
  const media = new Map(Object.entries(assets).map(([path, value]) => [path, mediaUrl(path, value)]));
  const composed = core.composeBundleSource(text, manifest.main, manifest.files?.logic || []);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  const live = core.createLiveApp();
  const posted = [];
  let drawn = false;
  let drawings = 0;
  const errors = [];
  const updates = createUpdater({
    post: reply => posted.push(reply),
    state: () => (drawn ? 'running' : 'opening'),
    languages: bundleLanguages, compose: core.composeBundleSource, mediaUrl, sameMedia, releaseMedia, themeOf: declaredThemeMode,
  });
  const imports = importsFrom(text);
  const appId = `frame-update-${++apps}`;
  const draw = () => {
    drawings++;
    const resolveAsset = path => updates.asset(path);
    root.render(createElement(core.SoftNWithXDB, {
      ...composed, app: live, appId, resumeSavedSyncRoom: false,
      permissionConfig: { permissions: {} }, scriptExecutionMode: 'main',
      assetResolver: resolveAsset, functions: { asset: (...args) => resolveAsset(String(args[0] ?? '')) },
      importResolver: imports,
      onLoad: () => { drawn = true; },
      onError: error => errors.push(error),
    }));
  };
  updates.open({ files: text, media, update: revision => live.update(revision), redraw: next => { manifest = next; draw(); } });
  draw();
  const read = selector => container.querySelector(selector)?.textContent ?? null;
  const reads = async (selector, expected) => {
    for (let i = 0; i < 400 && read(selector) !== expected; i++) await sleep(15);
    assert.equal(read(selector), expected, `${selector}; the page is ${container.innerHTML.slice(0, 500)}; errors: ${errors.map(String).join(' | ')}`);
  };
  const click = async selector => {
    container.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(15);
  };
  /** Post an update as the parent does, and wait for its answer. */
  const update = async (id, files, assets) => {
    updates.receive({ type: 'formlogic:update', id, client: files, ...(assets ? { assets } : {}) });
    for (let i = 0; i < 800 && !posted.some(reply => reply.id === id); i++) await sleep(15);
    const reply = posted.find(entry => entry.id === id);
    assert.ok(reply, `update ${id} was answered; the page is ${container.innerHTML.slice(0, 500)}`);
    return reply;
  };
  await reads('.inits', '1');
  for (let i = 1; i <= 3; i++) {
    await click('#inc');
    await reads('.count', String(i));
  }
  return { container, read, reads, click, update, updates, posted, live, drawings: () => drawings, manifest: () => manifest };
}

test('other markup is drawn where the app stands, with the state it has', async () => {
  const app = await open();
  const reply = await app.update(1, client({ 'ui/main.ui': PAGE.replace('>Add<', '>Add one<').replace('<div>', '<div>\n  <h1 class="title">Counter</h1>') }));
  assert.deepEqual(reply, { type: 'updated', id: 1, outcome: 'updated', changed: ['page'] });
  await app.reads('.title', 'Counter');
  assert.equal(app.read('#inc'), 'Add one');
  // Not started again: the count stands, and its start-up ran the once.
  assert.equal(app.read('.count'), '3');
  assert.equal(app.read('.inits'), '1');
  await app.click('#inc');
  await app.reads('.count', '4');
  // The same files again are nothing to do, and the frame's tree was drawn the once.
  const again = await app.update('again', client({ 'ui/main.ui': PAGE.replace('>Add<', '>Add one<').replace('<div>', '<div>\n  <h1 class="title">Counter</h1>') }));
  assert.deepEqual(again, { type: 'updated', id: 'again', outcome: 'unchanged', changed: [] });
  assert.equal(app.read('.count'), '4');
  assert.equal(app.drawings(), 1);
});

test('other logic starts the app again, and says so', async () => {
  const app = await open();
  const reply = await app.update(2, client({ 'logic/main.logic': LOGIC.replace('count + 1', 'count + 10') }));
  assert.deepEqual(reply, {
    type: 'updated', id: 2, outcome: 'restarted', changed: ['logic'],
    reason: 'Its logic changed. Its variables were carried over, and its start-up ran again.', carried: true,
  });
  // The new logic, over the variables the app had: the count stands, and its start-up ran again.
  await app.reads('.inits', '2');
  await app.reads('.count', '3');
  await app.click('#inc');
  await app.reads('.count', '13');
});

test('a version that does not parse is kept back, and the last one that worked goes on', async () => {
  const app = await open();
  const reply = await app.update(3, client({ 'ui/main.ui': '<logic src="../logic/main.logic" />\n<Stack><span class="count">{count}</span><p>half' }));
  assert.equal(reply.outcome, 'kept');
  assert.equal(reply.id, 3);
  assert.match(reply.problem, /Unclosed tag/);
  assert.ok(!reply.problem.includes('\n') && reply.problem.length <= 300, 'one line, never a stack');
  // The app is as it was, and still answers.
  assert.equal(app.read('.count'), '3');
  assert.equal(app.read('#inc'), 'Add');
  await app.click('#inc');
  await app.reads('.count', '4');
  // Logic that does not parse is kept back the same way.
  const logic = await app.update(4, client({ 'logic/main.logic': `${LOGIC}\nfunction half( {` }));
  assert.equal(logic.outcome, 'kept');
  assert.match(logic.problem, /logic does not parse/);
  assert.equal(app.read('.inits'), '1');
  // And the next version that works is taken.
  const mended = await app.update(5, client({ 'ui/main.ui': PAGE.replace('>Add<', '>More<') }));
  assert.equal(mended.outcome, 'updated');
  await app.reads('#inc', 'More');
  assert.equal(app.read('.count'), '4');
});

test('the logic\'s imports are answered from the files of the update', async () => {
  const app = await open();
  await app.reads('.word', 'first');
  // Only the imported file differs: the page and the logic that imports it are the same text.
  const reply = await app.update(6, client({ 'logic/words.logic': 'function word() { return "second" }\n' }));
  assert.equal(reply.outcome, 'restarted');
  assert.deepEqual(reply.changed, ['logic']);
  await app.reads('.word', 'second');
  // The version that is running is the one whose files answer.
  assert.equal(await app.live.shown.importResolver('/logic/words.logic'), 'function word() { return "second" }\n');
  // A version that is kept back does not change where the running one reads from.
  const kept = await app.update(7, client({ 'logic/words.logic': 'function word( {', 'logic/main.logic': LOGIC }));
  assert.equal(kept.outcome, 'kept');
  assert.equal(await app.live.shown.importResolver('/logic/words.logic'), 'function word() { return "second" }\n');
  assert.equal(app.read('.word'), 'second');
});

test('other media is shown without starting anything again, and the frame\'s tree drawn again keeps the version it has', async () => {
  const app = await open();
  const dot = () => app.container.querySelector('.dot')?.getAttribute('src');
  // What the picture's address serves, as base64; null where it serves nothing.
  const shows = async () => {
    const blob = resolveObjectURL(dot());
    return blob ? `${blob.type};${Buffer.from(await blob.arrayBuffer()).toString('base64')}` : null;
  };
  const first = dot();
  assert.match(first, /^blob:/);
  assert.equal(await shows(), 'image/png;AAAA');
  // A version first, so the tree's own props (the version the app opened with) are no longer what is on screen.
  const renamed = client({ 'ui/main.ui': PAGE.replace('>Add<', '>Add one<') });
  assert.equal((await app.update(8, renamed)).outcome, 'updated');
  await app.reads('#inc', 'Add one');
  const reply = await app.update(9, renamed, { 'assets/dot.png': 'BBBB' });
  assert.deepEqual(reply, { type: 'updated', id: 9, outcome: 'updated', changed: ['media'] });
  for (let i = 0; i < 200 && dot() === first; i++) await sleep(15);
  const second = dot();
  assert.notEqual(second, first);
  assert.equal(await shows(), 'image/png;BBBB');
  assert.equal(app.drawings(), 2, 'the tree was drawn again for the media, with the props it opened with');
  await sleep(100);
  // Still the version it was handed, and nothing started again.
  assert.equal(app.read('#inc'), 'Add one');
  assert.equal(app.read('.count'), '3');
  assert.equal(app.read('.inits'), '1');
  // Media left out is media as it is; the same media sent again, as bytes this time, is nothing to do,
  // and the picture keeps its address.
  assert.equal((await app.update(10, renamed)).outcome, 'unchanged');
  assert.equal((await app.update(11, renamed, { 'assets/dot.png': new Uint8Array(Buffer.from('BBBB', 'base64')) })).outcome, 'unchanged');
  assert.equal(dot(), second);
  assert.equal(app.drawings(), 2);
  // The page was given the first picture's address, so it still serves what it did.
  assert.equal(resolveObjectURL(first)?.size, 3);
  // A version kept back takes its media back with it.
  const kept = await app.update(12, client({ 'ui/main.ui': '<Stack><p>half' }), { 'assets/dot.png': 'CCCC' });
  assert.equal(kept.outcome, 'kept');
  await sleep(50);
  assert.equal(dot(), second);
  assert.equal(await shows(), 'image/png;BBBB');
  assert.equal(app.read('#inc'), 'Add one');
  // The app goes on from where it was.
  await app.click('#inc');
  await app.reads('.count', '4');
});

test('a Python app is handed its newer modules, and starts again with them', async () => {
  const python = app => ({
    'manifest.json': JSON.stringify({ name: 'Counter', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/app.py'] } }),
    'ui/main.ui': '<logic src="../logic/app.py" />\n<div>\n  <button id="inc" @click={inc()}>Add</button>\n  <span class="count">{count}</span>\n  <span class="inits">{inits}</span>\n  <span class="word">{word}</span>\n</div>',
    'logic/app.py': app,
  });
  const APP = 'count = 0\ninits = 0\nword = "first"\n\ndef _init():\n    global inits\n    inits = inits + 1\n\ndef inc():\n    global count\n    count = count + 1\n';
  const app = await open(python(APP), {});
  await app.reads('.word', 'first');
  // Markup alone is drawn where the app stands, as for any app.
  const renamed = python(APP);
  renamed['ui/main.ui'] = renamed['ui/main.ui'].replace('>Add<', '>Add one<');
  assert.deepEqual(await app.update(1, renamed), { type: 'updated', id: 1, outcome: 'updated', changed: ['page'] });
  await app.reads('#inc', 'Add one');
  assert.equal(app.read('.count'), '3');
  // Another module is other logic: Python's variables cannot be carried, and the answer says so.
  const reply = await app.update(2, { ...renamed, 'logic/app.py': APP.replace('"first"', '"second"') });
  assert.equal(reply.outcome, 'restarted');
  assert.deepEqual(reply.changed, ['logic']);
  assert.equal(reply.carried, false);
  assert.match(reply.reason, /Python/);
  await app.reads('.word', 'second');
  await app.reads('.count', '0');
  await app.click('#inc');
  await app.reads('.count', '1');
});

test('versions posted faster than the app can follow are one version, and each is answered', async () => {
  const app = await open();
  const page = label => client({ 'ui/main.ui': PAGE.replace('>Add<', `>${label}<`) });
  for (const [id, label] of [['a', 'One'], ['b', 'Two'], ['c', 'Three'], ['d', 'Four']]) {
    app.updates.receive({ type: 'formlogic:update', id, client: page(label) });
  }
  for (let i = 0; i < 800 && app.posted.length < 4; i++) await sleep(15);
  assert.deepEqual(app.posted.map(reply => [reply.id, reply.outcome]), [['a', 'updated'], ['b', 'updated'], ['c', 'updated'], ['d', 'updated']]);
  await app.reads('#inc', 'Four');
  assert.equal(app.read('.count'), '3');
  assert.equal(app.read('.inits'), '1');
});
