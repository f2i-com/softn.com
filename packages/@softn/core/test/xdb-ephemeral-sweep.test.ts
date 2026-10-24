/**
 * A preview whose page closed is never disposed, so what its script kept in
 * localStorage under the scope's id stayed for good, a set for every preview
 * closed with its tab. The first scope a page makes sweeps those of scopes made
 * more than a day ago; a scope's id holds when it was made, so one still open
 * in another tab is left alone. Its own file: the sweep runs once a page.
 */
import { afterEach, expect, it } from 'vitest';
import { createEphemeralXDBScope } from '../src/runtime/xdb';

afterEach(() => localStorage.clear());

it('sweeps the script storage of scopes made more than a day ago, and no one else’s', () => {
  const now = Date.now();
  const old = `softn:__softn_preview__${(now - 2 * 24 * 3600e3).toString(36)}_1:best`;
  const recent = `softn:__softn_preview__${(now - 3600e3).toString(36)}_4:best`;
  localStorage.setItem(old, '1');
  localStorage.setItem(recent, '2');
  localStorage.setItem('softn:some-app:best', '3');
  localStorage.setItem('xdb:some-app:notes', '[]');

  const scope = createEphemeralXDBScope();
  expect(localStorage.getItem(old)).toBeNull();
  expect(localStorage.getItem(recent)).toBe('2');
  expect(localStorage.getItem('softn:some-app:best')).toBe('3');
  expect(localStorage.getItem('xdb:some-app:notes')).toBe('[]');

  // Once a page: a key left after the first scope is not looked for again.
  localStorage.setItem(old, '1');
  createEphemeralXDBScope().dispose();
  expect(localStorage.getItem(old)).toBe('1');
  scope.dispose();
});
