// node --test apps/formlogic-host/test/backendQueue.test.mjs
// (Node 24 runs the TypeScript module directly; it uses only erasable syntax.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendQueue, BACKEND_BUSY, BACKEND_TIMEOUT, BACKEND_UNREADABLE } from '../src/backendQueue.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('calls past the in-flight limit wait and go out as answers arrive, in order', async () => {
  const posted = [];
  const queue = createBackendQueue({ post: m => posted.push(m), maxInFlight: 2, maxQueued: 32, timeoutMs: 1000 });
  const answers = ['a', 'b', 'c', 'd', 'e'].map(action => queue.call(action, { n: action }));
  assert.equal(posted.length, 2, 'two sent at once');
  assert.deepEqual(posted.map(m => m.action), ['a', 'b']);
  assert.equal(queue.waiting, 3);
  assert.ok(queue.settle(posted[0].id, { ok: 'a' }));
  assert.equal(posted.length, 3, 'a free slot sends the next waiting call');
  assert.equal(posted[2].action, 'c');
  // Answer whatever is in flight until every call has been sent and answered.
  while (queue.inFlight > 0 || queue.waiting > 0) {
    for (const m of posted) queue.settle(m.id, { ok: m.action });
    await tick();
  }
  assert.equal(posted.length, 5);
  assert.deepEqual(await Promise.all(answers), [{ ok: 'a' }, { ok: 'b' }, { ok: 'c' }, { ok: 'd' }, { ok: 'e' }]);
  assert.equal(queue.inFlight, 0);
  assert.equal(queue.waiting, 0);
  assert.equal(posted.every(m => m.type === 'call' && Number.isSafeInteger(m.id) && typeof m.input === 'object'), true, 'wire shape unchanged');
});

test('the queue refuses only when the waiting line is full, with a message that says so', async () => {
  const queue = createBackendQueue({ post: () => {}, maxInFlight: 1, maxQueued: 2, timeoutMs: 1000 });
  queue.call('first', {});
  queue.call('second', {});
  queue.call('third', {});
  assert.equal(queue.waiting, 2);
  assert.deepEqual(await queue.call('fourth', {}), { error: BACKEND_BUSY });
});

test('a sent call times out on its own clock and frees its slot', async () => {
  const posted = [];
  const queue = createBackendQueue({ post: m => posted.push(m), maxInFlight: 1, maxQueued: 4, timeoutMs: 15 });
  const late = queue.call('slow', {});
  const next = queue.call('next', {});
  assert.deepEqual(await late, { error: BACKEND_TIMEOUT });
  assert.equal(posted.length, 2, 'the waiting call was sent when the slot freed');
  queue.settle(posted[1].id, 'done');
  assert.equal(await next, 'done');
  assert.equal(queue.settle(posted[0].id, 'too late'), false, 'a stale answer is ignored');
});

test('an unreadable reply fails what is in flight, not what is waiting', async () => {
  const posted = [];
  const queue = createBackendQueue({ post: m => posted.push(m), maxInFlight: 2, maxQueued: 4, timeoutMs: 1000 });
  const a = queue.call('a', {});
  const b = queue.call('b', {});
  const c = queue.call('c', {});
  assert.equal(queue.failInFlight(BACKEND_UNREADABLE), 2);
  assert.deepEqual(await a, { error: BACKEND_UNREADABLE });
  assert.deepEqual(await b, { error: BACKEND_UNREADABLE });
  assert.equal(posted.length, 3, 'c was sent once the slots freed');
  queue.settle(posted[2].id, 'c-ok');
  assert.equal(await c, 'c-ok');
});

test('a port that throws answers the caller at once', async () => {
  const queue = createBackendQueue({ post: () => { throw new DOMException('cannot clone', 'DataCloneError'); }, maxInFlight: 1, timeoutMs: 1000 });
  assert.deepEqual(await queue.call('x', {}), { error: 'cannot clone' });
  assert.equal(queue.inFlight, 0);
});
