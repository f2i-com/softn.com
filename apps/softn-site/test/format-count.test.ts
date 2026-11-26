/**
 * Counts and sizes the way a card has room for (lib/format.ts). One that
 * rounds up to the next unit is written in that unit: 999,999 runs read
 * "1000k", and a bundle a byte short of a megabyte "1024 KB".
 */
import { expect, it } from 'vitest';
import { formatBytes, formatCount, runsLabel } from '../src/lib/format';

it('writes a size that rounds up to a megabyte as a megabyte', () => {
  expect(formatBytes(1024 * 1024 - 513)).toBe('1023 KB');
  expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
  expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  expect(formatBytes(1536)).toBe('2 KB');
  expect(formatBytes(1023)).toBe('1023 B');
});

it('writes a count that rounds up to a million as a million', () => {
  expect(formatCount(999_499)).toBe('999k');
  expect(formatCount(999_500)).toBe('1M');
  expect(formatCount(999_999)).toBe('1M');
  expect(formatCount(1_000_000)).toBe('1M');
  expect(runsLabel(999_999)).toBe('1M runs');
});

it('keeps the other boundaries as they were', () => {
  expect(formatCount(0)).toBe('0');
  expect(formatCount(999)).toBe('999');
  expect(formatCount(1000)).toBe('1k');
  expect(formatCount(1250)).toBe('1.3k');
  expect(formatCount(9_999)).toBe('10k');
  expect(formatCount(10_000)).toBe('10k');
  expect(formatCount(12_345_678)).toBe('12.3M');
  expect(formatCount(Number.NaN)).toBe('0');
});
