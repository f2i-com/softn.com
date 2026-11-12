/**
 * State path parsing.
 *
 * `:bind` describes its target as a path string. Every `setState` used to split
 * it on `.` alone, which left `todos[0]` as a single segment and wrote it as an
 * object key of that literal name: the array was never touched, the field
 * appeared to reject keystrokes, and a phantom key accumulated in state.
 */

import { describe, it, expect } from 'vitest';
import { pathStep } from '../src/renderer/evaluate';
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

  it('reads a key in double quotes to its closing quote, whatever it holds', () => {
    // Read to the first `]`, this was the key `"it`, and `em"]` was lost.
    expect(parseStatePath('answers["it]em"].text')).toEqual(['answers', 'it]em', 'text']);
    expect(parseStatePath('m["a.b"]')).toEqual(['m', 'a.b']);
    expect(parseStatePath('m["rows[0]"][1]')).toEqual(['m', 'rows[0]', '1']);
    expect(parseStatePath("m[\"it's\"]")).toEqual(['m', "it's"]);
    expect(parseStatePath('m[" padded "]')).toEqual(['m', ' padded ']);
  });

  it('takes the character after a backslash as written, in a key in double quotes', () => {
    expect(parseStatePath('m["say \\"hi\\""]')).toEqual(['m', 'say "hi"']);
    expect(parseStatePath('m["C:\\\\temp"]')).toEqual(['m', 'C:\\temp']);
    expect(parseStatePath('m["\\"]"].x')).toEqual(['m', '"]', 'x']);
  });

  it('reads an empty key in double quotes as a key', () => {
    expect(parseStatePath('m[""]')).toEqual(['m', '']);
    expect(parseStatePath('m[""].x')).toEqual(['m', '', 'x']);
  });

  it('reads the way the renderer writes: every text key round-trips', () => {
    for (const key of ['plain', 'a b', 'it]em', '"', '\\', '\\"', 'a\\', ']"[', '', ' ', "'", 'a.b', '0', '日本']) {
      expect(parseStatePath(`root${pathStep(key)}.end`), JSON.stringify(key)).toEqual(['root', key, 'end']);
    }
    expect(parseStatePath(`root${pathStep(3)}`)).toEqual(['root', '3']);
  });

  it('still reads a key written the older way, quotes inside it and all', () => {
    expect(parseStatePath('m["a"b"]')).toEqual(['m', 'a"b']);
    expect(parseStatePath('m[ "k" ]')).toEqual(['m', 'k']);
    expect(parseStatePath('m["unclosed]')).toEqual(['m', '"unclosed']);
  });
});
