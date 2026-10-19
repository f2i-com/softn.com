/**
 * The part of `$:` with no engine in it: reading the declarations out of a
 * script, ordering them, and writing the code generated for them.
 *
 * computed-dependencies.test.ts holds the behaviour, against the engine.
 * These hold the three places where a wrong answer would be quiet: a name
 * taken for a read that is not one (or missed), an order with a value ahead
 * of what it reads, and generated code that moves the author's lines.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPUTED_FIRST_FUNCTION,
  extractComputedDeclarations,
  guardFirstValues,
  namesReadBy,
  planComputed,
} from '../src/runtime/computed-declarations';

const declarations = (code: string) => extractComputedDeclarations(code);
const order = (code: string) => planComputed(declarations(code)).order.map((declaration) => declaration.name);

describe('the names an expression reads', () => {
  it('are the ones that stand by themselves, not the properties of another', () => {
    expect([...namesReadBy('todos.filter(t => !t.done).length + extra')].sort()).toEqual(['extra', 't', 'todos']);
  });

  it('include a name that is spread', () => {
    expect([...namesReadBy('[...done, item]')].sort()).toEqual(['done', 'item']);
  });

  it('do not include a word in a string or a comment', () => {
    expect([...namesReadBy('label + " of total" /* not count */ // nor rest')]).toEqual(['label']);
    expect([...namesReadBy("a + 'it\\'s b'")]).toEqual(['a']);
  });
});

describe('where a $: expression ends', () => {
  const expression = (code: string) => declarations(code)[0]?.expression;

  it('is a later line, where that line starts with something that carries the expression on', () => {
    expect(expression('$: open = todos\n  .filter(t => !t.done)\n  .length\nlet after = 1')).toBe(
      'todos\n  .filter(t => !t.done)\n  .length'
    );
    expect(expression('$: size = n > 2\n  ? "big"\n  : "small"\nlet after = 1')).toBe('n > 2\n  ? "big"\n  : "small"');
    expect(expression('$: x = a\n  ?? b\n  || c\n  && d?.e\n  !== f\nlet after = 1')).toBe('a\n  ?? b\n  || c\n  && d?.e\n  !== f');
    // As in JavaScript, a line that starts with `+` or `-` adds to or takes
    // from the line before, and one that starts with `(` or `[` calls or
    // indexes it: the engine reads the script so, and the two must agree.
    expect(expression('$: total = a\n  + b\n  - c\nlet after = 1')).toBe('a\n  + b\n  - c');
    expect(expression('$: picked = choose\n(1)\n[0]\nlet after = 1')).toBe('choose\n(1)\n[0]');
    expect(expression('$: found = "x"\n  in table\nlet after = 1')).toBe('"x"\n  in table');
  });

  it('is a later line, where the line before ends on something that wants more', () => {
    expect(expression('$: total = a +\n  b\nlet after = 1')).toBe('a +\n  b');
    expect(expression('$: both = a &&\n  b\nlet after = 1')).toBe('a &&\n  b');
    expect(expression('$: twice = list.map(x =>\n  x * 2)\nlet after = 1')).toBe('list.map(x =>\n  x * 2)');
    expect(expression('$: ratio = a /\n  b\nlet after = 1')).toBe('a /\n  b');
    expect(expression('$: isList = value instanceof\n  Array\nlet after = 1')).toBe('value instanceof\n  Array');
    expect(expression('$: answer =\n  42\nlet after = 1')).toBe('42');
  });

  it('carries on past blank lines and comments, as JavaScript does', () => {
    expect(expression('$: total = a // the first\n\n  // and then\n  + b\nlet after = 1')).toBe(
      'a // the first\n\n  // and then\n  + b'
    );
  });

  it('is the line’s end, where the next line starts a statement of its own', () => {
    expect(expression('$: n = a\nlet b = 1')).toBe('a');
    // `++` after a line break belongs to what follows it, never to the line before.
    expect(expression('$: n = a\n++count')).toBe('a');
    expect(expression('$: n = count++\nother()')).toBe('count++');
    // Words that only begin like `in`, or end like it, are names.
    expect(expression('$: n = a\nindex = 2')).toBe('a');
    expect(expression('$: n = a\ninstances = 2')).toBe('a');
    expect(expression('$: n = margin\nlet b = 1')).toBe('margin');
    expect(expression('$: n = obj.in\nlet b = 1')).toBe('obj.in');
    // A regular expression ends on a `/` that is not a division.
    expect(expression('$: re = /ab+c/\nlet b = 1')).toBe('/ab+c/');
    expect(expression('$: re = /[/(]+/gi\nlet b = 1')).toBe('/[/(]+/gi');
    expect(expression('$: ok = /\\/$/.test(path)\nlet b = 1')).toBe('/\\/$/.test(path)');
  });

  it('is the end of the block it is written in', () => {
    const found = declarations('function f() {\n  $: inner = a +\n    b\n}\n$: last = c');
    expect(found.map(({ name, expression: e }) => [name, e])).toEqual([
      ['inner', 'a +\n    b'],
      ['last', 'c'],
    ]);
  });

  it('is found the same way in a script saved with Windows line ends', () => {
    expect(expression('$: total = a +\r\n  b\r\nlet after = 1')).toBe('a +\r\n  b');
    expect(expression('$: open = todos\r\n  .length\r\nlet after = 1')).toBe('todos\r\n  .length');
    expect(expression('$: n = a\r\nlet b = 1')).toBe('a');
  });
});

describe('the order $: values are worked out in', () => {
  it('puts each after the ones it reads, whatever order they are written in', () => {
    expect(order('$: c = b + 1\n$: b = a + 1\n$: a = n\n$: alone = 1')).toEqual(['a', 'alone', 'b', 'c']);
  });

  it('is the order written, where nothing reads anything', () => {
    expect(order('$: z = 1\n$: y = 2\n$: x = 3')).toEqual(['z', 'y', 'x']);
  });

  it('is not disturbed by a value that names itself', () => {
    // `items => items.length` names a parameter, not the value being declared.
    expect(planComputed(declarations('$: items = lists.map(items => items.length)')).circles).toEqual([]);
  });

  it('leaves a circle in the order written, after the rest, and names it', () => {
    const plan = planComputed(declarations('$: a = b + 1\n$: free = 1\n$: b = c + 1\n$: c = a + 1\n$: after = a + free'));
    expect(plan.order.map((declaration) => declaration.name)).toEqual(['free', 'a', 'b', 'c', 'after']);
    expect(plan.circles).toEqual([['a', 'b', 'c', 'a']]);
  });

  it('leaves out a declaration written inside a function or a block', () => {
    const found = declarations('$: top = 1\nfunction f() {\n  $: inner = 2\n}\nif (x) { $: guarded = 3 }\n$: last = top');
    expect(found.map(({ name, topLevel }) => [name, topLevel])).toEqual([
      ['top', true],
      ['inner', false],
      ['guarded', false],
      ['last', true],
    ]);
    expect(planComputed(found).order.map((declaration) => declaration.name)).toEqual(['top', 'last']);
  });
});

describe('the script as it is compiled', () => {
  it('has each top-level expression replaced where it stood, and every line where it was', () => {
    const code = ['let n = 1', '$: list = [', '  n,', '  n * 2,', ']; let after = list.length', '$: label = "n is " + n // a note', 'function f() { return label }'].join('\n');
    const compiled = guardFirstValues(code, planComputed(declarations(code)));
    const lines = compiled.split('\n');
    expect(lines).toHaveLength(code.split('\n').length);
    expect(lines[1]).toBe(`$: list = ${COMPUTED_FIRST_FUNCTION}(__softnComputed_list)`);
    // What followed the expression on its last line is still on that line.
    expect(lines[4]).toBe('; let after = list.length');
    expect(lines[5]).toBe(`$: label = ${COMPUTED_FIRST_FUNCTION}(__softnComputed_label)`);
    expect(lines[6]).toBe('function f() { return label }');
  });

  it('keeps every line of an expression carried over several', () => {
    const code = ['let todos = []', '$: open = todos', '  .filter(t => !t.done)', '  .length; let after = open', 'function f() { return open }'].join('\n');
    const compiled = guardFirstValues(code, planComputed(declarations(code)));
    expect(compiled.split('\n')).toEqual([
      'let todos = []',
      `$: open = ${COMPUTED_FIRST_FUNCTION}(__softnComputed_open)`,
      '',
      '; let after = open',
      'function f() { return open }',
    ]);
  });

  it('is as written where the script has no top-level $:', () => {
    const code = 'let n = 1\nfunction f() {\n  $: inner = n\n}';
    expect(guardFirstValues(code, planComputed(declarations(code)))).toBe(code);
  });
});
