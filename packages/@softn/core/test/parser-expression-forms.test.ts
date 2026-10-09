/**
 * The expression forms a JavaScript author writes first, and what the parser
 * makes of them.
 *
 * Each of these was either refused or, worse, read as something else with
 * nothing said: `count++` parsed as `count + +undefined`, `2 ** 8` as
 * `2 * undefined * 8`, a comment in braces as divisions of nothing, and
 * `#else if (b)` as the text "if (b)" inside the else branch. A variable
 * called `data`, `style`, `from` or `end` could not be read at all, because
 * markup gives those words a meaning the lexer applied everywhere.
 *
 * What the renderer does with the nodes is in
 * renderer-expression-forms.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import { parse, tokenize, PARSER_VERSION, TokenType } from '../src/parser';
import type { ElementNode, Expression, IfBlock, EachBlock } from '../src/parser';

/** Every `loc` removed, so a tree can be compared by shape. */
function shape<T>(node: T): T {
  return JSON.parse(JSON.stringify(node, (key, value) => (key === 'loc' ? undefined : value)));
}

function diagnostics(source: string): string[] {
  return (parse(source).diagnostics ?? []).map((d) => d.message);
}

/** The expression `source` parses to, as the value of one attribute. */
function expr(source: string): Expression {
  const doc = parse(`<Probe v={${source}} />`);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const element = doc.template[0] as ElementNode;
  expect(element.props.map((p) => p.name), source).toEqual(['v']);
  const value = element.props[0].value;
  if (value.type !== 'expression') throw new Error(`not an expression: ${source}`);
  return shape(value.value);
}

const id = (name: string) => ({ type: 'Identifier', name });
const num = (value: number, raw = String(value)) => ({ type: 'Literal', value, raw });

describe('arrow functions', () => {
  it('reads one parameter without parentheses', () => {
    expect(expr('t => t.done')).toEqual({
      type: 'ArrowFunctionExpression',
      params: ['t'],
      body: { type: 'MemberExpression', object: id('t'), property: id('done'), computed: false },
      async: false,
    });
  });

  it('reads it as an argument, which is where it is written', () => {
    expect(diagnostics('<Text>{items.filter(t => t.done).length}</Text>')).toEqual([]);
    expect(diagnostics('<Text>{items.map(x => x.name).join(", ")}</Text>')).toEqual([]);
  });

  it('nests to the right', () => {
    expect(expr('a => b => a + b')).toMatchObject({
      params: ['a'],
      body: { type: 'ArrowFunctionExpression', params: ['b'] },
    });
  });

  it('still reads the parenthesised forms as before', () => {
    expect(expr('(t) => t.done')).toMatchObject({ params: ['t'] });
    expect(expr('(a, b) => a - b')).toMatchObject({ params: ['a', 'b'] });
    expect(expr('() => save()')).toMatchObject({ params: [] });
  });
});

describe('spread', () => {
  it('in an array literal', () => {
    expect(expr('[...done, item]')).toEqual({
      type: 'ArrayExpression',
      elements: [{ type: 'SpreadElement', argument: id('done') }, id('item')],
    });
  });

  it('in the arguments of a call and of an optional call', () => {
    expect(expr('Math.max(0, ...scores)')).toMatchObject({
      type: 'CallExpression',
      arguments: [num(0), { type: 'SpreadElement', argument: id('scores') }],
    });
    expect(expr('fn?.(...args)')).toMatchObject({
      optional: true,
      arguments: [{ type: 'SpreadElement', argument: id('args') }],
    });
  });

  it('in an object literal, in source order with the written properties', () => {
    expect(expr('{ ...base, color: "red", ...over }')).toEqual({
      type: 'ObjectExpression',
      properties: [
        { type: 'SpreadElement', argument: id('base') },
        {
          type: 'ObjectProperty',
          key: 'color',
          value: { type: 'Literal', value: 'red', raw: '"red"' },
          shorthand: false,
        },
        { type: 'SpreadElement', argument: id('over') },
      ],
    });
  });

  it('is reported, not read as an attribute, when written among attributes', () => {
    // It used to become a boolean attribute called `rest`.
    const doc = parse('<Button {...rest} variant="primary">Go</Button>');
    const element = doc.template[0] as ElementNode;
    expect(element.props.map((p) => p.name)).toEqual(['variant']);
    expect(diagnostics('<Button {...rest} variant="primary">Go</Button>')).toEqual([
      expect.stringContaining('{...name} is not supported on a tag'),
    ]);
  });
});

describe('increment and decrement', () => {
  it('reads the postfix and prefix forms as updates of a name', () => {
    expect(expr('count++')).toEqual({
      type: 'UpdateExpression',
      operator: '++',
      prefix: false,
      argument: id('count'),
    });
    expect(expr('--count')).toEqual({
      type: 'UpdateExpression',
      operator: '--',
      prefix: true,
      argument: id('count'),
    });
  });

  it('reads them on a property path', () => {
    expect(expr('cart.items[i].qty++')).toMatchObject({
      type: 'UpdateExpression',
      prefix: false,
      argument: { type: 'MemberExpression' },
    });
  });

  it('is the body of the handler it is written in', () => {
    const doc = parse('<Button @click={() => count++}>Add</Button>');
    expect(doc.diagnostics ?? []).toEqual([]);
    const handler = (doc.template[0] as ElementNode).events[0].handler;
    expect(shape(handler)).toMatchObject({
      type: 'ArrowFunctionExpression',
      body: { type: 'UpdateExpression', operator: '++' },
    });
  });

  it('reports a target that is not somewhere state lives', () => {
    expect(diagnostics('<Text>{5++}</Text>')).toEqual(['Invalid "++" target: cannot change the literal 5']);
    expect(diagnostics('<Text>{--total()}</Text>')).toEqual(['Invalid "--" target: cannot change a call']);
  });

  it('leaves a spaced double sign as two signs', () => {
    expect(expr('a - -b')).toMatchObject({
      type: 'BinaryExpression',
      operator: '-',
      right: { type: 'UnaryExpression', operator: '-' },
    });
  });

  it('leaves hyphens in an attribute name alone', () => {
    const doc = parse('<div aria-label="Close" data-row-id="7">x</div>');
    expect((doc.template[0] as ElementNode).props.map((p) => p.name)).toEqual([
      'aria-label',
      'data-row-id',
    ]);
    expect(doc.diagnostics ?? []).toEqual([]);
  });
});

describe('operators', () => {
  it('reads ** tighter than * and grouping to the right', () => {
    expect(expr('2 * 3 ** 2')).toMatchObject({
      operator: '*',
      right: { operator: '**', left: num(3), right: num(2) },
    });
    expect(expr('2 ** 3 ** 2')).toMatchObject({
      operator: '**',
      left: num(2),
      right: { operator: '**', left: num(3), right: num(2) },
    });
  });

  it('accepts a sign on the exponent and a parenthesised signed base', () => {
    expect(expr('2 ** -1')).toMatchObject({ operator: '**', right: { type: 'UnaryExpression' } });
    expect(expr('(-x) ** 2')).toMatchObject({ operator: '**', left: { type: 'UnaryExpression' } });
  });

  it('asks for parentheses where the two readings of a signed base differ', () => {
    expect(diagnostics('<Text>{-x ** 2}</Text>')).toEqual([
      'Ambiguous "-" before "**": write (-x) ** y or -(x ** y)',
    ]);
  });

  it('reads **= as an assignment', () => {
    expect(expr('scale **= 2')).toMatchObject({ type: 'AssignmentExpression', operator: '**=' });
  });

  it('reads in and instanceof with the comparisons', () => {
    expect(expr('"email" in errors')).toEqual({
      type: 'BinaryExpression',
      operator: 'in',
      left: { type: 'Literal', value: 'email', raw: '"email"' },
      right: id('errors'),
    });
    expect(expr('due instanceof Date && late')).toMatchObject({
      operator: '&&',
      left: { operator: 'instanceof', left: id('due'), right: id('Date') },
    });
  });

  it('still reads the header of an #each, whose own `in` is not an operator', () => {
    const doc = parse('#each (row, i in rows)\n<Text>{row}</Text>\n#end');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template[0]).toMatchObject({ type: 'EachBlock', itemName: 'row', indexName: 'i' });
  });
});

describe('new', () => {
  it('reads a construction and the member chain on its result', () => {
    expect(expr('new Date().getFullYear()')).toEqual({
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: { type: 'NewExpression', callee: id('Date'), arguments: [] },
        property: id('getFullYear'),
        computed: false,
      },
      arguments: [],
    });
  });

  it('reads arguments, and a construction written without any', () => {
    expect(expr('new Date(task.due)')).toMatchObject({
      type: 'NewExpression',
      arguments: [{ type: 'MemberExpression' }],
    });
    expect(expr('new Date')).toEqual({ type: 'NewExpression', callee: id('Date'), arguments: [] });
  });
});

describe('literals', () => {
  it('reads undefined as the value', () => {
    expect(expr('value === undefined')).toMatchObject({ operator: '===', right: id('undefined') });
  });

  it('reads a hexadecimal number as the number it is', () => {
    expect(expr('0xff8800')).toEqual(num(0xff8800, '0xff8800'));
    expect(expr('0x1F + 1')).toMatchObject({ left: num(31, '0x1F'), right: num(1) });
  });

  it('reads a numeric object key as its string', () => {
    expect(expr('{ 1: "one", 2.50: "two and a half" }')).toMatchObject({
      properties: [{ key: '1' }, { key: '2.5' }],
    });
  });
});

describe('comments inside an expression', () => {
  it('reads a block comment as nothing, where it used to divide', () => {
    const doc = parse('<Stack>{/* the header row */}<Text>a</Text></Stack>');
    expect(doc.diagnostics ?? []).toEqual([]);
    const children = (doc.template[0] as ElementNode).children;
    // An empty interpolation, as `{}` is, then the element.
    expect(shape(children[0])).toEqual({ type: 'Expression', expression: id('undefined') });
    expect(children[1]).toMatchObject({ type: 'Element', tag: 'Text' });
  });

  it('reads past a comment in the middle of an expression', () => {
    expect(expr('total /* of the visible rows */ + 1')).toMatchObject({
      operator: '+',
      left: id('total'),
      right: num(1),
    });
    const doc = parse('<Text>{total // of the visible rows\n}</Text>');
    expect(doc.diagnostics ?? []).toEqual([]);
  });

  it('still hands the comment to a tool that lists them', () => {
    // The Builder refuses to rewrite a file whose comments it would drop.
    const comments = tokenize('<Text>{/* note */ count}</Text>').filter(
      (t) => t.type === TokenType.COMMENT
    );
    expect(comments.map((t) => t.literal)).toEqual(['note']);
  });

  it('leaves a slash-star in text as text', () => {
    const doc = parse('<Text>a /* b */ c</Text>');
    expect((doc.template[0] as ElementNode).children).toMatchObject([
      { type: 'Text', content: 'a /* b */ c' },
    ]);
  });
});

describe('names that markup also uses', () => {
  const words = [
    'data', 'style', 'slot', 'template', 'component', 'prop', 'from',
    'collection', 'script', 'logic', 'each', 'end', 'empty', 'elseif',
  ];

  it('are ordinary variables in an expression', () => {
    for (const word of words) {
      expect(expr(`${word}.title`), word).toMatchObject({ type: 'MemberExpression', object: id(word) });
      expect(expr(`format(${word})`), word).toMatchObject({ arguments: [id(word)] });
      expect(expr(`${word} => ${word}.id`), word).toMatchObject({ params: [word] });
      expect(expr(`(${word}, i) => i`), word).toMatchObject({ params: [word, 'i'] });
    }
  });

  it('are ordinary loop variables', () => {
    for (const word of words) {
      const doc = parse(`#each (${word}, i in rows)\n<Text>{${word}.name}</Text>\n#end`);
      expect(doc.diagnostics ?? [], word).toEqual([]);
      expect(doc.template[0], word).toMatchObject({ type: 'EachBlock', itemName: word, indexName: 'i' });
    }
  });

  it('can be assigned in a handler', () => {
    const doc = parse('<Button @click={() => data = rows}>Load</Button>');
    expect(doc.diagnostics ?? []).toEqual([]);
  });

  it('do not end a control-flow header they appear inside', () => {
    // `end`, `else` and `empty` close the header only as the word after `#`.
    const doc = parse('#if (end > start && !empty)\n<A />\n#else\n<B />\n#end\n<C />');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template).toHaveLength(2);
    const block = doc.template[0] as IfBlock;
    expect(shape(block.condition)).toMatchObject({ operator: '&&', left: { operator: '>', left: id('end') } });
    expect(block.consequent).toMatchObject([{ tag: 'A' }]);
    expect(block.alternate).toMatchObject([{ tag: 'B' }]);
  });

  it('keep their meaning in markup', () => {
    const doc = parse(
      '<data><collection name="tasks" as="tasks" /></data>\n' +
        '<style>.a { color: red }</style>\n' +
        '<Card><template slot="header">H</template><slot /></Card>'
    );
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.data?.collections).toHaveLength(1);
    expect(doc.style?.content).toContain('.a');
    expect((doc.template[0] as ElementNode).children.map((c) => c.type)).toEqual(['TemplateSlot', 'Slot']);
  });

  it("leaves JavaScript's own reserved words reserved", () => {
    for (const word of ['if', 'else', 'function', 'return', 'const', 'let', 'this', 'delete']) {
      expect(diagnostics(`<Text>{${word}.title}</Text>`).length, word).toBeGreaterThan(0);
    }
  });
});

describe('#else if', () => {
  const chain = (source: string): IfBlock => {
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    return doc.template[0] as IfBlock;
  };

  it('is the chain #elseif makes', () => {
    const spelled = shape(chain('#if (a)\n<A />\n#else if (b)\n<B />\n#else\n<C />\n#end'));
    const joined = shape(chain('#if (a)\n<A />\n#elseif (b)\n<B />\n#else\n<C />\n#end'));
    expect(spelled).toEqual(joined);
    expect(spelled.alternate).toMatchObject({ type: 'IfBlock', condition: id('b') });
  });

  it('chains as far as it is written, with or without a space before the parenthesis', () => {
    const block = chain('#if (a)\n<A />\n#else if (b)\n<B />\n#else if(c)\n<C />\n#else\n<D />\n#end\n');
    const second = block.alternate as IfBlock;
    const third = second.alternate as IfBlock;
    expect(shape(third.condition)).toEqual(id('c'));
    expect(third.alternate).toMatchObject([{ tag: 'D' }]);
  });

  it('ends at its own #end and leaves what follows alone', () => {
    const doc = parse('#if (a)\n<A />\n#else if (b)\n<B />\n#end\n<After />');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template.map((n) => n.type)).toEqual(['IfBlock', 'Element']);
  });

  it('leaves an else branch that merely begins with the word alone', () => {
    // On the next line, or without a parenthesis, it is the branch's text.
    const block = chain('#if (a)\n<A />\n#else\nif (b) then\n#end');
    expect(block.alternate).toMatchObject([{ type: 'Text', content: 'if (b) then ' }]);
    const prose = chain('#if (a)\n<A />\n#else if you like\n#end');
    expect(prose.alternate).toMatchObject([{ type: 'Text', content: 'if you like ' }]);
  });
});

describe('event modifiers', () => {
  const events = (source: string) => (parse(source).template[0] as ElementNode).events.map(shape);

  it('reads the words after the event name, in order', () => {
    expect(events('<form @submit.prevent={save}></form>')).toEqual([
      { type: 'Event', name: 'submit', handler: id('save'), modifiers: ['prevent'] },
    ]);
    expect(events('<Input @keydown.ctrl.enter={send} />')[0]).toMatchObject({
      name: 'keydown',
      modifiers: ['ctrl', 'enter'],
    });
    expect(events('<Box @click.stop.self={close} />')[0].modifiers).toEqual(['stop', 'self']);
  });

  it('reads a modifier that is also a keyword', () => {
    expect(events('<Input @keydown.delete={remove} />')[0].modifiers).toEqual(['delete']);
    expect(diagnostics('<Input @keydown.delete={remove} />')).toEqual([]);
  });

  it('leaves an event without modifiers the shape it always had', () => {
    const [event] = events('<Button @click={go}>x</Button>');
    expect(event).toEqual({ type: 'Event', name: 'click', handler: id('go') });
    expect('modifiers' in event).toBe(false);
  });

  it('reports a word it does not know and keeps the handler', () => {
    const source = '<Input @keydown.entr={send} />';
    expect(diagnostics(source)).toEqual([expect.stringContaining('Unknown event modifier ".entr" on @keydown')]);
    expect(events(source)[0]).toMatchObject({ name: 'keydown', handler: id('send'), modifiers: ['entr'] });
  });
});

describe('class: and style: names', () => {
  const names = (source: string) => {
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    return (doc.template[0] as ElementNode).props.map((p) => p.name);
  };

  it('reads the whole name after the colon, hyphens and digits included', () => {
    // `class:is-active={on}` was the class "is" and an attribute `active`.
    expect(names('<div class:is-active={on} class:mt-2={tight} class:col-2xl={wide}>x</div>')).toEqual([
      'class:is-active',
      'class:mt-2',
      'class:col-2xl',
    ]);
  });

  it('reads a CSS property and a custom property', () => {
    expect(names('<div style:font-size={size} style:--accent={colour} style:color="red">x</div>')).toEqual([
      'style:font-size',
      'style:--accent',
      'style:color',
    ]);
  });

  it('still reads a separated colon as a binding', () => {
    const doc = parse('<Input disabled :bind={name} />');
    const element = doc.template[0] as ElementNode;
    expect(element.props.map((p) => p.name)).toEqual(['disabled']);
    expect(element.bindings.map((b) => b.name)).toEqual(['bind']);
  });
});

describe('an operator with nothing on its left', () => {
  it('is reported, where it used to compute with a stand-in', () => {
    // `{/a+/.test(s)}` parsed as divisions of `undefined` and rendered NaN.
    expect(diagnostics('<Text>{/a+/.test(s)}</Text>')).toEqual([
      expect.stringContaining('a regular expression literal is not supported in a template'),
    ]);
    expect(diagnostics('<Text>{* 2}</Text>')).toEqual([
      'Unexpected "*" where a value was expected: nothing is on its left',
    ]);
  });

  it('is reported once for the expression it is in', () => {
    expect(diagnostics('<Text>{/ a / b}</Text>')).toHaveLength(1);
    // And again for the next expression that has one.
    expect(diagnostics('<Text>{* 2}</Text><Text>{% 3}</Text>')).toHaveLength(2);
    expect(diagnostics('#if (&& ready)\n<A />\n#end\n<Text>{* 2}</Text>')).toHaveLength(2);
  });

  it('leaves an empty expression empty', () => {
    expect(diagnostics('<Text>{}</Text>')).toEqual([]);
    expect(diagnostics('<Text>{fn()}</Text>')).toEqual([]);
    expect(diagnostics('<Text v={[]} w={{}} x={() => undefined} />')).toEqual([]);
    expect(diagnostics('<Text>{`${a}`}</Text>')).toEqual([]);
  });

  it('leaves a trailing comma alone, in a list, an object and a call', () => {
    expect(diagnostics('<Text v={[1, 2, ]} w={{ a: 1, }} x={fn(a, )} />')).toEqual([]);
  });
});

describe('an operator with nothing on its right', () => {
  it('is reported, where it used to compute with a stand-in', () => {
    // `{total + }` rendered "NaN", or "5undefined" for text.
    expect(diagnostics('<Text>{total + }</Text>')).toEqual([
      'Nothing follows "+": a value was expected before "}"',
    ]);
    expect(diagnostics('<Text>{a && }</Text>')).toEqual(['Nothing follows "&&": a value was expected before "}"']);
    expect(diagnostics('<Text>{!}</Text>')).toEqual(['Nothing follows "!": a value was expected before "}"']);
    expect(diagnostics('<Text>{max(a, -)}</Text>')).toEqual(['Nothing follows "-": a value was expected before ")"']);
  });

  it('is reported for each side of a conditional and for an assignment', () => {
    expect(diagnostics('<Text>{ok ? : "no"}</Text>')).toEqual(['Nothing follows "?": a value was expected before ":"']);
    expect(diagnostics('<Text>{ok ? "yes" : }</Text>')).toEqual(['Nothing follows ":": a value was expected before "}"']);
    expect(diagnostics('<Button @click={() => count = }>x</Button>')).toEqual([
      'Nothing follows "=": a value was expected before "}"',
    ]);
  });

  it('is reported for an arrow with no body, a spread of nothing and an object value left out', () => {
    expect(diagnostics('<Button @click={() => }>x</Button>')).toEqual(['Nothing follows "=>": a value was expected before "}"']);
    expect(diagnostics('<Text v={[...]} />')).toEqual(['Nothing follows "...": a value was expected before "]"']);
    expect(diagnostics('<Text v={{ a: }} />')).toEqual(['Nothing follows ":": a value was expected before "}"']);
  });

  it('is reported for a member access that names nothing', () => {
    expect(diagnostics('<Text>{user.}</Text>')).toEqual(['Nothing follows ".": a value was expected before "}"']);
    expect(diagnostics('<Text>{user?.}</Text>')).toEqual(['Nothing follows "?.": a value was expected before "}"']);
  });

  it('is reported in a control-flow header', () => {
    expect(diagnostics('#if (count > )\n<A />\n#end')).toEqual(['Nothing follows ">": a value was expected before ")"']);
    expect(diagnostics('#each (row in )\n<A />\n#end')).toEqual(['Nothing follows "in": a value was expected before ")"']);
  });

  it('is one diagnostic for the expression, and still keeps what was read', () => {
    const doc = parse('<Text>{a + * }</Text><Text>after</Text>');
    expect(doc.diagnostics).toHaveLength(1);
    expect(doc.template).toHaveLength(2);
  });

  it('is not what an unclosed brace is about', () => {
    // The rest of the file reads as a comparison ending in `</Text>`; the
    // missing brace is the unclosed tag's diagnostic to make.
    expect(diagnostics('<Text>{count</Text><Text>after</Text>')).toEqual(['Unclosed tag: <Text>']);
  });
});

describe('the parser version', () => {
  it('moved with what parse returns', () => {
    // parseCached keys on it; a document parsed under the old rules must not
    // be served to a renderer written for these.
    expect(PARSER_VERSION).toBe(5);
  });
});

describe('each block item names', () => {
  it('keeps the key expression after a header with a contextual name', () => {
    const doc = parse('#each (slot in slots) key={slot.id}\n<Text>{slot.name}</Text>\n#end');
    expect(doc.diagnostics ?? []).toEqual([]);
    const block = doc.template[0] as EachBlock;
    expect(block.itemName).toBe('slot');
    expect(shape(block.keyExpression)).toMatchObject({ type: 'MemberExpression', object: id('slot') });
  });
});
