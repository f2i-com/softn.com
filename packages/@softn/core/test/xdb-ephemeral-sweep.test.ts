/**
 * A preview whose page closed is never disposed, so what its script kept in
 * localStorage under the scope's id stayed for good, a set for every preview
 * closed with its tab. The first scope a page makes sweeps those of scopes not
 * seen for a day. A live scope says it is open every hour, so one open in
 * another tab keeps its storage however long ago it was made; one that never
 * said goes by when it was made, which its id holds. Its own file: the sweep
 * runs once a page.
 */
import { afterEach, expect, it } from 'vitest';
import { createEphemeralXDBScope } from '../src/runtime/xdb';

afterEach(() => localStorage.clear());

it("sweeps the script storage of scopes not seen for a day, and no live one's or anyone else's", () => {
  const now = Date.now();
  const day = 24 * 3600e3;
  const id = (made: number, n: number) => `__softn_preview__${made.toString(36)}_${n}`;
  const gone = id(now - 2 * day, 1);
  const recent = id(now - 3600e3, 4);
  // Made two days ago and open in another tab: it said so an hour ago.
  const open = id(now - 2 * day, 7);
  // Said it was open, two days ago: its page is gone.
  const quiet = id(now - 3 * day, 9);
  localStorage.setItem(`softn:${gone}:best`, '1');
  localStorage.setItem(`softn:${recent}:best`, '2');
  localStorage.setItem(`softn:${open}:best`, '3');
  localStorage.setItem(`softn-preview-alive:${open}`, String(now - 3600e3));
  localStorage.setItem(`softn:${quiet}:best`, '4');
  localStorage.setItem(`softn-preview-alive:${quiet}`, String(now - 2 * day));
  localStorage.setItem('softn:some-app:best', '5');
  localStorage.setItem('xdb:some-app:notes', '[]');

  const scope = createEphemeralXDBScope();
  expect(localStorage.getItem(`softn:${gone}:best`)).toBeNull();
  expect(localStorage.getItem(`softn:${recent}:best`)).toBe('2');
  expect(localStorage.getItem(`softn:${open}:best`)).toBe('3');
  expect(localStorage.getItem(`softn:${quiet}:best`)).toBeNull();
  expect(localStorage.getItem(`softn-preview-alive:${quiet}`)).toBeNull();
  expect(localStorage.getItem('softn:some-app:best')).toBe('5');
  expect(localStorage.getItem('xdb:some-app:notes')).toBe('[]');
  // A scope says it is open from the start, and no longer once let go.
  expect(Number(localStorage.getItem(`softn-preview-alive:${scope.appId}`))).toBeGreaterThan(0);

  // Once a page: a key left after the first scope is not looked for again.
  localStorage.setItem(`softn:${gone}:best`, '1');
  createEphemeralXDBScope().dispose();
  expect(localStorage.getItem(`softn:${gone}:best`)).toBe('1');
  scope.dispose();
  expect(localStorage.getItem(`softn-preview-alive:${scope.appId}`)).toBeNull();
});
