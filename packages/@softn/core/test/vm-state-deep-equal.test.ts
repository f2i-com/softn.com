/**
 * The state comparator the VM→host sync paths share.
 *
 * A false "equal" here drops an update the user made; a false "changed"
 * costs a render. The cases below are the ones an external review reproduced
 * against the previous implementation, plus the symmetry and binary-view
 * cases that fall out of the same root cause: the comparator decided what
 * kind of value it was looking at from the first operand alone.
 */

import { describe, expect, it } from 'vitest';
import { deepEqual, MAX_CONVERSION_DEPTH } from '../src/runtime/vm-state';

/** Both orders, because a comparator that is only right one way round is wrong. */
function both(a: unknown, b: unknown): boolean {
  const ab = deepEqual(a, b);
  const ba = deepEqual(b, a);
  if (ab !== ba) throw new Error(`asymmetric: deepEqual(a, b)=${ab} but deepEqual(b, a)=${ba}`);
  return ab;
}

describe('deepEqual: the reproduced defects', () => {
  it('does not equate objects whose keys differ but whose values are undefined', () => {
    expect(both({ a: undefined }, { b: undefined })).toBe(false);
    expect(both({ a: undefined }, { a: undefined })).toBe(true);
  });

  it('compares DataViews by their bytes', () => {
    const one = new DataView(new Uint8Array([1, 2, 3, 4]).buffer);
    const two = new DataView(new Uint8Array([1, 2, 3, 5]).buffer);
    const same = new DataView(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(both(one, two)).toBe(false);
    expect(both(one, same)).toBe(true);
  });

  it('is symmetric between a plain object and a Set', () => {
    expect(both({}, new Set([1]))).toBe(false);
    expect(both({}, new Set())).toBe(false);
    expect(both({}, new Map())).toBe(false);
    expect(both({}, new Date(0))).toBe(false);
    expect(both({}, /x/)).toBe(false);
    expect(both({}, new ArrayBuffer(0))).toBe(false);
    expect(both({}, new Uint8Array(0))).toBe(false);
  });
});

describe('deepEqual: kinds', () => {
  it('treats an empty array and an empty object as different', () => {
    expect(both([], {})).toBe(false);
    expect(both([0], { 0: 0 })).toBe(false);
    expect(both({ length: 0 }, [])).toBe(false);
  });

  it('compares typed-array subviews as the window they cover', () => {
    const buffer = new Uint8Array([9, 1, 2, 3, 9]).buffer;
    const inner = new Uint8Array(buffer, 1, 3);
    const standalone = new Uint8Array([1, 2, 3]);
    expect(both(inner, standalone)).toBe(true);
    expect(both(new Uint8Array(buffer), standalone)).toBe(false);
  });

  it('compares DataViews at different offsets by what they cover', () => {
    const bytes = new Uint8Array([0, 0, 7, 8, 7, 8]).buffer;
    expect(both(new DataView(bytes, 2, 2), new DataView(bytes, 4, 2))).toBe(true);
    expect(both(new DataView(bytes, 0, 2), new DataView(bytes, 2, 2))).toBe(false);
    expect(both(new DataView(bytes, 2, 2), new DataView(bytes, 2, 3))).toBe(false);
  });

  it('keeps element type as part of identity', () => {
    expect(both(new Uint8Array([1, 0]), new Uint16Array([1]))).toBe(false);
    expect(both(new Float32Array([1.5]), new Float32Array([1.5]))).toBe(true);
    expect(both(new Uint8Array([1]), new DataView(new Uint8Array([1]).buffer))).toBe(false);
  });

  it('compares ArrayBuffers by content', () => {
    expect(both(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer)).toBe(true);
    expect(both(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 3]).buffer)).toBe(false);
    expect(both(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2, 3]).buffer)).toBe(false);
  });

  it('compares Dates, RegExps, Sets and Maps by value', () => {
    expect(both(new Date(5), new Date(5))).toBe(true);
    expect(both(new Date(5), new Date(6))).toBe(false);
    expect(both(/a/gi, /a/gi)).toBe(true);
    expect(both(/a/g, /a/i)).toBe(false);
    expect(both(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(both(new Set([1, 2]), new Set([1, 3]))).toBe(false);
    expect(both(new Map([['k', { v: 1 }]]), new Map([['k', { v: 1 }]]))).toBe(true);
    expect(both(new Map([['k', { v: 1 }]]), new Map([['k', { v: 2 }]]))).toBe(false);
    expect(both(new Map([['k', 1]]), new Map([['j', 1]]))).toBe(false);
  });
});

describe('deepEqual: primitives and nesting', () => {
  it('equates NaN with NaN and nothing else', () => {
    expect(both(NaN, NaN)).toBe(true);
    expect(both(NaN, 0)).toBe(false);
    expect(both({ n: NaN }, { n: NaN })).toBe(true);
  });

  it('distinguishes null, undefined and absence', () => {
    expect(both(null, undefined)).toBe(false);
    expect(both({ a: null }, { a: undefined })).toBe(false);
    expect(both({ a: undefined }, {})).toBe(false);
    expect(both(0, false)).toBe(false);
    expect(both('1', 1)).toBe(false);
  });

  it('sees a nested key change under an undefined value', () => {
    const before = { form: { name: undefined, age: 3 } };
    const after = { form: { email: undefined, age: 3 } };
    expect(both(before, after)).toBe(false);
    expect(both(before, { form: { name: undefined, age: 3 } })).toBe(true);
  });

  it('compares arrays element by element', () => {
    expect(both([1, [2, [3]]], [1, [2, [3]]])).toBe(true);
    expect(both([1, [2, [3]]], [1, [2, [4]]])).toBe(false);
    expect(both([1, 2], [1, 2, 3])).toBe(false);
    expect(both([undefined], [null])).toBe(false);
  });

  it('reports a change rather than guessing past the depth limit', () => {
    let a: unknown = 1;
    let b: unknown = 1;
    for (let i = 0; i <= MAX_CONVERSION_DEPTH; i++) {
      a = { a };
      b = { a: b };
    }
    expect(both(a, b)).toBe(false);
  });

  it('compares values the bridge does not model by identity only', () => {
    const fn = () => 1;
    expect(both(fn, fn)).toBe(true);
    expect(both(fn, () => 1)).toBe(false);
  });
});

describe('deepEqual: representative VM round trips', () => {
  it('sees the states a form produces as it is filled in', () => {
    const trace = [
      { title: '', tags: [], done: false },
      { title: 'a', tags: [], done: false },
      { title: 'a', tags: ['x'], done: false },
      { title: 'a', tags: ['x'], done: true },
      { title: 'a', tags: ['x'], done: true, note: undefined },
    ];
    for (let i = 1; i < trace.length; i++) {
      expect(both(trace[i - 1], trace[i])).toBe(false);
      expect(both(trace[i], JSON.parse(JSON.stringify(trace[i])))).toBe(i !== 4);
    }
  });

  it('sees a pixel buffer change and a pixel buffer that did not', () => {
    const frame = new Uint8ClampedArray(16);
    const copy = new Uint8ClampedArray(frame);
    expect(both({ frame }, { frame: copy })).toBe(true);
    copy[7] = 255;
    expect(both({ frame }, { frame: copy })).toBe(false);
  });
});
