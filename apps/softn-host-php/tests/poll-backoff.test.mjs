// How long the live bridge waits between polls of a route (runtime/poll-backoff.mjs).
// It waited the full interval whatever the host answered, so a host refusing the
// bridge's address (429) or failing (5xx) was asked again as often by every connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_BACKOFF_MS, pollDelayMs, retryAfterMs} from '../runtime/poll-backoff.mjs';

test('a poll that brought an answer is followed at the interval', () => {
  assert.equal(pollDelayMs({intervalMs: 5000, failures: 0}), 5000);
  // Whatever the last answer said about coming back: it was an answer.
  assert.equal(pollDelayMs({intervalMs: 5000, failures: 0, retryAfter: 60_000}), 5000);
  assert.equal(pollDelayMs({intervalMs: 5000, failures: -1}), 5000);
  assert.equal(pollDelayMs({intervalMs: 5000, failures: undefined}), 5000);
});

test('each poll in a row without one doubles the wait, up to the cap', () => {
  const waits = [1, 2, 3, 4, 5, 6, 7, 8, 50, 5000].map(failures => pollDelayMs({intervalMs: 5000, failures}));
  assert.deepEqual(waits, [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000, 300_000]);
  assert.equal(MAX_BACKOFF_MS, 300_000);
  // The cap is the bridge's to set, and is never under the interval itself.
  assert.deepEqual([1, 2, 3, 4].map(failures => pollDelayMs({intervalMs: 20, failures, maxBackoffMs: 100})), [40, 80, 100, 100]);
  assert.equal(pollDelayMs({intervalMs: 5000, failures: 3, maxBackoffMs: 1000}), 5000);
  // A wait is never shorter than after an answer, and always a finite number.
  for (let failures = 1; failures < 2000; failures++) {
    const wait = pollDelayMs({intervalMs: 5000, failures});
    assert.ok(Number.isFinite(wait) && wait >= 5000 && wait <= MAX_BACKOFF_MS, `${failures}: ${wait}`);
  }
});

test('the host is not asked again before its Retry-After, up to the cap', () => {
  // The PHP host's 429 says how long is left of the minute.
  assert.equal(pollDelayMs({intervalMs: 5000, failures: 1, retryAfter: 42_000}), 42_000);
  // Sooner than the doubled wait changes nothing: the doubling still stands.
  assert.equal(pollDelayMs({intervalMs: 5000, failures: 3, retryAfter: 1000}), 40_000);
  assert.equal(pollDelayMs({intervalMs: 5000, failures: 1, retryAfter: 0}), 10_000);
  assert.equal(pollDelayMs({intervalMs: 5000, failures: 1, retryAfter: null}), 10_000);
  // An hour is not waited: a host that is well again is found within the cap.
  assert.equal(pollDelayMs({intervalMs: 5000, failures: 1, retryAfter: 3_600_000}), MAX_BACKOFF_MS);
  assert.equal(pollDelayMs({intervalMs: 20, failures: 1, retryAfter: 1000, maxBackoffMs: 400}), 400);
  // Not a number of milliseconds: as if it had not been said.
  for (const retryAfter of ['60', NaN, undefined, {}]) {
    assert.equal(pollDelayMs({intervalMs: 5000, failures: 1, retryAfter}), 10_000, String(retryAfter));
  }
});

test('Retry-After is a count of seconds or an HTTP date', () => {
  const now = Date.parse('2026-11-26T10:00:00Z');
  assert.equal(retryAfterMs('60', now), 60_000);
  assert.equal(retryAfterMs(' 7 ', now), 7000);
  assert.equal(retryAfterMs('0', now), 0);
  assert.equal(retryAfterMs('Thu, 26 Nov 2026 10:00:30 GMT', now), 30_000);
  assert.equal(retryAfterMs('Thu, 26 Nov 2026 09:59:00 GMT', now), 0, 'a date that has passed is now');
  for (const other of [null, undefined, 60, '', 'soon', '-5', '1.5', '60s', '1e3', '2026-11-26T10:00:30Z', '9999999999', 'Thu, 99 Abc 2026 10:00:30 GMT']) {
    assert.equal(retryAfterMs(other, now), null, String(other));
  }
});
