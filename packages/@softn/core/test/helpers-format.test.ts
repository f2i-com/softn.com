/**
 * Date and number formatting regressions.
 *
 * These run in every template, and each one produced a plausible-looking wrong
 * answer rather than an error — the hardest kind to notice.
 *
 * The date tests pin behaviour that is only wrong in zones west of UTC, so they
 * matter most when the suite runs somewhere other than where they were written.
 */

import { describe, it, expect } from 'vitest';
import { formatDate, timeAgo, formatNumber, currency } from '../src/runtime/helpers';
import { validateForm, createFormState } from '../src/runtime/form-binding';

describe('formatDate on date-only values', () => {
  // `new Date('2026-07-27')` is UTC midnight by specification. Rendering that
  // in any zone west of UTC gives the previous day, and `<input type="date">`
  // with `:bind` stores exactly this shape — so a date picked as the 27th
  // displayed as the 26th for every user in the Americas.
  it('keeps the calendar day it names', () => {
    // Assert on the day part alone — the year happens to end in the digits of
    // the wrong answer, so a substring check over the whole string proves
    // nothing.
    expect(formatDate('2026-07-27', { day: 'numeric' })).toBe('27');
  });

  it('does the same at a month boundary', () => {
    // The failure is worst here: rolling back a day also rolls back the month.
    expect(formatDate('2026-03-01', { day: 'numeric' })).toBe('1');
    expect(formatDate('2026-03-01', { month: 'numeric' })).toBe('3');
  });

  it('leaves a value carrying a time alone', () => {
    // Here the instant is the point, so local rendering is correct.
    const iso = '2026-07-27T15:30:00.000Z';
    expect(formatDate(iso)).not.toBe('');
  });

  it('still answers empty for junk', () => {
    expect(formatDate('not a date')).toBe('');
    expect(formatDate('')).toBe('');
  });
});

describe('timeAgo', () => {
  // Offsets sit deliberately off a whole-unit boundary: `timeAgo` floors, so
  // "exactly +2 days" is 1.9999 days by the time it is read and the assertion
  // would turn on scheduling luck rather than on the behaviour under test.
  it('describes a future date in its own units', () => {
    // Every branch tested `> 0`, so a future date fell through to seconds and
    // reported "in 172,800 seconds" for something two days out.
    const out = timeAgo(new Date(Date.now() + 2.5 * 86_400_000).toISOString());
    expect(out).toMatch(/day/);
    expect(out).not.toMatch(/second/);
  });

  it('describes a past date as before', () => {
    const out = timeAgo(new Date(Date.now() - 2.5 * 86_400_000).toISOString());
    expect(out).toMatch(/day/);
    expect(out).not.toMatch(/second/);
  });

  it('keeps direction distinct', () => {
    const future = timeAgo(new Date(Date.now() + 3.5 * 3_600_000).toISOString());
    const past = timeAgo(new Date(Date.now() - 3.5 * 3_600_000).toISOString());
    expect(future).toMatch(/hour/);
    expect(past).toMatch(/hour/);
    expect(future).not.toBe(past);
  });
});

describe('number formatting of bound values', () => {
  // `:bind` on `<Input type="number">` stores `target.value` — a string — so
  // these received "19.99" and rendered nothing at all.
  it('formats a numeric string', () => {
    expect(formatNumber('1234.5')).not.toBe('');
    expect(currency('19.99')).not.toBe('');
  });

  it('agrees with the number form', () => {
    expect(formatNumber('1234.5')).toBe(formatNumber(1234.5));
    expect(currency('19.99')).toBe(currency(19.99));
  });

  it('still answers empty for something that is not a number', () => {
    expect(formatNumber('abc')).toBe('');
    expect(formatNumber(NaN)).toBe('');
    expect(formatNumber(Infinity)).toBe('');
    expect(currency('')).toBe('');
  });
});

describe('required boolean fields', () => {
  it('fails validation while unticked', () => {
    // `isEmpty(false)` is false and booleans seed to false, so a required
    // consent box could never fail — which is the entire point of one.
    const fields = [{ name: 'agree', label: 'Agree', type: 'boolean' as const, required: true }];
    const errors = validateForm(createFormState(fields), fields);
    expect(errors.agree).toBeTruthy();
  });

  it('passes once ticked', () => {
    const fields = [{ name: 'agree', label: 'Agree', type: 'boolean' as const, required: true }];
    const state = createFormState(fields);
    state.values.agree = true;
    expect(validateForm(state, fields).agree).toBeNull();
  });

  it('leaves an optional boolean alone', () => {
    const fields = [{ name: 'news', label: 'News', type: 'boolean' as const }];
    expect(validateForm(createFormState(fields), fields).news).toBeNull();
  });
});
