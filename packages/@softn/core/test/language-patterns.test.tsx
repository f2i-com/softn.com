/**
 * Taking a value apart where it is bound, and the lists `#each` goes through.
 *
 * `Object.entries` became something a template can call, and the callback
 * everyone writes for it could not be read:
 *
 *     {Object.entries(totals).map(([name, total]) => name + ": " + total)}
 *
 * An arrow's parameters were names and nothing else, so this was "expected
 * RPAREN". A parameter may now be a list or a record that takes its argument
 * apart, have a default, or gather the rest; `#each` takes the same patterns
 * for its variable; and an object literal may work out a key.
 *
 * `#each` also went through lists only. A Set or a Map, which a template can
 * now build, a record and a count all drew the `#empty` branch as though
 * they held nothing.
 *
 * And two things that were read as something else with nothing said:
 * control flow inside `#empty` (an `#if` there drew both its branches) and
 * `(a, b)` with no arrow after it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { parse, patternNames, patternText } from '../src/parser';
import type { ArrowFunctionExpression, EachBlock, ElementNode, Expression } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';

afterEach(() => {
  vi.restoreAllMocks();
});

function shape<T>(node: T): T {
  return JSON.parse(JSON.stringify(node, (key, value) => (key === 'loc' ? undefined : value)));
}

function diagnostics(source: string): string[] {
  return (parse(source).diagnostics ?? []).map((d) => d.message);
}

function expr(source: string): Expression {
  const doc = parse(`<Probe v={${source}} />`);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const value = (doc.template[0] as ElementNode).props[0].value;
  if (value.type !== 'expression') throw new Error(`not an expression: ${source}`);
  return shape(value.value);
}

function arrow(source: string): ArrowFunctionExpression {
  const parsed = expr(source);
  if (parsed.type !== 'ArrowFunctionExpression') throw new Error(`not an arrow: ${source}`);
  return parsed;
}

/** What a page of `source` draws, as markup. */
function drawn(source: string, state: Record<string, unknown> = {}, functions: Record<string, (...args: unknown[]) => unknown> = {}): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const context = { state, setState: () => {}, data: {}, props: {}, computed: {}, functions, asyncFunctions: {} };
  return renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderDocument(doc, context as never, new ComponentRegistry()))
  );
}

/** What `{source}` is worth. */
function worth(source: string, state: Record<string, unknown> = {}): string {
  return drawn(`<p>{${source}}</p>`, state).replace(/^<p>|<\/p>$/g, '');
}

const name = (text: string) => ({ type: 'NamePattern', name: text });

describe('an arrow’s parameters', () => {
  it('are still a list of names for an arrow that has only names', () => {
    const plain = arrow('(a, b) => a + b');
    expect(plain.params).toEqual(['a', 'b']);
    expect(plain).not.toHaveProperty('patterns');
    expect(arrow('t => t.done')).not.toHaveProperty('patterns');
    expect(arrow('() => 1').params).toEqual([]);
  });

  it('take a list apart', () => {
    const parsed = arrow('([key, value]) => key');
    expect(parsed.params).toEqual(['key', 'value']);
    expect(parsed.patterns).toEqual([
      { pattern: { type: 'ArrayPattern', elements: [{ pattern: name('key') }, { pattern: name('value') }] } },
    ]);
  });

  it('take a record apart, under another name or deeper', () => {
    expect(arrow('({ id, title }) => id').params).toEqual(['id', 'title']);
    const renamed = arrow('({ title: heading, owner: { name } }) => heading');
    expect(renamed.params).toEqual(['heading', 'name']);
    expect(renamed.patterns?.[0].pattern).toEqual({
      type: 'ObjectPattern',
      properties: [
        { key: 'title', value: { pattern: name('heading') } },
        { key: 'owner', value: { pattern: { type: 'ObjectPattern', properties: [{ key: 'name', value: { pattern: name('name') } }] } } },
      ],
    });
  });

  it('have defaults and a rest', () => {
    const parsed = arrow('(first, step = 1, ...others) => first');
    expect(parsed.params).toEqual(['first', 'step', 'others']);
    expect(parsed.patterns).toEqual([
      { pattern: name('first') },
      { pattern: name('step'), default: { type: 'Literal', value: 1, raw: '1' } },
      { pattern: name('others'), rest: true },
    ]);
    expect(arrow('([head, ...tail]) => tail').params).toEqual(['head', 'tail']);
    expect(arrow('({ id, ...fields }) => fields').params).toEqual(['id', 'fields']);
  });

  it('are read where they are written: as an argument', () => {
    expect(diagnostics('<Text>{Object.entries(totals).map(([name, total]) => name + ": " + total).join(", ")}</Text>')).toEqual([]);
    expect(diagnostics('<Text>{items.reduce((sum, { price, qty }) => sum + price * qty, 0)}</Text>')).toEqual([]);
    expect(diagnostics('<Button @click={({ id }) => open(id)}>Open</Button>')).toEqual([]);
  });

  it('are reported when they are not parameters', () => {
    for (const source of ['(a + 1) => a', '(a, ...b, c) => a', '(a.b) => a', '(1) => 1', '([a], a) => a', '({ [k]: v }) => v']) {
      const said = diagnostics(`<Text>{${source}}</Text>`);
      expect(said.some((message) => message.includes('not a parameter list')), source).toBe(true);
    }
  });

  it('leave an expression in parentheses an expression', () => {
    expect(expr('(a)')).toEqual({ type: 'Identifier', name: 'a' });
    expect(expr('(a + b) * 2')).toMatchObject({ type: 'BinaryExpression', operator: '*' });
    expect(expr('(count = 0)')).toMatchObject({ type: 'AssignmentExpression' });
    expect(expr('([1, 2])')).toMatchObject({ type: 'ArrayExpression' });
    expect(expr('({ a: 1 })')).toMatchObject({ type: 'ObjectExpression' });
    expect(expr('(x => x)(1)')).toMatchObject({ type: 'CallExpression' });
  });

  it('report a comma in parentheses with no arrow after it', () => {
    const said = diagnostics('<Text>{(a, b)}</Text>');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Unexpected "," in parentheses');
  });
});

describe('what a destructured arrow is worth', () => {
  it('names the two halves of an entry', () => {
    expect(worth('Object.entries(totals).map(([name, total]) => name + "=" + total).join(" ")', { totals: { a: 1, b: 2 } })).toBe('a=1 b=2');
  });

  it('names fields of a record', () => {
    const tasks = [{ id: 't1', title: 'One', owner: { name: 'Ada' } }, { id: 't2', title: 'Two', owner: { name: 'Hedy' } }];
    expect(worth('tasks.map(({ id }) => id).join(",")', { tasks })).toBe('t1,t2');
    expect(worth('tasks.map(({ title: heading, owner: { name } }) => heading + "/" + name).join(",")', { tasks })).toBe('One/Ada,Two/Hedy');
    expect(worth('tasks.reduce((count, { owner }) => count + (owner.name === "Ada" ? 1 : 0), 0)', { tasks })).toBe('1');
  });

  it('uses a default for an argument that is undefined, and only then', () => {
    expect(worth('((a, b = 10) => a + b)(1)')).toBe('11');
    expect(worth('((a, b = 10) => a + b)(1, 2)')).toBe('3');
    expect(worth('((a, b = 10) => String(b))(1, null)')).toBe('null');
    // A default sees the parameters before it.
    expect(worth('((a, b = a * 2) => b)(4)')).toBe('8');
    expect(worth('(([a = "x", b = "y"]) => a + b)(["p"])')).toBe('py');
    expect(worth('(({ size: s = "md" }) => s)({})')).toBe('md');
    // The short form, which is the one that gets written.
    expect(worth('(({ size = "md", tone = "plain" }) => size + "/" + tone)({ tone: "loud" })')).toBe('md/loud');
    expect(worth('tasks.reduce((sum, { minutes = 0 }) => sum + minutes, 0)', { tasks: [{ minutes: 5 }, {}, { minutes: 2 }] })).toBe('7');
  });

  it('reads a name with a default inside { } only where a record is taken apart', () => {
    expect(arrow('({ size = "md" }) => size').patterns).toEqual([
      {
        pattern: {
          type: 'ObjectPattern',
          properties: [{ key: 'size', value: { pattern: name('size'), default: { type: 'Literal', value: 'md', raw: '"md"' } } }],
        },
      },
    ]);
    // In a record that is being made it means nothing, and says so.
    const said = diagnostics('<Box v={{ size = "md" }} />');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('only read where a record is taken apart');
    expect(diagnostics('<Text>{({ size = "md" })}</Text>')).toHaveLength(1);
  });

  it('gathers the rest', () => {
    expect(worth('((first, ...others) => others.length)(1, 2, 3)')).toBe('2');
    expect(worth('(([head, ...tail]) => tail.join("-"))([1, 2, 3])')).toBe('2-3');
    expect(worth('(({ id, ...fields }) => Object.keys(fields).join(","))({ id: 1, a: 2, b: 3 })')).toBe('a,b');
    expect(worth('((...all) => all.length)()')).toBe('0');
  });

  it('takes a Map’s entries and a Set’s members apart as lists', () => {
    expect(worth('(([[k, v]]) => k + v)(new Map([["a", 1]]))')).toBe('a1');
    expect(worth('(([first]) => first)(new Set(["only"]))')).toBe('only');
  });

  it('binds nothing, rather than throwing, when there is nothing to take apart', () => {
    expect(worth('String((([a, b]) => a)(null))')).toBe('undefined');
    expect(worth('String((({ id }) => id)(undefined))')).toBe('undefined');
    expect(worth('String((([a]) => a)(7))')).toBe('undefined');
    expect(worth('rows.map(({ id }) => String(id)).join(",")', { rows: [null, { id: 2 }] })).toBe('undefined,2');
  });

  it('lets a parameter hide a state variable, and not after the call', () => {
    expect(worth('items.map(({ n }) => n * by).join(",") + ":" + n', { items: [{ n: 1 }, { n: 2 }], by: 10, n: 'outer' })).toBe('10,20:outer');
  });

  it('does not reach what a member access does not reach', () => {
    expect(worth('String((({ constructor }) => constructor)({}))')).toBe('undefined');
    expect(worth('String((({ __proto__: p }) => p)({}))')).toBe('undefined');
    // From state, where a record can have such a key; one written in the
    // page cannot.
    const source = JSON.parse('{ "a": 1, "constructor": 2, "b": 3 }');
    expect(worth('Object.keys((({ a, ...rest }) => rest)(source)).join(",")', { source })).toBe('b');
  });
});

describe('a computed key', () => {
  it('parses to a property whose key is an expression', () => {
    expect(expr('{ [field]: 1, fixed: 2 }')).toEqual({
      type: 'ObjectExpression',
      properties: [
        { type: 'ObjectProperty', key: '', computedKey: { type: 'Identifier', name: 'field' }, value: { type: 'Literal', value: 1, raw: '1' }, shorthand: false },
        { type: 'ObjectProperty', key: 'fixed', value: { type: 'Literal', value: 2, raw: '2' }, shorthand: false },
      ],
    });
  });

  it('is the key it works out to', () => {
    expect(worth('JSON.stringify({ ...filters, [field]: "x" })', { filters: { a: 1, b: 2 }, field: 'b' })).toBe('{&quot;a&quot;:1,&quot;b&quot;:&quot;x&quot;}');
    expect(worth('JSON.stringify({ ["n" + 1]: true, [2]: false })')).toBe('{&quot;2&quot;:false,&quot;n1&quot;:true}');
  });

  it('cannot set what a written key cannot', () => {
    expect(worth('JSON.stringify({ ["__proto__"]: { polluted: true }, a: 1 })')).toBe('{&quot;a&quot;:1}');
    expect(worth('String({ [key]: { polluted: true } }.polluted)', { key: '__proto__' })).toBe('undefined');
    expect(worth('String({ ["constructor"]: 1 }.constructor === 1)')).toBe('false');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('writes a record back with one field replaced, in a handler', () => {
    const doc = parse('<button @click={() => filters = { ...filters, [field]: "on" }}>set</button>');
    expect(doc.diagnostics ?? []).toEqual([]);
    const writes: Array<[string, unknown]> = [];
    const context = {
      state: { filters: { a: 'off', b: 'off' }, field: 'b' },
      setState: (path: string, value: unknown) => writes.push([path, value]),
      data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {},
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => root.render(renderDocument(doc, context as never, new ComponentRegistry()) as React.ReactElement));
    act(() => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writes).toEqual([['filters', { a: 'off', b: 'on' }]]);
    act(() => root.unmount());
    container.remove();
  });
});

describe('the variable of an #each', () => {
  function each(source: string): EachBlock {
    const doc = parse(source);
    expect(doc.diagnostics ?? [], source).toEqual([]);
    return doc.template[0] as EachBlock;
  }

  it('is a name, as it was', () => {
    const block = each('#each (task, i in tasks)\n<p>{task}</p>\n#end');
    expect(block.itemName).toBe('task');
    expect(block.indexName).toBe('i');
    expect(block).not.toHaveProperty('itemPattern');
  });

  it('may take the item apart', () => {
    const pair = each('#each ([key, value] in Object.entries(totals))\n<p>{key}</p>\n#end');
    expect(pair.itemName).toBe('[key, value]');
    expect(patternNames(pair.itemPattern!)).toEqual(['key', 'value']);
    const record = each('#each ({ id, title: heading, ...other }, i in tasks) key={id}\n<p>{heading}</p>\n#end');
    expect(record.itemName).toBe('{ id, title: heading, ...other }');
    expect(record.indexName).toBe('i');
    expect(patternNames(record.itemPattern!)).toEqual(['id', 'heading', 'other']);
    expect(shape(record.keyExpression)).toEqual({ type: 'Identifier', name: 'id' });
  });

  it('is written back as it was read', () => {
    for (const text of ['[key, value]', '{ id, title }', '{ id, owner: { name } }', '[first, ...others]', '{ id, ...fields }', '{ "a b": spaced }']) {
      const block = each(`#each (${text} in rows)\n<p>x</p>\n#end`);
      expect(block.itemName).toBe(text);
      expect(patternText(block.itemPattern!)).toBe(text);
      // And what was written back reads as the same pattern.
      expect(shape(each(`#each (${block.itemName} in rows)\n<p>x</p>\n#end`).itemPattern)).toEqual(shape(block.itemPattern));
    }
  });

  it('is reported when it is not a pattern, or has a default', () => {
    expect(diagnostics('#each ([a + 1] in rows)\n<p>x</p>\n#end').join(' ')).toContain('not something #each can take an item apart into');
    expect(diagnostics('#each ({ id: n = 1 } in rows)\n<p>x</p>\n#end').join(' ')).toContain('A default');
    // One report, in #each's own words, for the short form too.
    const short = diagnostics('#each ({ done = false } in rows)\n<p>x</p>\n#end');
    expect(short).toHaveLength(1);
    expect(short[0]).toContain('A default (name = value) is not read in the variable of an #each');
  });

  it('draws with each name bound', () => {
    expect(drawn('#each ([key, value] in Object.entries(totals))\n<i>{key}={value}</i>\n#end', { totals: { a: 1, b: 2 } })).toBe('<i>a=1</i><i>b=2</i>');
    expect(
      drawn('#each ({ id, owner: { name } }, i in tasks) key={id}\n<i>{i}:{id}:{name}</i>\n#end', {
        tasks: [{ id: 'x', owner: { name: 'Ada' } }, { id: 'y', owner: { name: 'Hedy' } }],
      })
    ).toBe('<i>0:x:Ada</i><i>1:y:Hedy</i>');
  });

  it('draws a row for an item that is not there to take apart', () => {
    expect(drawn('#each ({ id } in rows)\n<i>{String(id)}</i>\n#end', { rows: [null, { id: 2 }] })).toBe('<i>undefined</i><i>2</i>');
  });
});

describe('a control bound to a name taken out of the loop item', () => {
  function writesOf(source: string, state: Record<string, unknown>, act_: (container: HTMLElement) => void): Array<[string, unknown]> {
    const doc = parse(source);
    expect(doc.diagnostics ?? [], source).toEqual([]);
    const writes: Array<[string, unknown]> = [];
    const context = { state, setState: (path: string, value: unknown) => writes.push([path, value]), data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => root.render(renderDocument(doc, context as never, new ComponentRegistry()) as React.ReactElement));
    act(() => act_(container));
    act(() => root.unmount());
    container.remove();
    return writes;
  }
  const typeInto = (index: number, text: string) => (container: HTMLElement) => {
    const input = container.querySelectorAll('input')[index];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('writes the field of the row', () => {
    const todos = [{ title: 'A', owner: { name: 'Ada' } }, { title: 'B', owner: { name: 'Hedy' } }];
    expect(writesOf('#each ({ title } in todos)\n<input :bind={title} />\n#end', { todos }, typeInto(1, 'New'))).toEqual([['todos[1].title', 'New']]);
    expect(writesOf('#each ({ owner: { name } } in todos)\n<input :bind={name} />\n#end', { todos }, typeInto(0, 'Grace'))).toEqual([['todos[0].owner.name', 'Grace']]);
  });

  it('writes the position of a pair', () => {
    const pairs = [['a', 1], ['b', 2]];
    expect(writesOf('#each ([label, amount] in pairs)\n<input :bind={label} />\n#end', { pairs }, typeInto(1, 'z'))).toEqual([['pairs[1][0]', 'z']]);
  });

  it('writes nothing for the rest, which has no place of its own', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const todos = [{ title: 'A', n: 1 }];
    expect(writesOf('#each ({ title, ...other } in todos)\n<input :bind={other.n} />\n#end', { todos }, typeInto(0, '5'))).toEqual([]);
  });
});

describe('what #each goes through', () => {
  it('a Set’s members', () => {
    expect(drawn('#each (tag in new Set(tags))\n<i>{tag}</i>\n#empty\n<b>none</b>\n#end', { tags: ['a', 'b', 'a'] })).toBe('<i>a</i><i>b</i>');
  });

  it('a Map’s pairs, with a pattern or without', () => {
    const state = { pairs: [['a', 1], ['b', 2]] };
    expect(drawn('#each ([name, n] in new Map(pairs))\n<i>{name}{n}</i>\n#end', state)).toBe('<i>a1</i><i>b2</i>');
    expect(drawn('#each (pair, i in new Map(pairs))\n<i>{i}{pair[0]}</i>\n#end', state)).toBe('<i>0a</i><i>1b</i>');
  });

  it('a record’s values, with the key where a list has the index', () => {
    expect(drawn('#each (value, key in settings)\n<i>{key}={value}</i>\n#empty\n<b>none</b>\n#end', { settings: { theme: 'dark', size: 2 } })).toBe(
      '<i>theme=dark</i><i>size=2</i>'
    );
    expect(drawn('#each (value in settings)\n<i>{value}</i>\n#empty\n<b>none</b>\n#end', { settings: {} })).toBe('<b>none</b>');
  });

  it('a count, from 1', () => {
    expect(drawn('#each (n in 3)\n<i>{n}</i>\n#end')).toBe('<i>1</i><i>2</i><i>3</i>');
    expect(drawn('#each (n, i in stars)\n<i>{i}:{n}</i>\n#end', { stars: 2 })).toBe('<i>0:1</i><i>1:2</i>');
    expect(drawn('#each (n in pages)\n<i>{n}</i>\n#empty\n<b>none</b>\n#end', { pages: 0 })).toBe('<b>none</b>');
  });

  it('nothing for a number that is not a count, and says so once', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const count of [-1, 2.5, 1e9, NaN]) {
      expect(drawn('#each (n in count)\n<i>{n}</i>\n#empty\n<b>none</b>\n#end', { count }), String(count)).toBe('<b>none</b>');
    }
    expect(errors.mock.calls.filter((call) => String(call[0]).includes('not a count')).length).toBe(4);
  });

  it('nothing for text, which is not a list of its letters here', () => {
    expect(drawn('#each (c in word)\n<i>{c}</i>\n#empty\n<b>none</b>\n#end', { word: 'abc' })).toBe('<b>none</b>');
    expect(drawn('#each (c in missing)\n<i>{c}</i>\n#empty\n<b>none</b>\n#end')).toBe('<b>none</b>');
    expect(drawn('#each (c in flag)\n<i>{c}</i>\n#empty\n<b>none</b>\n#end', { flag: true })).toBe('<b>none</b>');
  });

  it('the same for each= on a tag', () => {
    expect(drawn('<i each={new Set(tags)} as="tag">{tag}</i>', { tags: ['a', 'a', 'b'] })).toBe('<i>a</i><i>b</i>');
    expect(drawn('<i each={settings} as="value, key">{key}={value}</i>', { settings: { a: 1 } })).toBe('<i>a=1</i>');
    expect(drawn('<i each={3} as="n">{n}</i>')).toBe('<i>1</i><i>2</i><i>3</i>');
  });

  it('writes a record’s value back at its key', () => {
    const doc = parse('#each (value, key in settings)\n<input :bind={value} />\n#end');
    const writes: Array<[string, unknown]> = [];
    const context = { state: { settings: { theme: 'dark', size: 'm' } }, setState: (path: string, value: unknown) => writes.push([path, value]), data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => root.render(renderDocument(doc, context as never, new ComponentRegistry()) as React.ReactElement));
    act(() => {
      const input = container.querySelectorAll('input')[1];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'l');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(writes).toEqual([['settings["size"]', 'l']]);
    act(() => root.unmount());
    container.remove();
  });
});

describe('control flow inside #empty', () => {
  it('an #if there draws one branch', () => {
    const source = '#each (t in tasks)\n<p>{t}</p>\n#empty\n#if (loading)\n<i>Loading</i>\n#else\n<b>None yet</b>\n#end\n#end\n<u>after</u>';
    expect(diagnostics(source)).toEqual([]);
    expect(drawn(source, { tasks: [], loading: true })).toBe('<i>Loading</i><u>after</u>');
    expect(drawn(source, { tasks: [], loading: false })).toBe('<b>None yet</b><u>after</u>');
    expect(drawn(source, { tasks: ['x'], loading: false })).toBe('<p>x</p><u>after</u>');
  });

  it('an #each there is a loop', () => {
    const source = '#each (t in tasks)\n<p>{t}</p>\n#empty\n#each (hint in hints)\n<i>{hint}</i>\n#end\n#end\n<u>after</u>';
    expect(drawn(source, { tasks: [], hints: ['a', 'b'] })).toBe('<i>a</i><i>b</i><u>after</u>');
  });

  it('is in the tree as blocks, not as text', () => {
    const block = parse('#each (t in tasks)\n<p>{t}</p>\n#empty\n#if (loading)\n<i>Loading</i>\n#end\n#end').template[0] as EachBlock;
    expect(block.emptyFallback?.filter((node) => node.type !== 'Text').map((node) => node.type)).toEqual(['IfBlock']);
  });
});

describe('else written as an attribute', () => {
  it('is reported, where the element was simply always drawn', () => {
    const said = diagnostics('<p if={a}>A</p>\n<p else>B</p>');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"else" is not an attribute');
  });

  it('leaves if= as it was', () => {
    expect(diagnostics('<p if={a}>A</p>')).toEqual([]);
    expect(drawn('<p if={a}>A</p><p if={!a}>B</p>', { a: false })).toBe('<p>B</p>');
  });
});
