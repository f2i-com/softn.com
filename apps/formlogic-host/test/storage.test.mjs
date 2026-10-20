// node --test apps/formlogic-host/test/storage.test.mjs
// (Node 24 runs the TypeScript module directly; it uses only erasable syntax.)
//
// The alert a failed save of the app's browser session shows. It was drawn in
// fixed light colours, a pale orange page with dark orange text, whatever the
// side the app is drawn in: a light strip across a dark app. It takes the
// theme's colours now: the provider writes them on this frame's document,
// which is one app's whole document (see appTheme.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as storageModule from '../src/storage.ts';
const { STORAGE_ALERT_STYLE, STORAGE_LIMITS, installAppStorage } = storageModule;
import { createBackendQueue } from '../src/backendQueue.ts';

test('the storage alert is drawn in the theme the app is drawn in', () => {
  assert.equal(typeof STORAGE_ALERT_STYLE, 'string');
  assert.match(STORAGE_ALERT_STYLE, /color:\s*var\(--color-text\b/);
  assert.match(STORAGE_ALERT_STYLE, /background:[^;]*var\(--color-surface\b/);
  assert.match(STORAGE_ALERT_STYLE, /var\(--color-warning-500\b/, 'still marked as a warning');
  assert.doesNotMatch(STORAGE_ALERT_STYLE, /#fff7ed|#9a3412/i, 'no fixed light colours');
});

const microtasks = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const acknowledged = { result: { saved: true } };
const malformedAcknowledgments = () => [
  { name: 'inherited result', reply: Object.create({ result: { saved: true } }) },
  { name: 'inherited saved', reply: { result: Object.create({ saved: true }) } },
  { name: 'inner array carrying saved', reply: { result: Object.assign([], { saved: true }) } },
  { name: 'inner null', reply: { result: null } },
  { name: 'inner primitive', reply: { result: true } },
  { name: 'inner function carrying saved', reply: { result: Object.assign(() => {}, { saved: true }) } },
  { name: 'undefined error field', reply: { result: { saved: true }, error: undefined } },
  { name: 'inherited error field', reply: Object.assign(Object.create({ error: 'failed' }), acknowledged) },
  { name: 'result accessor', reply: Object.defineProperty({}, 'result', { get() { throw new Error('accessor must not run'); } }) },
  { name: 'saved accessor', reply: { result: Object.defineProperty({}, 'saved', { get() { throw new Error('accessor must not run'); } }) } },
];
function fixture(t, snapshot = {}, options = {}) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const elements = new Map(), listeners = new Map();
  globalThis.window = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
  };
  globalThis.document = {
    getElementById: id => elements.get(id),
    createElement: () => ({ setAttribute() {}, style: {}, remove() { elements.delete(this.id); } }),
    body: { prepend: element => elements.set(element.id, element) },
  };
  const posted = [];
  const queue = createBackendQueue({ post: message => posted.push(message), maxInFlight: options.maxInFlight ?? 4 });
  const adapter = installAppStorage(snapshot, (input, lifecycle) => queue.call('nativeStorage', input, lifecycle), { acknowledged: options.acknowledged !== false, deadlineMs: options.deadlineMs });
  t.after(() => { adapter?.dispose(); queue.dispose?.('test closed'); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  return { ...adapter, posted, queue, listeners, elements, api: adapter.acknowledgedPersistence };
}

test('synchronous cache and own receipts distinguish pending writes from confirmed state, in FIFO order', async t => {
  const f = fixture(t, { prior: 'kept' });
  const seen = [];
  f.api.subscribe(status => seen.push(status));
  const first = f.api.setItem('session', 'synthetic-token');
  const second = f.api.setItem('avatar', 'synthetic-avatar');
  assert.equal(f.storage.getItem('session'), 'synthetic-token');
  assert.equal(first.state, 'pending');
  assert.deepEqual(f.confirmedSnapshot(), { prior: 'kept' });
  assert.equal(f.posted.length, 1);
  assert.equal(f.api.getStatus().pendingWrites, 2);
  assert.ok(Object.isFrozen(first));
  f.queue.settle(f.posted[0].id, acknowledged);
  await first.completion; await microtasks();
  assert.equal(first.state, 'confirmed');
  assert.equal(second.state, 'pending');
  assert.equal(f.posted.length, 2);
  f.queue.settle(f.posted[1].id, acknowledged);
  await second.completion;
  assert.deepEqual(f.confirmedSnapshot(), { prior: 'kept', session: 'synthetic-token', avatar: 'synthetic-avatar' });
  assert.ok(seen.some(status => status.pendingWrites === 2));
  assert.equal(f.api.getStatus().pendingWrites, 0);
  assert.equal(f.elements.has('app-storage-error'), false);
});

test('malformed, false and error acknowledgments never succeed or erase earlier failure', async t => {
  const f = fixture(t, { kept: 'original' });
  for (const reply of [null, {}, { result: {} }, { result: { saved: false } }, { result: { saved: 'true' } }, { error: 'sensitive-value', result: { saved: true } }]) {
    const receipt = f.api.setItem('kept', 'optimistic');
    f.queue.settle(f.posted.at(-1).id, reply);
    await assert.rejects(receipt.completion, /not confirmed/);
    assert.equal(receipt.state, 'failed');
  }
  assert.deepEqual(f.confirmedSnapshot(), { kept: 'original' });
  const later = f.api.setItem('other', 'accepted');
  f.queue.settle(f.posted.at(-1).id, acknowledged);
  await later.completion;
  assert.equal(f.api.getStatus().failedWrites, 6);
  await assert.rejects(f.api.captureBarrier());
  assert.doesNotMatch(f.elements.get('app-storage-error').textContent, /sensitive-value|optimistic/);
  await f.api.whenIdle();
});

test('normal acknowledgments require own data fields and reject inherited, array, primitive and accessor shapes', async t => {
  const f = fixture(t, { kept: 'original' });
  for (const { name, reply } of malformedAcknowledgments()) {
    const receipt = f.api.setItem('kept', 'optimistic');
    f.queue.settle(f.posted.at(-1).id, reply);
    await assert.rejects(receipt.completion, /not confirmed/, name);
    assert.equal(receipt.state, 'failed', name);
    assert.deepEqual(f.confirmedSnapshot(), { kept: 'original' }, name);
  }
  assert.equal(f.api.getStatus().failedWrites, malformedAcknowledgments().length);
  // Null prototypes are valid cloned-data shapes when both required fields
  // are owned. They do not need Object.prototype methods to acknowledge.
  const result = Object.assign(Object.create(null), { saved: true });
  const reply = Object.assign(Object.create(null), { result });
  const valid = f.api.setItem('valid', 'confirmed');
  f.queue.settle(f.posted.at(-1).id, reply);
  await valid.completion;
  assert.equal(valid.state, 'confirmed');
  assert.equal(f.confirmedSnapshot().valid, 'confirmed');
});

test('late acknowledgments use the same strict own-data validation and never re-resolve rejected receipts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture(t, { kept: 'original' });
  for (const { name, reply } of malformedAcknowledgments()) {
    const receipt = f.api.setItem('kept', 'optimistic');
    const id = f.posted.at(-1).id;
    t.mock.timers.tick(20000); await microtasks();
    await assert.rejects(receipt.completion, /unknown/, name);
    assert.equal(receipt.state, 'unknown', name);
    assert.equal(f.queue.inFlight, 1, name);
    f.queue.settle(id, reply); await microtasks();
    assert.equal(receipt.state, 'failed', name);
    assert.equal(f.api.getStatus().unknownWrites, 0, name);
    assert.deepEqual(f.confirmedSnapshot(), { kept: 'original' }, name);
    await assert.rejects(receipt.completion, /unknown/, name);
  }
  assert.equal(f.api.getStatus().failedWrites, malformedAcknowledgments().length);
  const valid = f.api.setItem('valid', 'confirmed');
  const id = f.posted.at(-1).id;
  t.mock.timers.tick(20000); await microtasks();
  await assert.rejects(valid.completion, /unknown/);
  f.queue.settle(id, acknowledged); await microtasks();
  assert.equal(valid.state, 'confirmed');
  assert.equal(f.confirmedSnapshot().valid, 'confirmed');
  await assert.rejects(valid.completion, /unknown/);
});

test('full wire preflight preserves UTF-16 limits including escaped input, exact limit and one unit over', async t => {
  const f = fixture(t);
  assert.throws(() => f.storage.setItem('escaped', '\n'.repeat(17000)), /limit/);
  assert.equal(f.storage.getItem('escaped'), null);
  assert.equal(f.posted.length, 0);
  const prefix = '\n'.repeat(16000);
  const envelope = value => JSON.stringify({ operation: 'set', key: 'boundary', value }).length;
  const exact = prefix + 'x'.repeat(STORAGE_LIMITS.input - envelope(prefix));
  assert.equal(envelope(exact), STORAGE_LIMITS.input);
  const receipt = f.api.setItem('boundary', exact);
  assert.throws(() => f.api.setItem('boundary', exact + 'x'), /limit/);
  assert.equal(f.storage.getItem('boundary'), exact);
  f.queue.settle(f.posted[0].id, acknowledged); await receipt.completion;
  assert.throws(() => f.storage.setItem('😀'.repeat(129), 'value'), /limit/);
  const unicode = f.api.setItem('😀'.repeat(128), '😀'.repeat(15000));
  f.queue.settle(f.posted.at(-1).id, acknowledged); await unicode.completion;
  assert.throws(() => f.storage.setItem('plain', 'x'.repeat(30001)), /limit/);
  assert.throws(() => f.storage.removeItem('x'.repeat(257)), /limit/);
});

test('outstanding count and serialized retained-size bounds refuse before cache mutation', async t => {
  const f = fixture(t);
  for (let index = 0; index < 32; index++) f.storage.setItem(`key-${index}`, 'value');
  assert.equal(f.api.getStatus().pendingWrites, 32);
  assert.throws(() => f.storage.setItem('refused', 'value'), /limit/);
  assert.equal(f.storage.getItem('refused'), null);
  assert.equal(f.posted.length, 1);
});

test('serialized retained-size bound is independent of cache map size', t => {
  const bounded = fixture(t);
  // Repeated same-key values keep the map small while the queue retains
  // each caller's immutable input and truthful receipt.
  let admitted = 0;
  while (true) { try { bounded.storage.setItem('same', 'x'.repeat(24000) + admitted); admitted++; } catch { break; } }
  assert.equal(admitted, 10);
  assert.equal(bounded.acknowledgedPersistence.getStatus().pendingWrites, 10);
  assert.equal(bounded.storage.getItem('same').endsWith('9'), true);
  assert.equal(bounded.posted.length, 1);
});

test('batch admission preflights all replacements and freezes one FIFO parent commit', async t => {
  const f = fixture(t, { a: 'old-a', b: 'old-b' });
  assert.throws(() => f.api.replaceBatch([{ key: 'a', value: 'new' }, { key: 'b', value: '\n'.repeat(17000) }]), /limit/);
  assert.deepEqual(f.confirmedSnapshot(), { a: 'old-a', b: 'old-b' });
  assert.equal(f.storage.getItem('a'), 'old-a');
  assert.equal(f.posted.length, 0);
  assert.throws(() => f.api.replaceBatch([{ key: 'a', value: '1' }, { key: 'a', value: '2' }]), /limit/);
  const first = f.api.setItem('a', 'first');
  f.storage.removeItem('b'); f.storage.clear();
  const replacements = [{ key: 'a', value: 'batch-a' }, { key: 'b', value: 'batch-b' }];
  const batch = f.api.replaceBatch(replacements);
  replacements[0].value = 'tampered'; replacements.push({ key: 'c', value: 'tampered' });
  for (let index = 0; index < 4; index++) { f.queue.settle(f.posted[index].id, acknowledged); await microtasks(); }
  await first.completion; await batch.completion;
  assert.deepEqual(f.posted.map(item => item.input.operation), ['set', 'remove', 'clear', 'batch']);
  assert.deepEqual(f.confirmedSnapshot(), { a: 'batch-a', b: 'batch-b' });
  assert.deepEqual(f.posted.at(-1).input.replacements, [{ key: 'a', value: 'batch-a' }, { key: 'b', value: 'batch-b' }]);
});

test('finite receipt barriers and idle capture their own outstanding set', async t => {
  const f = fixture(t);
  const first = f.api.setItem('first', 'value');
  const barrier = f.api.captureBarrier(), idle = f.api.whenIdle();
  const second = f.api.setItem('second', 'value');
  f.queue.settle(f.posted[0].id, acknowledged);
  await first.completion; await barrier; await idle;
  assert.equal(second.state, 'pending');
  f.queue.settle(f.posted[1].id, acknowledged); await second.completion;
});

test('sent timeout stays unknown, blocks admission, expires queued work and observes only its matched late reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture(t);
  const first = f.api.setItem('a', 'first');
  t.mock.timers.tick(1000);
  const second = f.api.setItem('b', 'queued');
  t.mock.timers.tick(19000); await microtasks();
  await assert.rejects(first.completion, /unknown/);
  assert.equal(first.state, 'unknown');
  assert.equal(f.queue.inFlight, 1);
  assert.throws(() => f.storage.setItem('refused', 'value'), /unknown/);
  assert.equal(f.storage.getItem('refused'), null);
  t.mock.timers.tick(1000); await microtasks();
  await assert.rejects(second.completion, /not confirmed/);
  assert.equal(second.state, 'failed');
  assert.equal(f.posted.length, 1);
  f.queue.settle(999, acknowledged); assert.equal(first.state, 'unknown');
  f.queue.settle(f.posted[0].id, acknowledged); await microtasks();
  assert.equal(first.state, 'confirmed');
  assert.equal(f.api.getStatus().unknownWrites, 0);
  assert.equal(f.api.getStatus().failedWrites, 1);
  await assert.rejects(first.completion, /unknown/, 'a rejected receipt never later resolves');
  assert.deepEqual(f.confirmedSnapshot(), { a: 'first' });
  const third = f.api.setItem('c', 'after-late');
  f.queue.settle(f.posted.at(-1).id, acknowledged); await third.completion;
});

test('deadline cancels a storage call blocked behind ordinary requests before it can dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture(t, {}, { maxInFlight: 1 });
  f.queue.call('ordinary', {});
  const receipt = f.api.setItem('a', 'queued');
  t.mock.timers.tick(20000); await microtasks();
  await assert.rejects(receipt.completion, /not confirmed/);
  assert.equal(receipt.state, 'failed');
  assert.equal(f.queue.waiting, 0);
  f.queue.settle(f.posted[0].id, 'late');
  assert.deepEqual(f.posted.map(item => item.action), ['ordinary']);
});

test('disposal rejects outstanding receipts, prevents stale dispatch and releases unload listeners', async t => {
  const f = fixture(t);
  const sent = f.api.setItem('sent', 'optimistic');
  const waiting = f.api.setItem('waiting', 'optimistic');
  assert.equal(f.listeners.has('beforeunload'), true);
  const event = { preventDefault() { this.prevented = true; } };
  f.listeners.get('beforeunload')(event);
  assert.equal(event.prevented, true);
  f.dispose(); f.queue.dispose('closed');
  await assert.rejects(sent.completion, /unknown/);
  await assert.rejects(waiting.completion, /not confirmed/);
  assert.equal(f.posted.length, 1);
  assert.equal(f.listeners.has('beforeunload'), false);
  assert.equal(f.api.getStatus().disposed, true);
  assert.equal(f.api.getStatus().unknownWrites, 1);
  assert.match(f.elements.get('app-storage-error').textContent, /unknown outcome/);
  f.queue.settle(f.posted[0].id, acknowledged);
  assert.deepEqual(f.confirmedSnapshot(), {});
  assert.equal(sent.state, 'unknown');
  assert.equal(f.api.getStatus().unknownWrites, 1);
  assert.throws(() => f.storage.setItem('after', 'value'), /disposed/);
});

test('a matched save reply immediately before disposal remains confirmed', async t => {
  const f = fixture(t);
  const receipt = f.api.setItem('kept', 'confirmed');
  f.queue.settle(f.posted[0].id, acknowledged);
  // No microtask gap: the trusted queue reply observer settles the receipt
  // before a following terminal event, not only in a promise continuation.
  f.dispose(); f.queue.dispose('closed');
  await receipt.completion;
  assert.equal(receipt.state, 'confirmed');
  assert.equal(f.api.getStatus().unknownWrites, 0);
  assert.deepEqual(f.confirmedSnapshot(), { kept: 'confirmed' });
});

test('candidate map and entry caps refuse before cache mutation while existing snapshot values stay readable', async t => {
  const snapshot = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`key-${index}`, 'old']));
  const f = fixture(t, snapshot);
  assert.throws(() => f.storage.setItem('extra', 'value'), /limit/);
  assert.equal(f.storage.length, 200);
  assert.equal(f.storage.getItem('extra'), null);
  assert.equal(f.posted.length, 0);
});

test('serialized candidate map accepts its exact limit and refuses one unit above', async t => {
  const snapshot = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`key-${index}`, 'x'.repeat(30000)]));
  const f = fixture(t, snapshot);
  const base = JSON.stringify({ ...snapshot, boundary: '' }).length;
  const exact = 'x'.repeat(STORAGE_LIMITS.map - base);
  assert.ok(exact.length <= STORAGE_LIMITS.value);
  const receipt = f.api.setItem('boundary', exact);
  assert.equal(JSON.stringify({ ...snapshot, boundary: exact }).length, STORAGE_LIMITS.map);
  assert.throws(() => f.storage.setItem('boundary', exact + 'x'), /limit/);
  assert.equal(f.storage.getItem('boundary'), exact);
  f.queue.settle(f.posted[0].id, acknowledged); await receipt.completion;
});

// A parent that does not negotiate protocol 1 keeps the storage it always had
// (docs/engineering/FORMLOGIC_RUNTIME_REPAIR.md: "Legacy parents retain optimistic synchronous
// storage"). Every answer it gave used to count as a failure here: a save it
// made showed "An app save failed", closing the page always asked first, and
// protocol 1's caps and deadline refused or dropped its writes.
test('old parent capability retains synchronous cache-first writes without advertising durable methods', async t => {
  const f = fixture(t, {}, { acknowledged: false });
  assert.equal(f.api.protocol, 0);
  assert.equal(f.api.setItem, undefined);
  assert.equal(f.storage.setItem('session', 'current-visit'), undefined);
  assert.equal(f.storage.getItem('session'), 'current-visit');
  assert.equal(f.posted[0].action, 'nativeStorage');
  assert.deepEqual(f.posted[0].input, { operation: 'set', key: 'session', value: 'current-visit' });
  assert.equal(f.elements.has('app-storage-error'), false, 'nothing is shown while it saves');
  const event = { preventDefault() { this.prevented = true; } };
  f.listeners.get('beforeunload')?.(event);
  assert.equal(event.prevented, undefined, 'closing the page does not ask');
  // An old parent answers a save without protocol 1's `saved` flag.
  f.queue.settle(f.posted[0].id, { result: {} }); await f.api.whenIdle();
  assert.equal(f.api.getStatus().failedWrites, 0);
  assert.equal(f.elements.has('app-storage-error'), false);
  assert.deepEqual(f.confirmedSnapshot(), { session: 'current-visit' });
});

test('an old parent\'s error reply shows the failed-save alert, and the writes after it still go', async t => {
  const f = fixture(t, {}, { acknowledged: false });
  f.storage.setItem('first', 'one');
  f.queue.settle(f.posted[0].id, { error: 'The backend request timed out.' }); await f.api.whenIdle();
  assert.equal(f.api.getStatus().failedWrites, 1);
  assert.equal(f.api.getStatus().unknownWrites, 0);
  assert.match(f.elements.get('app-storage-error').textContent, /save failed/);
  f.storage.setItem('second', 'two');
  assert.equal(f.posted.length, 2);
  f.queue.settle(f.posted[1].id, { result: {} }); await f.api.whenIdle();
  assert.deepEqual(f.confirmedSnapshot(), { second: 'two' });
});

test('an old parent takes a burst past protocol 1\'s caps and deadline, one write at a time and in order', async t => {
  const f = fixture(t, {}, { acknowledged: false, deadlineMs: 1 });
  for (let index = 0; index < STORAGE_LIMITS.outstanding + 8; index++) f.storage.setItem(`key-${index}`, 'x'.repeat(index));
  f.storage.removeItem('k'.repeat(STORAGE_LIMITS.key + 1));
  assert.equal(f.posted.length, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  for (let index = 0; f.posted.length > index; index++) {
    f.queue.settle(f.posted[index].id, { result: {} }); await microtasks();
  }
  assert.equal(f.posted.length, STORAGE_LIMITS.outstanding + 9, 'every write went, none expired');
  assert.deepEqual(f.posted.slice(0, 3).map(item => item.input.key), ['key-0', 'key-1', 'key-2']);
  assert.equal(f.api.getStatus().failedWrites, 0);
  assert.equal(f.api.getStatus().pendingWrites, 0);
});
