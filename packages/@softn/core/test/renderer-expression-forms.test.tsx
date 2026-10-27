/**
 * What the renderer does with the expression forms the parser now reads
 * (parser-expression-forms.test.ts), and what it refuses.
 *
 * A template expression is evaluated in the host page, not in the script
 * VM, so each new form is also a question about what it could reach. The
 * last two groups are those answers: `new` constructs four classes and
 * nothing else, `Object` is three read-only functions, a spread cannot set a
 * prototype, and `in` cannot be turned into a throw.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import type { ElementNode } from '../src/parser';
import { renderDocument, ComponentRegistry, evaluateExpression } from '../src/renderer';
import type { SoftNRenderContext, SoftNProps } from '../src/types';

function contextFor(
  state: Record<string, unknown> = {},
  functions: Record<string, (...args: unknown[]) => unknown> = {}
) {
  const writes: Array<[string, unknown]> = [];
  const context: SoftNRenderContext = {
    state,
    setState: (path, value) => {
      writes.push([path, value]);
    },
    data: {},
    props: {},
    functions,
    asyncFunctions: {},
    computed: {},
  };
  return { context, writes };
}

/** Evaluate `source` as an expression against `state`. */
function evaluate(
  source: string,
  state: Record<string, unknown> = {},
  functions: Record<string, (...args: unknown[]) => unknown> = {}
): unknown {
  const doc = parse(`<Probe v={${source}} />`);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const value = (doc.template[0] as ElementNode).props[0].value;
  if (value.type !== 'expression') throw new Error(`not an expression: ${source}`);
  return evaluateExpression(value.value, contextFor(state, functions).context);
}

/** Call the handler `source` evaluates to, and say what it wrote and returned. */
function run(source: string, state: Record<string, unknown>) {
  const doc = parse(`<Probe @go={${source}} />`);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const { context, writes } = contextFor(state);
  const handler = evaluateExpression((doc.template[0] as ElementNode).events[0].handler, context);
  const returned = (handler as () => unknown)();
  return { writes, returned };
}

function render(source: string, state: Record<string, unknown>): string {
  const registry = new ComponentRegistry();
  registry.register('Text', ({ children }: SoftNProps) =>
    React.createElement('span', null, children as React.ReactNode)
  );
  return renderToStaticMarkup(
    renderDocument(parse(source), contextFor(state).context, registry) as React.ReactElement
  );
}

describe('arrows without parentheses', () => {
  it('filter and map a list the way the same line does in JavaScript', () => {
    const tasks = [
      { title: 'a', done: true },
      { title: 'b', done: false },
      { title: 'c', done: true },
    ];
    expect(evaluate('tasks.filter(t => t.done).length', { tasks })).toBe(2);
    expect(evaluate('tasks.map(t => t.title).join("")', { tasks })).toBe('abc');
    expect(render('<Text>{tasks.filter(t => !t.done).length} left</Text>', { tasks })).toBe(
      '<span>1 left</span>'
    );
  });

  it('bind their parameter over a state variable of the same name', () => {
    expect(evaluate('[1, 2, 3].map(count => count * 2)', { count: 100 })).toEqual([2, 4, 6]);
  });
});

describe('spread', () => {
  it('lays a list out in an array literal', () => {
    expect(evaluate('[0, ...rest, 9]', { rest: [1, 2] })).toEqual([0, 1, 2, 9]);
  });

  it('lays a list out as arguments', () => {
    expect(evaluate('Math.max(...scores)', { scores: [3, 11, 7] })).toBe(11);
    expect(evaluate('join("-", ...parts)', { parts: ['a', 'b'] }, {
      join: (sep, ...items) => items.join(String(sep)),
    })).toBe('a-b');
  });

  it('spreads anything that iterates', () => {
    expect(evaluate('[...word]', { word: 'abc' })).toEqual(['a', 'b', 'c']);
    expect(evaluate('[...new Set(tags)].length', { tags: ['x', 'y', 'x'] })).toBe(2);
  });

  it('spreads data that has not arrived yet to nothing', () => {
    // The usual reason a template meets undefined: the list is still loading.
    expect(evaluate('[...rows, "end"]', {})).toEqual(['end']);
    expect(evaluate('[...rows]', { rows: null })).toEqual([]);
    expect(evaluate('Math.max(0, ...scores)', {})).toBe(0);
    expect(evaluate('[...count]', { count: 7 })).toEqual([]);
  });

  it('does not overflow the stack on a long list', () => {
    const long = Array.from({ length: 300_000 }, (_, i) => i);
    expect((evaluate('[...long]', { long }) as unknown[]).length).toBe(300_000);
  });

  it('merges objects, later properties over earlier ones', () => {
    expect(evaluate('{ ...base, color: "red" }', { base: { color: 'blue', gap: 4 } })).toEqual({
      color: 'red',
      gap: 4,
    });
    expect(evaluate('{ color: "red", ...over }', { over: { color: 'green' } })).toEqual({
      color: 'green',
    });
    expect(evaluate('{ ...missing, a: 1 }', {})).toEqual({ a: 1 });
  });

  it('copies the object rather than aliasing it', () => {
    const base = { gap: 4 };
    const merged = evaluate('{ ...base }', { base }) as Record<string, unknown>;
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
  });
});

describe('increment and decrement', () => {
  it('write the new value through setState', () => {
    expect(run('() => count++', { count: 4 }).writes).toEqual([['count', 5]]);
    expect(run('() => --count', { count: 4 }).writes).toEqual([['count', 3]]);
  });

  it('are worth the old value after, and the new value before', () => {
    expect(run('() => count++', { count: 4 }).returned).toBe(4);
    expect(run('() => ++count', { count: 4 }).returned).toBe(5);
  });

  it('count a numeric string as a number, where += would append', () => {
    expect(run('() => qty++', { qty: '2' }).writes).toEqual([['qty', 3]]);
  });

  it('write the row inside an #each, at the path the loop resolved', () => {
    const doc = parse('<Probe @go={() => rows[i].qty++} />');
    const { context, writes } = contextFor({ rows: [{ qty: 1 }, { qty: 5 }], i: 1 });
    (evaluateExpression((doc.template[0] as ElementNode).events[0].handler, context) as () => void)();
    expect(writes).toEqual([['rows[1].qty', 6]]);
  });
});

describe('operators', () => {
  it('raise to a power', () => {
    expect(evaluate('2 ** 10')).toBe(1024);
    expect(evaluate('2 ** 3 ** 2')).toBe(512);
    expect(evaluate('2 * 3 ** 2')).toBe(18);
    expect(run('() => scale **= 3', { scale: 2 }).writes).toEqual([['scale', 8]]);
  });

  it('work on bits, as JavaScript does', () => {
    // Each was an "unexpected token" that cut the expression short.
    expect(evaluate('flags & 4', { flags: 6 })).toBe(4);
    expect(evaluate('flags | 1', { flags: 6 })).toBe(7);
    expect(evaluate('flags ^ 2', { flags: 6 })).toBe(4);
    expect(evaluate('~flags', { flags: 6 })).toBe(-7);
    expect(evaluate('1 << 4')).toBe(16);
    expect(evaluate('-16 >> 2')).toBe(-4);
    expect(evaluate('-1 >>> 28')).toBe(15);
    expect(evaluate('n & 1 ? "odd" : "even"', { n: 3 })).toBe('odd');
    expect(evaluate('1 | 2 & 3 ^ 4 << 1')).toBe(11);
    expect(run('() => flags |= 8', { flags: 6 }).writes).toEqual([['flags', 14]]);
    expect(run('() => flags >>>= 1', { flags: 6 }).writes).toEqual([['flags', 3]]);
  });

  it('read `?.` before a digit as a choice, as JavaScript does', () => {
    expect(evaluate('hidden?.3:1', { hidden: true })).toBe(0.3);
    expect(evaluate('hidden?.3:1', { hidden: false })).toBe(1);
    expect(evaluate('user?.name', { user: { name: 'Ada' } })).toBe('Ada');
  });

  it('format with Intl', () => {
    expect(evaluate('new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(1234.5)')).toBe('$1,234.50');
    expect(evaluate('Intl.NumberFormat("en-US").format(n)', { n: 1e6 })).toBe('1,000,000');
    expect(evaluate('new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(new Date(0))')).toBe('1/1/1970');
    expect(evaluate('new Intl.PluralRules("en-US").select(1)')).toBe('one');
  });

  it('answer in for an object and its keys', () => {
    expect(evaluate('"email" in errors', { errors: { email: 'Required' } })).toBe(true);
    expect(evaluate('"name" in errors', { errors: { email: 'Required' } })).toBe(false);
    expect(evaluate('1 in list', { list: ['a', 'b'] })).toBe(true);
  });

  it('answer false, rather than throw, for in on something that is not an object', () => {
    // JavaScript throws a TypeError here; a template asks it of data that
    // has not loaded.
    for (const errors of [undefined, null, 'text', 7, true]) {
      expect(evaluate('"email" in errors', { errors })).toBe(false);
    }
  });

  it('answer instanceof for a class the template can name', () => {
    expect(evaluate('due instanceof Date', { due: new Date(0) })).toBe(true);
    expect(evaluate('due instanceof Date', { due: '2026-01-01' })).toBe(false);
  });

  it('read undefined as the value', () => {
    expect(evaluate('choice === undefined ? "none" : choice', {})).toBe('none');
    expect(evaluate('choice === undefined ? "none" : choice', { choice: 'b' })).toBe('b');
  });

  it('read a hexadecimal number', () => {
    expect(evaluate('0xff')).toBe(255);
  });
});

describe('new', () => {
  it('constructs a Date', () => {
    expect(evaluate('new Date(2026, 0, 15).getFullYear()')).toBe(2026);
    expect(evaluate('new Date(stamp).toISOString()', { stamp: 0 })).toBe('1970-01-01T00:00:00.000Z');
    expect(evaluate('new Date() instanceof Date')).toBe(true);
  });

  it('constructs an Array, a Set and a Map', () => {
    expect(evaluate('new Array(3).fill(0)')).toEqual([0, 0, 0]);
    expect(evaluate('new Set(tags).size', { tags: ['a', 'b', 'a'] })).toBe(2);
    expect(evaluate('new Map(pairs).get("b")', { pairs: [['a', 1], ['b', 2]] })).toBe(2);
  });

  it('constructs nothing else', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    class Probe {
      static made = 0;
      constructor() {
        Probe.made++;
      }
    }
    // A class handed to the template as state, a function it was given, a
    // built-in it can name, and a constructor it cannot reach by name.
    expect(evaluate('new Thing()', { Thing: Probe })).toBeUndefined();
    expect(evaluate('new make()', {}, { make: Probe as unknown as () => unknown })).toBeUndefined();
    expect(evaluate('new String("x")')).toBeUndefined();
    expect(evaluate('new Missing()')).toBeUndefined();
    expect(Probe.made).toBe(0);
    error.mockRestore();
  });

  it('cannot reach Function through a constructor property', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(evaluate('new Date.constructor("return 1")')).toBeUndefined();
    expect(evaluate('new tasks.constructor.constructor("return 1")', { tasks: [] })).toBeUndefined();
    error.mockRestore();
    // The class after `new` is a name and a member path; nothing computed.
    expect(parse('<Probe v={new (Date).constructor("return 1")} />').diagnostics).toHaveLength(1);
  });
});

describe('Object in a template', () => {
  it('lists keys, values and entries', () => {
    const totals = { open: 3, done: 5 };
    expect(evaluate('Object.keys(totals)', { totals })).toEqual(['open', 'done']);
    expect(evaluate('Object.values(totals)', { totals })).toEqual([3, 5]);
    expect(evaluate('Object.entries(totals)', { totals })).toEqual([['open', 3], ['done', 5]]);
    expect(render('#each (key in Object.keys(totals))\n<Text>{key}={totals[key]}</Text>\n#end', { totals })).toBe(
      '<span>open=3</span><span>done=5</span>'
    );
  });

  it('answers an empty list for data that has not arrived', () => {
    expect(evaluate('Object.keys(totals)', {})).toEqual([]);
    expect(evaluate('Object.entries(totals)', { totals: null })).toEqual([]);
  });

  it('is those three functions and nothing that writes', () => {
    for (const name of [
      'defineProperty', 'defineProperties', 'assign', 'setPrototypeOf', 'getPrototypeOf',
      'create', 'freeze', 'fromEntries', 'getOwnPropertyDescriptor', 'constructor', 'prototype',
    ]) {
      expect(evaluate(`Object.${name}`), name).toBeUndefined();
    }
    expect(evaluate('Object.keys.constructor')).toBeUndefined();
  });

  it('cannot be replaced or extended from a template', () => {
    const { writes } = run('() => Object.keys = 1', {});
    // An assignment writes app state at that path; the global is untouched.
    expect(writes).toEqual([['Object.keys', 1]]);
    expect(evaluate('Object.keys({ a: 1 })')).toEqual(['a']);
  });

  it('gives way to a state variable of the same name', () => {
    expect(evaluate('Object.label', { Object: { label: 'mine' } })).toBe('mine');
  });
});

describe('the page\'s shared objects', () => {
  // Template expressions run in the host page, so a write here would reach
  // every app on it and the host's own code.
  it('cannot be rewritten through the legacy accessor methods', () => {
    const random = Math.random;
    for (const source of [
      'Math.__defineGetter__("random", () => 4)',
      'Math.__defineSetter__("random", () => 4)',
      'Math["__defineGetter__"]("random", () => 4)',
      'tasks.__lookupGetter__("__proto__")',
      '({}).__lookupSetter__("__proto__")',
    ]) {
      expect(evaluate(source, { tasks: [] }), source).toBeUndefined();
    }
    expect(Math.random).toBe(random);
    expect(Math.random()).not.toBe(4);
  });

  it('hands over no built-in prototype, however it is reached', () => {
    const getter = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')!.get!;
    for (const [name, value] of Object.entries({ objects: getter.call({}), lists: getter.call([]), functions: getter.call(() => 1) })) {
      expect(evaluate('box.held', { box: { held: value } }), name).toBeUndefined();
      expect(evaluate('held', { held: value }), name).toBeUndefined();
    }
  });

  it('gives Math, JSON and Intl as read-only copies that work as the real ones', () => {
    expect(evaluate('Math.max(1, Math.round(2.6))')).toBe(3);
    expect(evaluate('Math.PI')).toBe(Math.PI);
    expect(evaluate('JSON.stringify(JSON.parse("[1,2]"))')).toBe('[1,2]');
    expect(evaluate('new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(5)')).toBe('$5.00');
    // A generic array method aimed at them writes nothing: the copy is frozen.
    const before = [Object.getOwnPropertyNames(Math).length, Object.getOwnPropertyNames(JSON).length, Object.getOwnPropertyNames(Intl).length];
    for (const source of ['[].push.call(Math, 1)', '[1].forEach([].push, JSON)', '[].push.apply(Intl, [1])']) {
      try {
        evaluate(source);
      } catch {
        // A frozen object refuses the write with a TypeError; either way nothing lands.
      }
    }
    expect([Object.getOwnPropertyNames(Math).length, Object.getOwnPropertyNames(JSON).length, Object.getOwnPropertyNames(Intl).length]).toEqual(before);
    expect((Math as unknown as Record<string, unknown>)[0]).toBeUndefined();
  });
});

describe('an object spread and the prototype', () => {
  it('does not carry a __proto__ key across', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
    const merged = evaluate('{ ...hostile }', { hostile }) as Record<string, unknown>;
    expect(merged).toEqual({ safe: 1 });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((merged as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('does not carry constructor or prototype keys across', () => {
    const hostile = JSON.parse('{"constructor": 1, "prototype": 2, "kept": 3}');
    expect(evaluate('{ ...hostile }', { hostile })).toEqual({ kept: 3 });
  });
});
