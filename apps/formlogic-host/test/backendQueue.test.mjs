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

test('a sent call answers at its deadline, and keeps its slot until the parent answers it', async () => {
  // The parent still holds a call the shell has stopped waiting for: it has
  // no deadline of its own, and refuses a fifth call while it holds four.
  // Freed at the deadline, the slot went to a call the parent then refused.
  const posted = [];
  const queue = createBackendQueue({ post: m => posted.push(m), maxInFlight: 1, maxQueued: 4, timeoutMs: 15 });
  const late = queue.call('slow', {});
  const next = queue.call('next', {});
  assert.deepEqual(await late, { error: BACKEND_TIMEOUT });
  assert.equal(posted.length, 1, 'nothing more is sent while the parent holds the slow call');
  assert.equal(queue.inFlight, 1);
  assert.equal(queue.settle(posted[0].id, 'too late'), false, 'a stale answer is not handed to anyone');
  assert.equal(posted.length, 2, 'its answer frees the slot, and the waiting call goes out');
  queue.settle(posted[1].id, 'done');
  assert.equal(await next, 'done');
});

test('a call that cannot be sent before the deadline, every slot still held, answers that it timed out', async () => {
  const posted = [];
  const queue = createBackendQueue({ post: m => posted.push(m), maxInFlight: 1, maxQueued: 4, timeoutMs: 15 });
  queue.call('slow', {});
  const waited = queue.call('waiting', {});
  assert.deepEqual(await waited, { error: BACKEND_TIMEOUT });
  assert.equal(queue.waiting, 0, 'it left the line');
  queue.settle(posted[0].id, 'late');
  assert.deepEqual(posted.map(m => m.action), ['slow'], 'and is not sent afterwards');
});

test('a port that fails frees the slots of calls that had timed out', async () => {
  const posted = [];
  const queue = createBackendQueue({ post: m => posted.push(m), maxInFlight: 1, maxQueued: 4, timeoutMs: 15 });
  assert.deepEqual(await queue.call('slow', {}), { error: BACKEND_TIMEOUT });
  const next = queue.call('next', {});
  assert.equal(queue.failInFlight(BACKEND_UNREADABLE), 0, 'no caller was still waiting on the slow call');
  assert.equal(queue.inFlight, 1, 'the next call took the freed slot');
  queue.settle(posted[1].id, 'ok');
  assert.equal(await next, 'ok');
});

test('the frame never has more calls outstanding at the parent than the parent allows', async () => {
  // FormLogic's HostedAppFrame: four at a time, the rest refused with
  // "Please wait for the current request.", and no deadline on its side.
  let held = 0;
  let refused = 0;
  const parent = [];
  // `queue` is read when the parent answers, after it exists.
  const post = m => {
    if (held >= 4) {
      refused++;
      setTimeout(() => queue.settle(m.id, { error: 'Please wait for the current request.' }), 0);
      return;
    }
    held++;
    parent.push(m);
  };
  const queue = createBackendQueue({ post, maxInFlight: 4, maxQueued: 32, timeoutMs: 15 });
  const slow = [1, 2, 3, 4].map(() => queue.call('slow', {}));
  assert.deepEqual(await Promise.all(slow), Array(4).fill({ error: BACKEND_TIMEOUT }));
  const after = [1, 2].map(n => queue.call(`after-${n}`, {}));
  await tick();
  assert.equal(refused, 0);
  // The parent answers the slow calls; the waiting ones go out and are answered.
  for (const m of parent.splice(0)) {
    held--;
    queue.settle(m.id, { result: m.action });
  }
  await tick();
  for (const m of parent.splice(0)) {
    held--;
    queue.settle(m.id, { result: m.action });
  }
  assert.deepEqual(await Promise.all(after), [{ result: 'after-1' }, { result: 'after-2' }]);
  assert.equal(refused, 0, 'nothing was refused by the parent');
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
