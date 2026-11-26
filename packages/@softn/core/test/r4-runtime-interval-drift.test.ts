/**
 * An interval in logic keeps its period: the next one counts from when the
 * last fired, as a browser's does, not from when its callback was over.
 *
 * An interval asks for its next wait from inside its callback, and the host
 * started that wait when the callback's entry into the engine had ended. Every
 * period was the interval plus the callback and the entry around it: a 50 ms
 * interval whose callback took 20 ms ticked every 70 ms, and a clock that
 * counted its ticks fell behind with each one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogicTimers, TIMER_CLEAR, TIMER_WAIT } from '../src/runtime/logic-timers';
import type { PendingHostCall } from '../src/runtime/script-runtime';

afterEach(() => {
  vi.useRealTimers();
});

let nextCall = 1;
const wait = (id: number, ms: number): PendingHostCall => ({ id: nextCall++, kind: TIMER_WAIT, args: [String(id), String(ms)] });
const clear = (id: number): PendingHostCall => ({ id: nextCall++, kind: TIMER_CLEAR, args: [String(id)] });

describe('the host clock of an interval', () => {
  it('counts the next period from the last fire, whatever the callback took', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const answered: number[] = [];
    const timers = new LogicTimers((callId) => answered.push(callId));
    const first = wait(7, 50);
    timers.take([first]);
    vi.advanceTimersByTime(50);
    expect(answered).toEqual([first.id]);

    // The callback, and the entry around it, take 20 ms; then it asks again.
    vi.advanceTimersByTime(20);
    const second = wait(7, 50);
    timers.take([second]);
    vi.advanceTimersByTime(29);
    expect(answered).toEqual([first.id]);
    vi.advanceTimersByTime(1);
    expect(answered).toEqual([first.id, second.id]);
  });

  it('fires at once after a callback longer than the period, then keeps the period', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const answered: number[] = [];
    const timers = new LogicTimers((callId) => answered.push(callId));
    timers.take([wait(3, 30)]);
    vi.advanceTimersByTime(30);
    vi.advanceTimersByTime(80);
    const late = wait(3, 30);
    timers.take([late]);
    vi.advanceTimersByTime(4);
    expect(answered.at(-1)).toBe(late.id);
    const next = wait(3, 30);
    timers.take([next]);
    vi.advanceTimersByTime(29);
    expect(answered.at(-1)).toBe(late.id);
    vi.advanceTimersByTime(1);
    expect(answered.at(-1)).toBe(next.id);
  });

  it('counts a new timer, and one asked for again after it was cleared, from now', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const answered: number[] = [];
    const timers = new LogicTimers((callId) => answered.push(callId));
    timers.take([wait(1, 40)]);
    vi.advanceTimersByTime(40);
    timers.take([clear(1)]);
    vi.advanceTimersByTime(30);
    const again = wait(1, 40);
    timers.take([again]);
    vi.advanceTimersByTime(39);
    expect(answered).not.toContain(again.id);
    vi.advanceTimersByTime(1);
    expect(answered).toContain(again.id);
  });
});
