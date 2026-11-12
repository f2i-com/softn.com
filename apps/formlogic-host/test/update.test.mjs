// node --test apps/formlogic-host/test/update.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// A newer version of an app's files, handed to a frame while the app runs
// (`formlogic:update` on the port, answered `updated`): what a message has to
// be, which changes a frame cannot take, one version at a time with the newest
// winning, and what is said back. The composer and the running app are
// stand-ins here, with core's contract as far as each test needs it;
// update-live.test.mjs runs the same module against core's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater, importsFrom, planUpdate, readUpdate, sentence, UPDATE_LIMITS } from '../src/update.ts';
import { bundleLanguages } from '../src/engineInit.ts';
import { mediaUrl } from '../src/media.ts';
import { declaredThemeMode } from '../src/appTheme.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const manifest = (extra = {}) => JSON.stringify({ name: 'Notes', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] }, ...extra });
const client = (changes = {}) => ({ 'manifest.json': manifest(), 'ui/main.ui': '<div>{count}</div>', 'logic/main.logic': 'let count = 0', ...changes });
const files = (changes = {}) => new Map(Object.entries(client(changes)));

/** composeBundleSource, as far as these tests need: the main page and the listed logic, or a refusal. */
function compose(text, main, logic) {
  if (!text.has(main)) throw new Error(`Main file not found: ${main}\n    at composePages (source-composer.ts:755)`);
  return { source: text.get(main), logic: logic.map(path => text.get(path) ?? '').join('\n') };
}

/**
 * A running app with core's answers: a page with `<broken` in it is kept back, other logic starts
 * it again, another page is drawn where it stands. `hold()` makes the next update wait to be let go.
 */
function runningApp() {
  const app = { revisions: [], shown: null, held: null };
  app.hold = () => { let release; const gate = new Promise(resolve => { release = resolve; }); app.held = gate; return release; };
  app.update = async revision => {
    app.revisions.push(revision);
    const gate = app.held;
    app.held = null;
    await gate;
    if (revision.source.includes('<broken')) return { outcome: 'kept', changed: [], problem: 'ui/main.ui, line 1, column 1: Unclosed tag\n    at parse (parser.ts:1)' };
    const was = app.shown;
    app.shown = revision;
    if (was && was.logic !== revision.logic) return { outcome: 'restarted', changed: ['logic'], reason: 'Its logic changed. Its variables were carried over, and its start-up ran again.', carried: true };
    if (was && was.source !== revision.source) return { outcome: 'updated', changed: ['page'] };
    return { outcome: 'unchanged', changed: [] };
  };
  return app;
}

/** A frame with an app open and its first page drawn, as main.tsx wires one. */
function frame({ assets = {}, limits } = {}) {
  const posted = [];
  const redraws = [];
  const app = runningApp();
  const opened = files();
  const at = { state: 'running' };
  const updates = createUpdater({
    post: reply => posted.push(reply),
    state: () => at.state,
    languages: bundleLanguages, compose, mediaUrl, themeOf: declaredThemeMode, limits,
  });
  const media = new Map(Object.entries(assets).map(([path, value]) => [path, mediaUrl(path, value)]));
  app.shown = { ...compose(opened, 'ui/main.ui', ['logic/main.logic']), importResolver: importsFrom(opened) };
  updates.open({ files: opened, media, update: revision => app.update(revision), redraw: next => redraws.push(next) });
  const send = (id, text = client(), extra = {}) => updates.receive({ type: 'formlogic:update', id, client: text, ...extra });
  return { updates, posted, redraws, app, at, send };
}

test('an update is a message with an id, the app\'s text files, and its media or none', () => {
  const read = readUpdate({ type: 'formlogic:update', id: 7, client: client() });
  assert.equal(read.id, 7);
  assert.ok(read.client instanceof Map);
  assert.equal(read.client.get('ui/main.ui'), '<div>{count}</div>');
  assert.equal(read.assets, undefined, 'media left out is media as it is');
  assert.equal(readUpdate({ id: 'save-12', client: client(), assets: null }).assets, undefined);
  assert.deepEqual(readUpdate({ id: 'save-12', client: client(), assets: { 'assets/a.png': 'AAAA' } }).assets, { 'assets/a.png': 'AAAA' });
  assert.deepEqual(readUpdate({ id: 1, client: client(), assets: {} }).assets, {}, 'an empty object is no media at all');
  // What is not served is not a reason to refuse, as in init: it is dropped where the media is read.
  assert.equal('refused' in readUpdate({ id: 1, client: client(), assets: { 'assets/a.png': 7 } }), false);
});

test('a malformed update is refused with the id it came with, where it has one', () => {
  for (const message of [undefined, null, 'formlogic:update', 7, [], new Map()]) {
    assert.deepEqual(Object.keys(readUpdate(message)), ['id', 'refused']);
    assert.equal(readUpdate(message).id, null);
  }
  // The id is the parent's own: a number, or a short string.
  for (const id of [undefined, null, {}, [], true, NaN, Infinity, '', 'x'.repeat(65)]) {
    const refused = readUpdate({ id, client: client() });
    assert.equal(refused.id, null, String(id));
    assert.match(refused.refused, /names no id/);
  }
  assert.equal(readUpdate({ id: 'x'.repeat(64), client: client() }).id, 'x'.repeat(64));
  assert.equal(readUpdate({ id: 0, client: client() }).id, 0);
  for (const bad of [undefined, null, 'files', [], new Map([['ui/main.ui', '<div/>']])]) {
    const refused = readUpdate({ id: 3, client: bad });
    assert.equal(refused.id, 3);
    assert.match(refused.refused, /carries no files/);
  }
  assert.match(readUpdate({ id: 3, client: client({ 'ui/main.ui': { text: '<div/>' } }) }).refused, /ui\/main\.ui is not text/);
  for (const bad of ['AAAA', ['AAAA'], 7, new Map()]) assert.match(readUpdate({ id: 3, client: client(), assets: bad }).refused, /media \(assets\) is not an object/);
});

test('an update is held to a size before any of it is composed', () => {
  // init holds its parent to none; the caps are what a SoftN bundle may hold.
  assert.equal(UPDATE_LIMITS.files, 4000);
  assert.equal(UPDATE_LIMITS.text, 32 * 1024 * 1024);
  assert.equal(UPDATE_LIMITS.assets, 4000);
  assert.ok(UPDATE_LIMITS.media >= 64 * 1024 * 1024 * 4 / 3, 'room for the 64 MB of media FormLogic keeps for an app, as base64');
  assert.ok(Object.isFrozen(UPDATE_LIMITS));
  const limits = { ...UPDATE_LIMITS, files: 4, text: 400, assets: 2, media: 12 };
  assert.equal('refused' in readUpdate({ id: 1, client: client() }, limits), false);
  assert.match(readUpdate({ id: 1, client: client({ a: '', b: '' }) }, limits).refused, /carries 5 files, and a frame takes 4 at most/);
  assert.match(readUpdate({ id: 1, client: client({ 'ui/main.ui': 'x'.repeat(400) }) }, limits).refused, /more text than a frame takes/);
  // The paths count too: a parent cannot hide text in them.
  assert.match(readUpdate({ id: 1, client: { ['p'.repeat(401)]: '' } }, limits).refused, /more text than a frame takes/);
  assert.match(readUpdate({ id: 1, client: client(), assets: { a: 'A', b: 'B', c: 'C' } }, limits).refused, /carries 3 media files, and a frame takes 2 at most/);
  assert.match(readUpdate({ id: 1, client: client(), assets: { 'a.png': 'A'.repeat(13) } }, limits).refused, /more media than a frame takes/);
  assert.equal('refused' in readUpdate({ id: 1, client: client(), assets: { 'a.png': 'A'.repeat(12) } }, limits), false);
});

test('a frame takes what it can draw or start again, and nothing that needs another engine, grant or app', () => {
  const had = files();
  const plan = change => planUpdate(had, files(change), bundleLanguages);
  // Taken: pages and logic, and everything of the manifest this frame only composes by or never read.
  assert.deepEqual(plan({ 'ui/main.ui': '<p>new</p>' }), { manifest: JSON.parse(manifest()), main: 'ui/main.ui', logic: ['logic/main.logic'] });
  assert.deepEqual(plan({ 'manifest.json': manifest({ name: 'Renamed', version: '2.0.0', description: 'Other words', icon: 'assets/icon.png' }) }).main, 'ui/main.ui');
  assert.deepEqual(plan({ 'manifest.json': manifest({ files: { ui: ['ui/main.ui'], logic: ['logic/helper.logic', 'logic/main.logic'] } }), 'logic/helper.logic': 'let x = 1' }).logic, ['logic/helper.logic', 'logic/main.logic']);
  assert.ok('main' in plan({ 'manifest.json': manifest({ files: { xdb: ['xdb/tasks.xdb'] } }), 'xdb/tasks.xdb': '{"collection":"tasks","records":[]}' }), 'seed files are carried, and read by nothing');
  assert.ok('main' in plan({ 'manifest.json': manifest({ config: { theme: { mode: 'dark' } } }) }), 'the side it declares is drawn');
  assert.ok('main' in plan({ 'manifest.json': manifest({ config: { window: { width: 900 }, server: { url: 'wss://sync.example' }, execution: 'worker' } }) }));
  assert.deepEqual(plan({ 'manifest.json': manifest({ files: undefined }) }).logic, [], 'no list of logic files, as init reads it');

  // Another main page is another app.
  assert.match(plan({ 'manifest.json': manifest({ main: 'ui/other.ui' }), 'ui/other.ui': '<p/>' }).reopen, /another main page/);
  // What it asks permission for is the parent's to grant before an app opens.
  assert.match(plan({ 'permission.json': '{"permissions":{"files":{"enabled":true}}}' }).reopen, /asks permission for changed/);
  assert.match(plan({ 'manifest.json': manifest({ permissions: { network: true } }) }).reopen, /asks permission for changed/);
  // The engine is chosen once, for the languages the file names declared then, and given its packages then.
  assert.match(plan({ 'logic/model.py': 'x = 1' }).reopen, /now written in javascript and python, where it was javascript, and a frame's engine is chosen when it opens/);
  assert.match(plan({ 'manifest.json': manifest({ config: { python: { packages: ['torch'] } } }) }).reopen, /Python packages it asks for changed/);

  // The same request written out again is the same request.
  const asking = files({ 'permission.json': '{"permissions":{"files":{"enabled":true},"net":{"enabled":false}}}' });
  assert.ok('main' in planUpdate(asking, files({ 'permission.json': '{\n  "permissions": { "net": { "enabled": false }, "files": { "enabled": true } }\n}\n' }), bundleLanguages));
  assert.match(planUpdate(asking, files(), bundleLanguages).reopen, /asks permission for changed/, 'taking the file away asks for something else');
  assert.ok('main' in planUpdate(files({ 'permission.json': '' }), files(), bundleLanguages), 'an empty file is no file');
  // And a Python app stays one: its engine was chosen for it.
  const python = files({ 'logic/model.py': 'x = 1' });
  assert.ok('main' in planUpdate(python, files({ 'logic/model.py': 'x = 2' }), bundleLanguages));
  assert.match(planUpdate(python, files(), bundleLanguages).reopen, /now written in javascript, where it was javascript and python/);
});

test('a manifest that cannot be read is a version with a problem, not a reason for a new frame', () => {
  const had = files();
  const without = files();
  without.delete('manifest.json');
  assert.deepEqual(planUpdate(had, without, bundleLanguages), { problem: 'It has no manifest.json.' });
  assert.deepEqual(planUpdate(had, files({ 'manifest.json': '{ "main": ' }), bundleLanguages), { problem: 'Its manifest.json is not valid JSON.' });
  assert.deepEqual(planUpdate(had, files({ 'manifest.json': '["ui/main.ui"]' }), bundleLanguages), { problem: 'Its manifest.json is not valid JSON.' });
  assert.deepEqual(planUpdate(had, files({ 'manifest.json': '{"name":"Notes"}' }), bundleLanguages), { problem: 'Its manifest names no main page (main).' });
  assert.deepEqual(planUpdate(had, files({ 'manifest.json': '{"main":7}' }), bundleLanguages), { problem: 'Its manifest names no main page (main).' });
});

test('the reply carries the id, and what the running app made of the version', async () => {
  const { posted, send, app } = frame();
  send(41, client({ 'ui/main.ui': '<p>{count}</p>' }));
  await tick();
  assert.deepEqual(posted, [{ type: 'updated', id: 41, outcome: 'updated', changed: ['page'] }]);
  send('save-42', client({ 'ui/main.ui': '<p>{count}</p>', 'logic/main.logic': 'let count = 5' }));
  await tick();
  assert.deepEqual(posted[1], {
    type: 'updated', id: 'save-42', outcome: 'restarted', changed: ['logic'],
    reason: 'Its logic changed. Its variables were carried over, and its start-up ran again.', carried: true,
  });
  send(43, client({ 'ui/main.ui': '<p>{count}</p>', 'logic/main.logic': 'let count = 5' }));
  await tick();
  assert.deepEqual(posted[2], { type: 'updated', id: 43, outcome: 'unchanged', changed: [] });
  assert.equal(app.revisions.length, 3);
});

test('a version with a problem is kept back with the problem in a sentence, and the last one that worked stays', async () => {
  const { posted, send, app, redraws } = frame();
  const shown = app.shown;
  send(1, client({ 'ui/main.ui': '<broken' }));
  await tick();
  // The first line of what the renderer said, and never its stack.
  assert.deepEqual(posted[0], { type: 'updated', id: 1, outcome: 'kept', changed: [], problem: 'ui/main.ui, line 1, column 1: Unclosed tag' });
  assert.equal(app.shown, shown);
  // Files that do not compose never reach the running app: a new frame could not open them either.
  send(2, client({ 'manifest.json': manifest(), 'ui/main.ui': undefined }));
  await tick();
  assert.match(posted[1].reason, /ui\/main\.ui is not text/, 'a file that is not text is a malformed update');
  const gone = client();
  delete gone['ui/main.ui'];
  send(3, gone);
  await tick();
  assert.deepEqual(posted[2], { type: 'updated', id: 3, outcome: 'kept', changed: [], problem: 'Main file not found: ui/main.ui' });
  assert.equal(app.revisions.length, 1, 'only the version that composed was handed over');
  send(4, client({ 'manifest.json': '{ "main": ' }));
  await tick();
  assert.deepEqual(posted[3], { type: 'updated', id: 4, outcome: 'kept', changed: [], problem: 'Its manifest.json is not valid JSON.' });
  // What was kept back changed nothing the next version is compared with: this one's theme is news.
  send(5, client({ 'manifest.json': manifest({ config: { theme: { mode: 'dark' } } }), 'ui/main.ui': '<broken' }));
  await tick();
  assert.equal(posted[4].outcome, 'kept');
  send(6, client({ 'manifest.json': manifest({ config: { theme: { mode: 'dark' } } }) }));
  await tick();
  assert.deepEqual(posted[5], { type: 'updated', id: 6, outcome: 'updated', changed: ['theme'] });
  assert.equal(redraws.length, 1);
  // A running app that fails outright is a version kept back too.
  app.update = async () => { throw new Error('The engine stopped.\n    at run (vm.ts:9)'); };
  send(7, client({ 'ui/main.ui': '<p>x</p>' }));
  await tick();
  assert.deepEqual(posted[6], { type: 'updated', id: 7, outcome: 'kept', changed: [], problem: 'The engine stopped.' });
});

test('a change the frame cannot take answers reopen, with why, and the running app is left alone', async () => {
  const { posted, send, app } = frame();
  send(1, client({ 'manifest.json': manifest({ main: 'ui/other.ui' }), 'ui/other.ui': '<p/>' }));
  send(2, client({ 'permission.json': '{"permissions":{"net":{"enabled":true}}}' }));
  send(3, client({ 'logic/model.py': 'x = 1' }));
  await tick(); await tick(); await tick();
  assert.deepEqual(posted.map(reply => [reply.id, reply.outcome]), [[1, 'reopen'], [2, 'reopen'], [3, 'reopen']]);
  assert.match(posted[0].reason, /another main page/);
  // Gathered: the newest of the two that waited is the one looked at, and both hear of it.
  assert.equal(posted[1].reason, posted[2].reason);
  assert.match(posted[2].reason, /engine is chosen when it opens/);
  assert.equal(app.revisions.length, 0);
  for (const reply of posted) assert.deepEqual(Object.keys(reply), ['type', 'id', 'outcome', 'reason']);
  // A malformed message is answered the same way, at once.
  send(undefined);
  send(9, 'not files');
  assert.deepEqual(posted.slice(3).map(reply => [reply.id, reply.outcome]), [[null, 'reopen'], [9, 'reopen']]);
});

test('there is no app to update before its first page is drawn, after it failed to load, or once the frame has ended', async () => {
  const posted = [];
  const updates = createUpdater({ post: reply => posted.push(reply), state: () => 'running', languages: bundleLanguages, compose, mediaUrl, themeOf: declaredThemeMode });
  // Before init has opened anything, whatever the frame says of itself.
  updates.receive({ type: 'formlogic:update', id: 1, client: client() });
  await tick();
  assert.deepEqual(posted[0], { type: 'updated', id: 1, outcome: 'reopen', reason: 'The app had not opened when the update came, so it has to be opened again with these files.' });

  const { posted: replies, send, app, at, redraws } = frame({ assets: { 'assets/a.png': 'AAAA' } });
  for (const [state, reason] of [['opening', /had not opened/], ['failed', /failed to load/], ['closed', /frame has closed/]]) {
    at.state = state;
    send(state, client({ 'ui/main.ui': '<p/>' }));
    await tick();
    assert.equal(replies.at(-1).outcome, 'reopen', state);
    assert.match(replies.at(-1).reason, reason);
  }
  assert.equal(app.revisions.length, 0);
  // Ended while a version was being taken: nothing is drawn for it, and nothing of it is kept.
  at.state = 'running';
  const release = app.hold();
  send('late', client({ 'ui/main.ui': '<p/>' }), { assets: { 'assets/a.png': 'BBBB' } });
  await tick();
  at.state = 'closed';
  release();
  await tick();
  assert.deepEqual(replies.at(-1), { type: 'updated', id: 'late', outcome: 'reopen', reason: 'This frame has closed.' });
  assert.equal(redraws.length, 0);
});

test('the logic\'s imports are answered from the files of the version it belongs to', async () => {
  const { posted, send, app } = frame();
  const first = app.shown.importResolver;
  assert.equal(await first('/logic/main.logic'), 'let count = 0');
  send(1, client({ 'logic/main.logic': 'let count = 1', 'logic/helper.logic': 'let step = 2' }));
  await tick();
  assert.equal(posted[0].outcome, 'restarted');
  const taken = app.revisions[0].importResolver;
  assert.notEqual(taken, first, 'a resolver of its own, so the renderer looks at what it imports again');
  // From the bundle's root, with or without the slash the runtime writes.
  assert.equal(await taken('/logic/main.logic'), 'let count = 1');
  assert.equal(await taken('logic/helper.logic'), 'let step = 2');
  assert.equal(await taken('/logic/missing.logic'), null);
  // The version before it still reads its own: a version kept back runs on beside a newer set of files.
  assert.equal(await first('/logic/main.logic'), 'let count = 0');
  assert.equal(await first('/logic/helper.logic'), null);
});

test('other media reaches the page, and goes back with a version that is kept back', async () => {
  const { updates, posted, send, redraws, app } = frame({ assets: { 'assets/a.png': 'AAAA', 'assets/b.png': 'BBBB' } });
  assert.equal(updates.asset('assets/a.png'), 'data:image/png;base64,AAAA');
  assert.equal(updates.asset('./assets/a.png'), 'data:image/png;base64,AAAA');
  assert.equal(updates.asset('assets/none.png'), '');
  // Left out: as it is. The same again: nothing to do, and nothing drawn.
  send(1);
  send(2, client(), { assets: { 'assets/a.png': 'AAAA', 'assets/b.png': 'BBBB' } });
  await tick(); await tick();
  assert.deepEqual(posted.map(reply => reply.outcome), ['unchanged', 'unchanged']);
  assert.equal(redraws.length, 0);
  // Other media with the same text: drawn again where the app stands, and said.
  send(3, client(), { assets: { 'assets/a.png': 'CCCC', 'assets/new.mp3': 'DDDD', 'assets/page.html': 'EEEE', 'assets/n.png': 7 } });
  await tick();
  assert.deepEqual(posted[2], { type: 'updated', id: 3, outcome: 'updated', changed: ['media'] });
  assert.equal(redraws.length, 1);
  assert.deepEqual(redraws[0], JSON.parse(manifest()));
  assert.equal(updates.asset('assets/a.png'), 'data:image/png;base64,CCCC');
  assert.equal(updates.asset('assets/new.mp3'), 'data:audio/mpeg;base64,DDDD');
  assert.equal(updates.asset('assets/b.png'), '', 'the whole set: what the update does not carry is gone');
  assert.equal(updates.asset('assets/page.html'), '', 'nothing that runs is served, as in init');
  assert.equal(updates.asset('assets/n.png'), '');
  // With a page that changed too, both are said.
  send(4, client({ 'ui/main.ui': '<p>{count}</p>' }), { assets: { 'assets/a.png': 'AAAA' } });
  await tick();
  assert.deepEqual(posted[3], { type: 'updated', id: 4, outcome: 'updated', changed: ['page', 'media'] });
  assert.equal(redraws.length, 2);
  // The new media is there for logic that starts again while the version is taken…
  const release = app.hold();
  send(5, client({ 'ui/main.ui': '<broken' }), { assets: { 'assets/a.png': 'ZZZZ' } });
  await tick();
  assert.equal(updates.asset('assets/a.png'), 'data:image/png;base64,ZZZZ');
  release();
  await tick();
  // …and goes back with a version that is kept back, the page drawn again with what it had.
  assert.equal(posted[4].outcome, 'kept');
  assert.equal(updates.asset('assets/a.png'), 'data:image/png;base64,AAAA');
  assert.equal(redraws.length, 3);
  // An empty object is no media at all.
  send(6, client({ 'ui/main.ui': '<p>{count}</p>' }), { assets: {} });
  await tick();
  assert.deepEqual(posted[5].changed, ['media']);
  assert.equal(updates.asset('assets/a.png'), '');
});

test('media left out is media as the parent last sent it, with a version that was taken or not', async () => {
  const { updates, posted, send, redraws } = frame({ assets: { 'assets/a.png': 'AAAA' } });
  // Other media, with a page the renderer keeps back: the app goes on with the media it had.
  send(1, client({ 'ui/main.ui': '<broken' }), { assets: { 'assets/a.png': 'BBBB' } });
  await tick();
  assert.equal(posted[0].outcome, 'kept');
  assert.equal(updates.asset('assets/a.png'), 'data:image/png;base64,AAAA');
  // The parent mends the page. Its media is what it last sent, so it leaves it out, and it is not lost.
  send(2, client({ 'ui/main.ui': '<p>{count}</p>' }));
  await tick();
  assert.deepEqual(posted[1], { type: 'updated', id: 2, outcome: 'updated', changed: ['page', 'media'] });
  assert.equal(updates.asset('assets/a.png'), 'data:image/png;base64,BBBB');
  // The same for a version kept back before the renderer saw it (a manifest that is not JSON).
  send(3, client({ 'manifest.json': '{' }), { assets: { 'assets/a.png': 'CCCC' } });
  await tick();
  assert.equal(posted[2].outcome, 'kept');
  assert.equal(updates.asset('assets/a.png'), 'data:image/png;base64,BBBB');
  send(4, client({ 'ui/main.ui': '<p>{count}</p>' }));
  await tick();
  assert.deepEqual(posted[3], { type: 'updated', id: 4, outcome: 'updated', changed: ['media'] });
  assert.equal(updates.asset('assets/a.png'), 'data:image/png;base64,CCCC');
  // Once a version is taken there is nothing left over: the same again is nothing to do.
  const drawn = redraws.length;
  send(5, client({ 'ui/main.ui': '<p>{count}</p>' }));
  await tick();
  assert.deepEqual(posted[4], { type: 'updated', id: 5, outcome: 'unchanged', changed: [] });
  assert.equal(redraws.length, drawn);
});

test('updates are taken one at a time, the newest of those that waited wins, and every id is answered', async () => {
  const { updates, posted, send, app } = frame({ assets: { 'assets/a.png': 'AAAA' } });
  const release = app.hold();
  send('a', client({ 'ui/main.ui': '<p>a</p>' }));
  // While the first is being taken: three more, the media sent with the second of them alone.
  send('b', client({ 'ui/main.ui': '<p>b</p>' }));
  send('c', client({ 'ui/main.ui': '<p>c</p>' }), { assets: { 'assets/a.png': 'CCCC' } });
  send('d', client({ 'ui/main.ui': '<p>d</p>' }));
  await tick();
  assert.equal(app.revisions.length, 1, 'one at a time');
  assert.deepEqual(posted, []);
  release();
  await tick(); await tick();
  assert.deepEqual(app.revisions.map(revision => revision.source), ['<p>a</p>', '<p>d</p>'], 'the newest of those that waited, and none between');
  assert.deepEqual(posted.map(reply => reply.id), ['a', 'b', 'c', 'd'], 'in the order they came');
  assert.deepEqual(posted[0], { type: 'updated', id: 'a', outcome: 'updated', changed: ['page'] });
  // What became of the newest, said to each of the three.
  for (const reply of posted.slice(1)) assert.deepEqual({ ...reply, id: 0 }, { type: 'updated', id: 0, outcome: 'updated', changed: ['page', 'media'] });
  // "As it is" for the last of them is as the one before it left it.
  assert.equal(updates.asset('assets/a.png'), 'data:image/png;base64,CCCC');
});

test('a parent that posts without waiting is held to a line, and one reply that cannot be sent strands no other', async () => {
  const { posted, send, app } = frame({ limits: { ...UPDATE_LIMITS, waiting: 2 } });
  const release = app.hold();
  send(1, client({ 'ui/main.ui': '<p>1</p>' }));
  send(2, client({ 'ui/main.ui': '<p>2</p>' }));
  send(3, client({ 'ui/main.ui': '<p>3</p>' }));
  send(4, client({ 'ui/main.ui': '<p>4</p>' }));
  assert.deepEqual(posted, [{ type: 'updated', id: 4, outcome: 'reopen', reason: 'Too many updates are waiting for this frame, so the app has to be opened again.' }]);
  release();
  await tick(); await tick();
  assert.deepEqual(posted.map(reply => [reply.id, reply.outcome]), [[4, 'reopen'], [1, 'updated'], [2, 'updated'], [3, 'updated']]);
  assert.equal(app.revisions.at(-1).source, '<p>3</p>');

  let refuse = true;
  const sent = [];
  const closing = createUpdater({
    post: reply => { if (refuse) { refuse = false; throw new Error('The port is closed'); } sent.push(reply); },
    state: () => 'running', languages: bundleLanguages, compose, mediaUrl, themeOf: declaredThemeMode,
  });
  const other = runningApp();
  const hold = other.hold();
  closing.open({ files: files(), media: new Map(), update: revision => other.update(revision), redraw: () => {} });
  closing.receive({ id: 1, client: client({ 'ui/main.ui': '<p>1</p>' }) });
  closing.receive({ id: 2, client: client({ 'ui/main.ui': '<p>2</p>' }) });
  hold();
  await tick(); await tick();
  assert.deepEqual(sent.map(reply => reply.id), [2]);
});

test('what is said is one line, however much the app or the composer said', () => {
  assert.equal(sentence(new Error('first line\n    at stack (file.ts:1)')), 'first line');
  assert.equal(sentence('x'.repeat(400)).length, 300);
  assert.equal(sentence({ message: 'not an error' }), '');
  assert.equal(sentence(undefined), '');
});
