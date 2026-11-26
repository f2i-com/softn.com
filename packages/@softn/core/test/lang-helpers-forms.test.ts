/**
 * The template helpers and form helpers a page calls (runtime/helpers.ts,
 * runtime/form-binding.ts).
 *
 * - `truncate(text, n)` is never longer than the text it shortens: with `n`
 *   under the suffix's length it sliced from the end (`slice(0, -1)`), so
 *   `truncate("Alexander", 2)` was "Alexande...". Nor does it cut a
 *   character written as two halves (an emoji) in two.
 * - `titleCase` capitalises words, not what follows an apostrophe or a
 *   letter past ASCII: "don't" was "Don'T" and "élan" "éLan".
 * - A field named like an object's own machinery (`constructor`,
 *   `__proto__`) is a field with no error: `getFieldError` handed a page
 *   Object's prototype or the `Object` function itself.
 * - A field's `defaultValue: null` is null, as a record's null is: `??`
 *   took it for none given and put the type's own in its place (0, "", false).
 * - The number and date helpers give what they gave, from formatters made
 *   once for each set of options and kept (see the efficiency note in
 *   helpers.ts), so a row of a thousand prices no longer builds a thousand.
 */

import { describe, expect, it } from 'vitest';
import {
  currency,
  formatDate,
  formatNumber,
  formatTime,
  percent,
  timeAgo,
  titleCase,
  truncate,
} from '../src/runtime/helpers';
import { createFormState, getFieldClass, getFieldError, hasFieldError, validateForm } from '../src/runtime/form-binding';

describe('truncate', () => {
  it('is never longer than the text it shortens', () => {
    expect(truncate('Alexander', 2)).toBe('...');
    expect(truncate('Alexander', 0)).toBe('...');
    expect(truncate('Alexander', 3)).toBe('...');
    expect(truncate('Alexander', 4)).toBe('A...');
    expect(truncate('Alexander', 9)).toBe('Alexander');
    expect(truncate('Alexander', 2, '…')).toBe('A…');
  });

  it('does not cut an emoji in two', () => {
    expect(truncate('Hi 😀 there', 7)).toBe('Hi ...');
    expect(truncate('😀😀😀😀', 5, '…')).toBe('😀😀…');
  });
});

describe('titleCase', () => {
  it('capitalises words, not what follows an apostrophe', () => {
    expect(titleCase("don't stop, it's fine")).toBe("Don't Stop, It's Fine");
    expect(titleCase('rock’n’roll')).toBe('Rock’n’roll');
  });

  it('capitalises a word that begins past ASCII, and not the letter after one', () => {
    expect(titleCase('élan vital über alles')).toBe('Élan Vital Über Alles');
    expect(titleCase('naïve café')).toBe('Naïve Café');
    expect(titleCase('nai\u{308}ve')).toBe('Nai\u{308}ve');
  });

  it('still capitalises after spaces, hyphens and punctuation', () => {
    expect(titleCase('hello world')).toBe('Hello World');
    expect(titleCase('well-known (and loved)')).toBe('Well-Known (And Loved)');
    expect(titleCase('2nd place snake_case')).toBe('2nd Place Snake_case');
  });
});

describe('a form field named like an object’s own machinery', () => {
  const state = createFormState([{ name: 'title', required: true }]);
  state.touched.title = true;
  state.errors = validateForm(state, [{ name: 'title', required: true }]);

  it('has no error', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(getFieldError(state, name)).toBeNull();
      expect(hasFieldError(state, name)).toBe(false);
      expect(getFieldClass(state, name, 'field')).toBe('field');
    }
  });

  it('leaves a real field’s error as it was', () => {
    expect(getFieldError(state, 'title')).toBe('title is required');
    expect(hasFieldError(state, 'title')).toBe(true);
    expect(getFieldClass(state, 'title', 'field')).toBe('field field-error');
  });
});

describe('a field’s defaultValue', () => {
  it('is null when it is given as null', () => {
    const state = createFormState([
      { name: 'age', type: 'number', defaultValue: null },
      { name: 'agreed', type: 'boolean', defaultValue: null },
      { name: 'count', type: 'number' },
    ]);
    expect(state.values).toEqual({ age: null, agreed: null, count: 0 });
  });
});

describe('the number and date helpers', () => {
  it('give what a formatter made for the call would', () => {
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat(undefined).format(1234.5));
    expect(formatNumber(0.5, { style: 'percent' })).toBe(new Intl.NumberFormat(undefined, { style: 'percent' }).format(0.5));
    expect(currency(12, 'EUR')).toBe(new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(12));
    expect(currency(12, 'USD')).toBe(new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(12));
    expect(percent(0.256, 1)).toBe(
      new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(0.256)
    );
    const day = new Date(2026, 6, 27, 15, 4);
    expect(formatDate(day)).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(day));
    expect(formatDate(day, 'full')).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day));
    expect(formatDate(day, { year: 'numeric', month: 'long' })).toBe(new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' }).format(day));
    expect(formatTime(day, 'medium')).toBe(new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(day));
    expect(timeAgo(Date.now() - 3 * 86_400_000)).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-3, 'day'));
  });

  it('tell options apart, whatever was asked before', () => {
    expect(currency(5, 'EUR')).not.toBe(currency(5, 'JPY'));
    expect(formatDate('2026-07-27', 'short')).not.toBe(formatDate('2026-07-27', 'long'));
  });

  it('still refuse a currency that is not one, every time', () => {
    expect(() => currency(5, 'NOT A CODE')).toThrow(RangeError);
    expect(() => currency(5, 'NOT A CODE')).toThrow(RangeError);
  });

  it('read options that cannot be written as JSON as a fresh formatter would', () => {
    const options: Record<string, unknown> = { maximumFractionDigits: 1 };
    options.self = options;
    expect(formatNumber(1.25, options as Intl.NumberFormatOptions)).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(1.25));
  });
});
