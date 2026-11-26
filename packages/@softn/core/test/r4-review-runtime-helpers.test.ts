/**
 * Template helpers and the drawn-function reading (audit round 4).
 *
 * - drawn-functions.ts counted `x = …` and `x: …` as giving a name its
 *   function, not `x ??= …`, `x ||= …` or `x &&= …`: a drawn function calling
 *   such a name was not followed, the state behind it stayed in the engine,
 *   and the page went stale.
 * - A validator answering '' stored '' as the field's error: the form could
 *   never pass, and no message was shown.
 * - `last(items, 0)` answered every item.
 * - formValuesToRecord wrote an own `__proto__` key, which set the record's
 *   prototype: a form posting `{"__proto__": {"admin": true}}` made
 *   `record.admin` true.
 */
import { describe, expect, it } from 'vitest';
import { readsOfDrawnFunctions, type DrawnReads } from '../src/runtime/drawn-functions';
import { createFormState, formValuesToRecord, isFormValid, validateForm } from '../src/runtime/form-binding';
import { last } from '../src/runtime/helpers';

function readNames(code: string): ReadonlySet<string> {
  const result: DrawnReads = readsOfDrawnFunctions({ code, functionNames: ['makeFormatter', 'setup', 'label'], drawn: new Set(['label']) });
  expect(result.known).toBe(true);
  return (result as Extract<DrawnReads, { known: true }>).names;
}

describe('a name given its function by a logical assignment', () => {
  for (const operator of ['??=', '||=', '&&=']) {
    it(`is followed when it is given one with ${operator}`, () => {
      const code = [
        'let unit = "kg"',
        'let fmt = null',
        'function makeFormatter() { return (x) => x + unit }',
        `function setup() { fmt ${operator} makeFormatter() }`,
        'function label() { return fmt(1) }',
      ].join('\n');
      expect(readNames(code).has('unit')).toBe(true);
    });
  }

  it('as with a plain assignment', () => {
    const code = 'let unit = "kg"\nlet fmt = null\nfunction makeFormatter() { return (x) => x + unit }\nfunction setup() { fmt = makeFormatter() }\nfunction label() { return fmt(1) }';
    expect(readNames(code).has('unit')).toBe(true);
  });
});

describe('a validator that answers the empty string', () => {
  it('has said there is nothing wrong', () => {
    const fields = [{ name: 'code', type: 'text' as const, validate: () => '' }];
    const errors = validateForm(createFormState(fields), fields);
    expect(errors.code).toBeNull();
    expect(isFormValid(errors)).toBe(true);
  });
});

describe('last', () => {
  it('answers no items for a count of 0', () => {
    expect(last([1, 2, 3], 0)).toEqual([]);
    expect(last([1, 2, 3], 2)).toEqual([2, 3]);
    expect(last([1, 2, 3])).toBe(3);
  });
});

describe('formValuesToRecord', () => {
  it('leaves out a key that would set the record’s prototype', () => {
    const record = formValuesToRecord(JSON.parse('{"title":"t","__proto__":{"admin":true}}'));
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect((record as { admin?: unknown }).admin).toBeUndefined();
    expect(record).toEqual({ title: 't' });
  });
});
