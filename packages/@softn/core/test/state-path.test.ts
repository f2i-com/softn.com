/**
 * State path parsing.
 *
 * `:bind` describes its target as a path string. Every `setState` used to split
 * it on `.` alone, which left `todos[0]` as a single segment and wrote it as an
 * object key of that literal name: the array was never touched, the field
 * appeared to reject keystrokes, and a phantom key accumulated in state.
 */

import { describe, it, expect } from 'vitest';
import { parseStatePath } from '../src/runtime/state-path';

describe('parseStatePath', () => {
  it('splits plain dotted paths', () => {
    expect(parseStatePath('user')).toEqual(['user']);
    expect(parseStatePath('user.name')).toEqual(['user', 'name']);
    expect(parseStatePath('a.b.c.d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('splits array indices into their own segment', () => {
    expect(parseStatePath('todos[0]')).toEqual(['todos', '0']);
    expect(parseStatePath('todos[0].title')).toEqual(['todos', '0', 'title']);
    expect(parseStatePath('a[0][1]')).toEqual(['a', '0', '1']);
  });

  it('strips quotes from bracketed string keys', () => {
    expect(parseStatePath('map["a b"]')).toEqual(['map', 'a b']);
    expect(parseStatePath("map['k'].v")).toEqual(['map', 'k', 'v']);
  });

  it('handles a bracket immediately after another segment', () => {
    expect(parseStatePath('rows[2].cells[3].value')).toEqual([
      'rows',
      '2',
      'cells',
      '3',
      'value',
    ]);
  });

  it('ignores empty segments rather than emitting them', () => {
    expect(parseStatePath('')).toEqual([]);
    expect(parseStatePath('a..b')).toEqual(['a', 'b']);
    expect(parseStatePath('a[]')).toEqual(['a']);
  });
});
