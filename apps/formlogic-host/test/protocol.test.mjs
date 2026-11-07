// node --test apps/formlogic-host/test/protocol.test.mjs
//
// What the frame adds to its protocol with FormLogic in v0.0.28, read from
// main.tsx: each addition is one an older FormLogic ignores, and each takes
// effect only where the parent asks for it.
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
  assert.match(main, /\{savesAcknowledged && <XDBStorageNotice appId=\{event\.data\.appId\} problemsOnly \/>\}/);
  assert.match(main, /const savesAcknowledged = appStorage\?\.acknowledgedPersistence\.protocol === 1;/);
  assert.ok(main.indexOf('const savesAcknowledged') > main.indexOf('appStorage = installAppStorage('), 'read once the storage is there');
});

test('an error says whether the app failed to open or failed while running', () => {
  assert.match(main, /port\?\.postMessage\(\{ type: 'error', reason, phase \}\);/);
  // Before the first page is drawn it is a load failure; after, a runtime one.
  assert.match(main, /onLoad=\{\(\) => \{ if \(!drawn\) port\?\.postMessage\(\{ type: 'shown' \}\); drawn = true; \}\}/);
  assert.match(main, /onError=\{error => reportError\(reasonOf\(error\), drawn \? 'runtime' : 'load'\)\}/);
  // What replaces the app with the frame's own message is a load failure.
  assert.match(main, /componentDidCatch\(error: unknown\) \{ reportError\(reasonOf\(error\), 'load'\); \}/);
  assert.match(main, /reportError\(reason, 'load'\);/);
  assert.ok(!/reportError\([^,()]*\)/.test(main.replace(/function reportError\([^)]*\)/, '')), 'every report names its phase');
});

test('a parent covering the frame while the app opens is told when its first page is shown, once', () => {
  // ready says it will (an addition: a parent that never sees shown: 1 never waits for it).
  assert.match(main, /type: 'formlogic:ready'[^\n]*, shown: 1 \}, '\*'\);/);
  // Posted from the first draw only, on the app's own port, before drawn is set.
  assert.equal((main.match(/type: 'shown'/g) || []).length, 1);
  // And no words while it opens: core's wheel, labelled for a screen reader.
  assert.match(main, /root\.render\(<LoadingIndicator label="Opening app" \/>\);/);
  assert.doesNotMatch(main, />Opening app…</);
});
