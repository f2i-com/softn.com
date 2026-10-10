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

  it('is as written where the script has no top-level $:', () => {
    const code = 'let n = 1\nfunction f() {\n  $: inner = n\n}';
    expect(guardFirstValues(code, planComputed(declarations(code)))).toBe(code);
  });
});
