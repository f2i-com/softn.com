/**
 * A preview open in a tab that slept for days (a laptop shut over a weekend)
 * missed its hourly mark of being open, and the first scope another page made
 * swept its script storage while it was still open. A live scope holds a Web
 * Lock named for it, which the page holds however long it sleeps, and the sweep
 * passes over a scope whose lock is held. Its own file: the sweep runs once a
 * page.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEphemeralXDBScope } from '../src/runtime/xdb';

/** The Web Locks a page has: held until the callback's promise settles. */
function fakeLocks(heldElsewhere: string[]) {
  const held = new Set(heldElsewhere);
  return {
    held,
    request: vi.fn((name: string, callback: () => Promise<void>) => {
      held.add(name);
      return callback().finally(() => held.delete(name));
    }),
    query: vi.fn(async () => ({ held: [...held].map((name) => ({ name })) })),
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("passes over a scope whose lock is held, however long since it said it was open, and holds its own until let go", async () => {
  const now = Date.now();
  const day = 24 * 3600e3;
  const id = (made: number, n: number) => `__softn_preview__${made.toString(36)}_${n}`;
  const asleep = id(now - 3 * day, 2);
  const gone = id(now - 3 * day, 3);
  for (const scope of [asleep, gone]) {
    localStorage.setItem(`softn:${scope}:best`, scope);
    localStorage.setItem(`softn-preview-alive:${scope}`, String(now - 2 * day));
  }
  const locks = fakeLocks([`softn-preview:${asleep}`]);
  vi.stubGlobal('navigator', { ...globalThis.navigator, locks });

  const scope = createEphemeralXDBScope();
  await vi.waitFor(() => expect(localStorage.getItem(`softn:${gone}:best`)).toBeNull());
  expect(localStorage.getItem(`softn:${asleep}:best`)).toBe(asleep);
  expect(localStorage.getItem(`softn-preview-alive:${asleep}`)).not.toBeNull();

  expect(locks.held.has(`softn-preview:${scope.appId}`)).toBe(true);
  scope.dispose();
  await vi.waitFor(() => expect(locks.held.has(`softn-preview:${scope.appId}`)).toBe(false));
});
