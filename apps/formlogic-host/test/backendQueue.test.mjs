// node --test apps/formlogic-host/test/backendQueue.test.mjs
// (Node 24 runs the TypeScript module directly; it uses only erasable syntax.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendQueue, BACKEND_BUSY, BACKEND_INVALID, BACKEND_TIMEOUT, BACKEND_UNREADABLE } from '../src/backendQueue.ts';

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

test('a call the parent would not answer is refused at once and takes no slot', async () => {
  // FormLogic's HostedAppFrame returns without a word from a message whose
  // action is not text of the shape it takes. A slot is the parent's until it
  // answers, so four of those would hold all four for good, and every call
  // after them, the app's storage writes included, would time out.
  const posted = [];
  const queue = createBackendQueue({ post: m => posted.push(m), maxInFlight: 1, maxQueued: 4, timeoutMs: 15 });
  for (const action of [['save'], 7, null, undefined, {}, '', 'Save', '1st', 'save.all', 'a'.repeat(65)]) {
    assert.deepEqual(await queue.call(action, {}), { error: BACKEND_INVALID }, JSON.stringify(action));
  }
  assert.equal(posted.length, 0, 'none was sent');
  assert.equal(queue.inFlight, 0);
  assert.equal(queue.waiting, 0);
  const good = queue.call('saveAll_2-b', {});
  assert.equal(posted.length, 1);
  queue.settle(posted[0].id, 'done');
  assert.equal(await good, 'done');
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
  // These two have a deadline of their own: under the queue's 15 ms they timed
  // out whenever a busy machine took longer over the two turns below.
  const after = [1, 2].map(n => queue.call(`after-${n}`, {}, { deadlineAt: Date.now() + 10_000 }));
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

test('optional absolute deadline includes waiting and retains a timed-out sent slot for a correlated late reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const posted = [], late = [];
  const queue = createBackendQueue({ post: message => posted.push(message), maxInFlight: 1 });
  const first = queue.call('ordinary', {});
  let dispatched = false;
  const write = queue.call('nativeStorage', {}, { deadlineAt: 21000, onDispatch: () => { dispatched = true; }, onLateReply: reply => late.push(reply) });
  t.mock.timers.tick(19999);
  queue.settle(posted[0].id, 'ordinary-ok');
  assert.equal(await first, 'ordinary-ok');
  assert.equal(dispatched, true);
  t.mock.timers.tick(1);
  assert.deepEqual(await write, { error: BACKEND_TIMEOUT, outcome: 'unknown' });
  assert.equal(queue.inFlight, 1);
  assert.equal(queue.settle('2', { result: { saved: true } }), false);
  assert.equal(queue.settle(999, { result: { saved: true } }), false);
  assert.equal(late.length, 0);
  assert.equal(queue.settle(posted[1].id, { result: { saved: true } }), false);
  assert.deepEqual(late, [{ result: { saved: true } }]);
  assert.equal(queue.inFlight, 0);
  assert.equal(queue.settle(posted[1].id, 'duplicate'), false);
  assert.equal(late.length, 1);
});

test('optional expired and cancelled unsent calls never reach the parent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const posted = [];
  const queue = createBackendQueue({ post: message => posted.push(message), maxInFlight: 1 });
  queue.call('ordinary', {});
  const expired = queue.call('expires', {}, { deadlineAt: 1010 });
  const controller = new AbortController();
  const cancelled = queue.call('cancelled', {}, { deadlineAt: 21000, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await cancelled, { error: BACKEND_TIMEOUT, outcome: 'unsent' });
  t.mock.timers.tick(10);
  assert.deepEqual(await expired, { error: BACKEND_TIMEOUT, outcome: 'unsent' });
  queue.settle(posted[0].id, 'done');
  assert.deepEqual(posted.map(message => message.action), ['ordinary']);
  assert.equal(queue.waiting, 0);
  assert.deepEqual(await queue.call('already-expired', {}, { deadlineAt: 1000 }), { error: BACKEND_TIMEOUT, outcome: 'unsent' });
});

test('terminal disposal cancels waiting calls without flushing them or accepting later work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const posted = [];
  const queue = createBackendQueue({ post: message => posted.push(message), maxInFlight: 1 });
  const sent = queue.call('sent', {}, { deadlineAt: 21000 });
  const waiting = queue.call('waiting', {}, { deadlineAt: 21000 });
  const ordinary = queue.call('ordinary', {});
  queue.dispose('closed');
  assert.deepEqual(await sent, { error: 'closed', outcome: 'unknown' });
  assert.deepEqual(await waiting, { error: 'closed', outcome: 'unsent' });
  assert.deepEqual(await ordinary, { error: 'closed' });
  t.mock.timers.tick(40000);
  assert.equal(posted.length, 1);
  assert.equal(queue.inFlight, 0);
  assert.equal(queue.waiting, 0);
  assert.deepEqual(await queue.call('after', {}), { error: BACKEND_UNREADABLE });
  assert.equal(queue.settle(posted[0].id, 'late'), false);
});

test('optional failed post is definitively unsent and cancellation of a sent call retains its slot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const failed = createBackendQueue({ post: () => { throw new Error('closed'); } });
  assert.deepEqual(await failed.call('write', {}, { deadlineAt: 21000 }), { error: 'closed', outcome: 'unsent' });
  const posted = [], late = [];
  const controller = new AbortController();
  const queue = createBackendQueue({ post: message => posted.push(message), maxInFlight: 1 });
  const sent = queue.call('write', {}, { deadlineAt: 21000, signal: controller.signal, onLateReply: reply => late.push(reply) });
  controller.abort();
  assert.deepEqual(await sent, { error: BACKEND_TIMEOUT, outcome: 'unknown' });
  assert.equal(queue.inFlight, 1);
  queue.settle(posted[0].id, 'saved');
  assert.deepEqual(late, ['saved']);
  assert.equal(queue.inFlight, 0);
});

test('reply observer exceptions cannot strand a caller or the waiting line', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const posted = [];
  const queue = createBackendQueue({ post: message => posted.push(message), maxInFlight: 1 });
  const first = queue.call('first', {}, { deadlineAt: 1010, onReply() { throw new Error('observer failed'); } });
  const second = queue.call('second', {}, { deadlineAt: 1010, onLateReply() { throw new Error('late observer failed'); } });
  queue.settle(posted[0].id, 'saved');
  assert.equal(await first, 'saved');
  assert.equal(posted.length, 2);
  t.mock.timers.tick(10);
  assert.deepEqual(await second, { error: BACKEND_TIMEOUT, outcome: 'unknown' });
  const third = queue.call('third', {});
  assert.equal(queue.settle(posted[1].id, 'late'), false);
  assert.equal(posted.length, 3);
  queue.settle(posted[2].id, 'done');
  assert.equal(await third, 'done');
});
