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

test('an error says whether the app failed to open or failed while running', () => {
  assert.match(main, /port\?\.postMessage\(\{ type: 'error', reason, phase \}\);/);
  // Before the first page is drawn it is a load failure; after, a runtime one.
  assert.match(main, /onLoad=\{\(\) => \{ drawn = true; \}\}/);
  assert.match(main, /onError=\{error => reportError\(reasonOf\(error\), drawn \? 'runtime' : 'load'\)\}/);
  // What replaces the app with the frame's own message is a load failure.
  assert.match(main, /componentDidCatch\(error: unknown\) \{ reportError\(reasonOf\(error\), 'load'\); \}/);
  assert.match(main, /reportError\(reason, 'load'\);/);
  assert.ok(!/reportError\([^,()]*\)/.test(main.replace(/function reportError\([^)]*\)/, '')), 'every report names its phase');
});
