// node --test apps/formlogic-host/test/storage-limits.test.mjs
//
// How much an app may keep: STORAGE_LIMITS, which a parent may raise for the five limits it can
// name (`init.storageLimits`), up to STORAGE_MAXIMA. A game's saved state is hundreds of kilobytes
// a slot, past the 30,000 units a value could hold. And the store's size is kept as it changes,
// to the unit `JSON.stringify` of the whole store gives, which was measured on every save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_LIMITS, STORAGE_MAXIMA, installAppStorage, storageLimits } from '../src/storage.ts';
import { grantedPermissions } from '../src/permissions.ts';
import { createBackendQueue } from '../src/backendQueue.ts';

// One document for the whole file (this file runs in a process of its own): each store installs
// itself as `window.localStorage` on a window of its own, made per store below.
const elements = new Map();
globalThis.document = {
  getElementById: id => elements.get(id),
  createElement: () => ({ setAttribute() {}, style: {}, remove() { elements.delete(this.id); } }),
  body: { prepend: element => elements.set(element.id, element) },
};

function fixture(t, snapshot = {}, options = {}) {
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const posted = [];
  const queue = createBackendQueue({ post: message => posted.push(message), maxInFlight: 4 });
  const adapter = installAppStorage(snapshot, (input, lifecycle) => queue.call('nativeStorage', input, lifecycle), { acknowledged: options.acknowledged !== false, limits: options.limits });
  t.after(() => { adapter.dispose(); queue.dispose?.('test closed'); });
  return { ...adapter, posted, queue, api: adapter.acknowledgedPersistence };
}

const quota = error => error instanceof DOMException && error.name === 'QuotaExceededError';

test('no offer, or one that is not an object, keeps the limits every parent had', () => {
  for (const offer of [undefined, null, 5, 'big', [], [1, 2]]) assert.deepEqual(storageLimits(offer), { ...STORAGE_LIMITS }, String(offer));
});

test('a parent raises the five limits it can name, up to the maxima, and never lowers one', () => {
  const raised = storageLimits({ value: 4 * 1024 * 1024, map: 32 * 1024 * 1024, entries: 500, input: 4 * 1024 * 1024 + 1024, queued: 16 * 1024 * 1024 });
  assert.equal(raised.value, 4 * 1024 * 1024);
  assert.equal(raised.map, 32 * 1024 * 1024);
  assert.equal(raised.entries, 500);
  assert.equal(raised.input, 4 * 1024 * 1024 + 1024);
  assert.equal(raised.queued, 16 * 1024 * 1024);
  const capped = storageLimits({ value: 1e12, map: Number.MAX_SAFE_INTEGER, entries: 1e9 });
  assert.equal(capped.value, STORAGE_MAXIMA.value);
  assert.equal(capped.map, STORAGE_MAXIMA.map);
  assert.equal(capped.entries, STORAGE_MAXIMA.entries);
  const lowered = storageLimits({ value: 10, map: 0, entries: -1, input: 1, queued: 1 });
  assert.deepEqual(lowered, { ...STORAGE_LIMITS }, 'a lower number is not taken');
});

test('what the parent cannot name, and anything not a whole number, stays as it was', () => {
  const offer = { key: 4096, outstanding: 1000, deadline: 1, value: 1.5e5 + 0.5, map: '9999999', entries: NaN, input: Infinity };
  assert.deepEqual(storageLimits(offer), { ...STORAGE_LIMITS });
  const inherited = Object.create({ value: 1_000_000 });
  assert.equal(storageLimits(inherited).value, STORAGE_LIMITS.value, 'an inherited field raises nothing');
  const accessor = Object.defineProperty({}, 'map', { get() { throw new Error('accessor must not run'); } });
  assert.equal(storageLimits(accessor).map, STORAGE_LIMITS.map);
});

test('a save of a few hundred kilobytes is refused under the old limits and kept under raised ones', t => {
  const save = 'x'.repeat(229_000);
  const old = fixture(t);
  assert.throws(() => old.storage.setItem('game.v1.manual0', save), quota);
  const raised = fixture(t, {}, { limits: storageLimits({ value: 4 * 1024 * 1024, map: 32 * 1024 * 1024, input: 4 * 1024 * 1024 + 1024, queued: 16 * 1024 * 1024 }) });
  raised.storage.setItem('game.v1.manual0', save);
  assert.equal(raised.storage.getItem('game.v1.manual0'), save);
  assert.equal(raised.posted.at(-1).input.value.length, save.length, 'it went to the parent whole');
});

test('the store is measured as JSON.stringify measures it, through every kind of change', t => {
  // Keys and values that JSON escapes, so a measure of raw lengths would come out short.
  const snapshot = { 'a"b': 'line\nbreak', plain: 'v', [`tab\t`]: ' ', '__proto__': 'own key' };
  const exact = map => JSON.stringify(Object.fromEntries(map)).length;
  let random = 7;
  const next = () => (random = (random * 1103515245 + 12345) % 2147483648);
  for (let round = 0; round < 40; round++) {
    const mirror = new Map(Object.entries(snapshot));
    const operations = [];
    for (let step = 0; step < 25; step++) {
      const kind = next() % 10;
      const key = ['a"b', 'plain', 'tab\t', '__proto__', 'k' + (next() % 6), 'é\\'][next() % 6];
      const value = ['', 'x'.repeat(next() % 40), '"quoted"', '\\', '\u0000\u001f', 'é'][next() % 6];
      if (kind < 5) operations.push({ operation: 'set', key, value });
      else if (kind < 8) operations.push({ operation: 'remove', key });
      else if (kind < 9) operations.push({ operation: 'batch', replacements: [{ key, value }, { key: key + '2', value: value + 'y' }] });
      else operations.push({ operation: 'clear' });
    }
    // Played on a mirror, the exact length after each change; the store must refuse at that
    // length less one and take it at that length, so its measure is the same number.
    const lengths = [];
    for (const op of operations) {
      if (op.operation === 'clear') mirror.clear();
      else if (op.operation === 'remove') mirror.delete(op.key);
      else if (op.operation === 'set') mirror.set(op.key, op.value);
      else for (const item of op.replacements) mirror.set(item.key, item.value);
      lengths.push(exact(mirror));
    }
    const play = (limit, upTo) => {
      const f = fixture(t, snapshot, { acknowledged: true, limits: { ...STORAGE_LIMITS, map: limit, queued: 1e9, input: 1e9 } });
      for (let index = 0; index < upTo; index++) {
        const op = operations[index];
        if (op.operation === 'clear') f.storage.clear();
        else if (op.operation === 'remove') f.storage.removeItem(op.key);
        else if (op.operation === 'set') f.storage.setItem(op.key, op.value);
        else f.api.replaceBatch(op.replacements);
      }
      return f;
    };
    for (let index = 0; index < operations.length; index++) {
      const largest = Math.max(exact(new Map(Object.entries(snapshot))), ...lengths.slice(0, index + 1));
      // Taken at exactly the largest size it reaches...
      play(largest, index + 1);
      // ...and refused, at the step that reaches it, one unit below.
      if (lengths[index] === largest && index > 0 && lengths[index] > Math.max(...lengths.slice(0, index), exact(new Map(Object.entries(snapshot))))) {
        assert.throws(() => play(largest - 1, index + 1), quota, `round ${round} step ${index}`);
      }
    }
  }
});

test('the parent grants files and nothing else, and only as a plain own true', () => {
  assert.deepEqual(grantedPermissions({ files: true }), { permissions: { files: { enabled: true } } });
  for (const offer of [undefined, null, true, 'files', [], { files: 'true' }, { files: 1 }, { files: { enabled: true } }, { net: true, camera: true }, Object.create({ files: true })]) {
    assert.deepEqual(grantedPermissions(offer), { permissions: {} }, JSON.stringify(offer));
  }
  const accessor = Object.defineProperty({}, 'files', { get() { throw new Error('accessor must not run'); } });
  assert.deepEqual(grantedPermissions(accessor), { permissions: {} });
  assert.deepEqual(grantedPermissions({ files: true, net: true, sync: true }), { permissions: { files: { enabled: true } } }, 'the network is never granted');
});
