/**
 * A preview scope's id was the time it was made and a count that started at 1 on every page:
 * two tabs making a preview in one millisecond had one id, shared its script storage
 * (`softn:<id>:`), and the first to let go took the other's.
 */
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});

it('differs between two pages making their first preview in the same millisecond', async () => {
  vi.useFakeTimers({ now: new Date('2026-03-01T00:00:00Z'), toFake: ['Date'] });
  vi.resetModules();
  const one = await import('../src/runtime/xdb');
  vi.resetModules();
  const two = await import('../src/runtime/xdb');
  const a = one.createEphemeralXDBScope();
  const b = two.createEphemeralXDBScope();
  expect(a.appId).not.toBe(b.appId);
  // Still the time it was made, for the sweep to read.
  expect(a.appId).toMatch(/^__softn_preview__[0-9a-z]+_\d+$/);
  a.dispose();
  b.dispose();
});
