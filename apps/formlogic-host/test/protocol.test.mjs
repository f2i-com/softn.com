// node --test apps/formlogic-host/test/protocol.test.mjs
//
// What the frame adds to its protocol with FormLogic in v0.0.28 and since, read
// from main.tsx: each addition is one an older FormLogic ignores, and each
// takes effect only where the parent asks for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

test('a call waits longer for its answer than FormLogic lets a native request run', () => {
  // FormLogic's NativeAppService gives a native app's request 25 seconds. A call
  // answered as failed before then could be a write that was made.
  const deadline = Number(/const CALL_DEADLINE_MS = (\d+);/.exec(main)?.[1]);
  assert.ok(deadline > 25000, `the deadline is ${deadline} ms`);
  assert.match(main, /timeoutMs: CALL_DEADLINE_MS/);
});

test('saves take a lane of their own only where the parent says it takes them apart', () => {
  // A parent from before the lane counts saves against its four calls: sending
  // more than four at once there would see more of them refused, not fewer.
  assert.match(main, /if \(event\.data\.storageLane === true\) \{\s*storageCalls = createBackendQueue\(/);
  assert.match(main, /firstId: STORAGE_FIRST_ID/);
  assert.match(main, /const lane = storageCalls \?\? calls;/);
  assert.match(main, /lane\.call\('nativeStorage', input, lifecycle\)/);
  // A reply settles the call it names, in whichever lane holds it, and an
  // unreadable one fails both lanes' calls, as it failed the one lane's before.
  assert.match(main, /if \(!calls\.settle\(event\.data\?\.id, event\.data\?\.result\)\) storageCalls\?\.settle\(event\.data\?\.id, event\.data\?\.result\);/);
  assert.match(main, /calls\.failInFlight\(BACKEND_UNREADABLE\); storageCalls\?\.failInFlight\(BACKEND_UNREADABLE\);/);
  assert.match(main, /storageCalls\?\.dispose\(BACKEND_UNREADABLE\);/);
});

test('no app runs in a frame that is not sandboxed', () => {
  // First in the try, before an engine or a file of the app is touched.
  const guard = main.indexOf("if (self.origin !== 'null') throw new Error(");
  assert.ok(guard > 0);
  assert.ok(guard < main.indexOf('acceptEngine(event.data.engine, served)'));
  assert.ok(guard > main.indexOf('  try {'));
});

test('a store that refuses a write says so, where saves are confirmed and nowhere else', () => {
  // Any other frame keeps its records in memory by design, and the notice says so in red.
  assert.match(main, /\{savesAcknowledged && <XDBStorageNotice appId=\{appId\} problemsOnly \/>\}/);
  assert.match(main, /const savesAcknowledged = appStorage\?\.acknowledgedPersistence\.protocol === 1;/);
  assert.ok(main.indexOf('const savesAcknowledged') > main.indexOf('appStorage = installAppStorage('), 'read once the storage is there');
});

test('an error says whether the app failed to open or failed while running', () => {
  assert.match(main, /port\?\.postMessage\(\{ type: 'error', reason, phase \}\);/);
  // Before the first page is drawn it is a load failure; after, a runtime one.
  assert.match(main, /onLoad=\{\(\) => \{ if \(!drawn\) port\?\.postMessage\(\{ type: 'shown' \}\); drawn = true; tellPlace\(\); \}\}/);
  assert.match(main, /onError=\{error => reportError\(reasonOf\(error\), drawn \? 'runtime' : 'load'\)\}/);
  // What replaces the app with the frame's own message is a load failure.
  assert.match(main, /componentDidCatch\(error: unknown\) \{ reportError\(reasonOf\(error\), 'load'\); \}/);
  assert.match(main, /reportError\(reason, 'load'\);/);
  assert.ok(!/reportError\([^,()]*\)/.test(main.replace(/function reportError\([^)]*\)/, '')), 'every report names its phase');
});

test('a parent covering the frame while the app opens is told when its first page is shown, once', () => {
  // ready says it will (an addition: a parent that never sees shown: 1 never waits for it).
  assert.match(main, /type: 'formlogic:ready'[^\n]*, shown: 1(, [^\n]*)? \}, '\*'\);/);
  // Posted from the first draw only, on the app's own port, before drawn is set.
  assert.equal((main.match(/type: 'shown'/g) || []).length, 1);
  // And no words while it opens: core's wheel, labelled for a screen reader.
  assert.match(main, /root\.render\(<LoadingIndicator label="Opening app" \/>\);/);
  assert.doesNotMatch(main, />Opening app…</);
});

test('a newer version of the app is taken on its port, and a frame still takes one init', () => {
  // ready says it will (an addition: a parent that never sees update: 1 never sends one), and the
  // protocol numbers are what they were.
  assert.match(main, /type: 'formlogic:ready'[^\n]*, update: 1(, [^\n]*)? \}, '\*'\);/);
  assert.match(main, /type: 'formlogic:ready', nativeProtocol: 1, storageProtocol: STORAGE_PROTOCOL,/);
  // One init for the life of the frame, as before: a second is not read at all.
  assert.match(main, /if \(started \|\| terminated \|\| event\.source !== parent \|\| event\.data\?\.type !== 'formlogic:init' \|\| !event\.ports\[0\]\) return;\s*started = true;/);
  assert.equal((main.match(/\bstarted = /g) || []).length, 2, 'declared false and set true once, never set back');
  assert.equal((main.match(/addEventListener\('message'/g) || []).length, 1, 'the window listens for init alone');
  // An update comes on the port, and is told apart by its type before anything is read as the
  // answer to a call: its id is the parent's own.
  const update = main.indexOf("if (event.data?.type === 'formlogic:update') { updates.receive(event.data); return; }");
  assert.ok(update > main.indexOf("if (event.data?.type === 'formlogic:dispose') { terminate(); return; }"));
  assert.ok(update < main.indexOf('if (!calls.settle(event.data?.id'));
  // The rules (update.ts) are given this frame's own parts, and are there before any app is open.
  assert.match(main, /languages: bundleLanguages, compose: composeBundleSource, mediaUrl, themeOf: declaredThemeMode,/);
  assert.ok(main.indexOf('const updates = createUpdater<') < main.indexOf("window.addEventListener('message'"));
  // There is an app to update from its first page until it fails to load or the frame ends.
  assert.match(main, /state: \(\) => terminated \? 'closed' : failed \? 'failed' : drawn \? 'running' : 'opening',/);
  assert.match(main, /if \(phase === 'load'\) failed = true;/);
  // The renderer is given the version the page on screen opened with in its props, as it always
  // was, and that page as something to hand the later ones to.
  assert.match(main, /let shown: ShownPage = \{\s*file: start\.file, composed: first, live: createLiveApp\(\), imports: importsFrom\(files\),/);
  assert.match(main, /const \{ composed, live \} = page;/);
  assert.match(main, /<SoftNWithXDB \{\.\.\.composed\} app=\{live\} /);
  assert.match(main, /updates\.open\(\{\s*files, media,\s*(\/\/[^\n]*\n\s*)?update: revision => shown\.live\.update\(revision\),\s*redraw: next => \{ manifest = next; draw\(\); \},/);
  assert.match(main, /leave: revision => show\(null, revision, revision\.importResolver\),\s*\}\);\s*draw\(\);/);
  // The page's media and the first version's imports are read through the same module.
  assert.match(main, /const resolveAsset = \(path: string\) => updates\.asset\(path\);/);
  assert.match(main, /importResolver=\{page\.imports\}/);
  // The tree can be drawn again, so it holds nothing of the init message (the app's files, its
  // media, the engine's bytes), and nothing is drawn in a frame that has ended.
  const draw = main.slice(main.indexOf('const draw = () => {'), main.indexOf('updates.open('));
  assert.match(draw, /^const draw = \(\) => \{\s*if \(terminated\) return;/);
  assert.doesNotMatch(draw, /\bevent\b/);
});

test('a link to another page of the app is shown in the frame, and the parent is told where the app is', () => {
  // ready says it will (an addition: a parent that sends no place and reads none is told nothing it has to read).
  assert.match(main, /type: 'formlogic:ready'[^\n]*, places: 1 \}, '\*'\);/);
  // The renderer asks the frame about each link, and the page's own code is sent to the app's
  // pages or nowhere: any other address the frame goes to is the parent's own page.
  assert.match(main, /key=\{page\.file \?\? ''\} onLink=\{followLink\} pagesOnly/);
  // Decided as SoftN Web decides it, by core's own reading of the bundle, from the files of the
  // version on screen; a link that is not to a page of the app stays the browser's.
  const follow = main.slice(main.indexOf('const followLink = (href: string): boolean => {'), main.indexOf('updates.open('));
  assert.match(follow, /const text = updates\.files\(\);\s*const main = mainPage\(text\);\s*const linked = linkedPage\(text, main, shown\.file, href, bundlePageAt\);\s*if \(linked === null \|\| main === null\) return false;\s*if \(linked\.showing\) return true;/);
  assert.match(follow, /composed = composePage\(text, path\);/);
  assert.match(follow, /show\(linked\.file, composed, importsFrom\(text\)\);\s*return true;/);
  // Another page is another run with a live app of its own, and no named page until its renderer says one.
  assert.match(main, /shown = \{ file, composed, live: createLiveApp\(\), imports \};\s*section = null;\s*draw\(\);\s*tellPlace\(\);/);
  // The place is one message, sent from one line: after shown, never for an app that failed to
  // load or a frame that has ended, and never the same place twice running.
  assert.equal((main.match(/postMessage\(\{ type: 'place'/g) || []).length, 1);
  assert.match(main, /const tellPlace = \(\) => \{\s*if \(!drawn \|\| failed \|\| terminated\) return;\s*const place = writePlace\(\{ file: shown\.file, section \}\);\s*if \(place === told\) return;\s*told = place;\s*port\?\.postMessage\(\{ type: 'place', place \}\);/);
  assert.ok(main.indexOf("port?.postMessage({ type: 'shown' })") < main.indexOf('drawn = true; tellPlace();'));
  // A named page the renderer reports is the app's place only while its page is the one on screen.
  assert.match(main, /onPageChange=\{name => \{ if \(shown === page\) \{ section = name; tellPlace\(\); \} \}\}/);
});

test('the app starts at the place its parent names, held to the app\'s own files', () => {
  // Read once, through place.ts, with core's own reading of which files are pages.
  assert.equal((main.match(/event\.data\.place/g) || []).length, 1);
  assert.match(main, /let start = startPlace\(event\.data\.place, files, mainPage\(files\), bundlePageAt\);/);
  // The main page is composed first whatever the place, so an app that cannot open fails as it did.
  assert.ok(main.indexOf('let first = composeBundleSource(files, manifest.main, manifest.files?.logic || []);') < main.indexOf('let start = startPlace('));
  // A page that cannot be put together is not a place to start: the main page, with no named page.
  assert.match(main, /first = composePage\(files, start\.file\);\s*\} catch \(problem\) \{\s*console\.warn\([^\n]*\);\s*start = \{ file: null, section: null \};/);
  // A named page is given to the renderer as SoftN Web gives one, and nothing is given without one.
  assert.match(main, /initialState: start\.section === null \? undefined : \{ currentPage: start\.section \},/);
  assert.match(main, /initialState=\{page\.initialState\}/);
});

test('an app on another of its pages is handed a newer version of that page', () => {
  // The rules (update.ts) ask where the app stands and whether a version still has that page.
  assert.match(main, /hasPage: \(files, main, path\) => isOtherPage\(files, main, path, bundlePageAt\),/);
  assert.match(main, /page: \(\) => shown\.file,/);
});
