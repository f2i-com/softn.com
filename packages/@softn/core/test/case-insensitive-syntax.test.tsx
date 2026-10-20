/**
 * SoftN's own syntax is read in any case, as HTML's is: `#IF`, `#Else If`,
 * `#EACH (x IN xs) KEY={…}`, `<IMPORT … FROM=…>`, `<DATA><COLLECTION>`,
 * `@CLICK.PREVENT`, `:BIND`, an end tag in another case than its start tag's,
 * and a component's name in another case than it was registered under
 * (`<datatable>`). Where case still decides, it decides as HTML does: a name
 * written in lower case or all in capitals that HTML gives an element is that
 * element (`<button>`, `<BUTTON>`), and a capitalised one is a component's
 * (`<Button>`, `<Input>`, `<Link>`), never void and never lowered.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import type { EachBlock, ElementNode, IfBlock, TemplateNode } from '../src/parser/ast';
import { decodeHtmlEntities } from '../src/parser/ast';
import { ComponentRegistry, renderDocument } from '../src/renderer';
import { pageLogicSources, pageStylesheetHrefs, UI_IMPORT_PATTERN } from '../src/bundle/source-composer';
import type { SoftNProps, SoftNRenderContext } from '../src/types';

const elements = (nodes: TemplateNode[]): ElementNode[] => nodes.filter((n): n is ElementNode => n.type === 'Element');
const first = (source: string): ElementNode => elements(parse(source).template)[0];
const quiet = (source: string) => {
  const doc = parse(source);
  expect(doc.diagnostics ?? []).toEqual([]);
  return doc;
};

describe('control flow in any case', () => {
  it('reads #IF, #ELSE and #END', () => {
    const block = quiet('#IF (x)\n<p>a</p>\n#ELSE\n<p>b</p>\n#END').template[0] as IfBlock;
    expect(block.type).toBe('IfBlock');
    expect(elements(block.consequent)[0].tag).toBe('p');
    expect(elements(block.alternate as TemplateNode[])[0].tag).toBe('p');
  });

  it('reads #If, #Else If and #ElseIf as one chain', () => {
    const block = quiet('#If (a)\n<p>1</p>\n#Else If (b)\n<p>2</p>\n#ElseIf (c)\n<p>3</p>\n#End').template[0] as IfBlock;
    const second = block.alternate as IfBlock;
    expect(second.type).toBe('IfBlock');
    expect((second.alternate as IfBlock).type).toBe('IfBlock');
  });

  it('reads #EACH with IN, KEY= and #EMPTY', () => {
    const loop = quiet('#EACH (item IN items) KEY={item.id}\n<p>{item.name}</p>\n#EMPTY\n<p>none</p>\n#END').template[0] as EachBlock;
    expect(loop).toMatchObject({ type: 'EachBlock', itemName: 'item', keyExpression: { type: 'MemberExpression' } });
    expect(loop.emptyFallback?.length).toBeGreaterThan(0);
  });

  it('keeps JavaScript case inside expressions', () => {
    const block = quiet('#if (If && End)\n<p>x</p>\n#end').template[0] as IfBlock;
    expect(block.condition).toMatchObject({ left: { type: 'Identifier', name: 'If' }, right: { name: 'End' } });
  });
});

describe('blocks in any case', () => {
  it('reads <IMPORT … FROM=…> and <Import … from=…>', () => {
    expect(quiet('<IMPORT Header FROM="./h.ui" /><Header />').imports).toMatchObject([{ defaultImport: 'Header', source: './h.ui' }]);
    expect(quiet('<Import { Row AS R } from="./r.ui" />').imports).toMatchObject([{ namedImports: ['R'] }]);
  });

  it('reads <DATA> and <COLLECTION NAME AS>', () => {
    expect(quiet('<DATA><COLLECTION NAME="tasks" AS="tasks" /></DATA><p>x</p>').data?.collections).toMatchObject([{ name: 'tasks', as: 'tasks' }]);
  });

  it('reads <LOGIC>, <SCRIPT> and <STYLE>', () => {
    const doc = quiet('<LOGIC>let a = 1</LOGIC><STYLE>p { margin: 0 }</STYLE><p>x</p>');
    expect(doc.logic?.code).toBe('let a = 1');
    expect(doc.style?.content).toBe('p { margin: 0 }');
  });
});

describe('names in any case', () => {
  it('lowers an HTML element written in capitals, and its attributes', () => {
    const div = first('<DIV CLASS="x" ID=main TabIndex=0 DATA-ID=7>hi</DIV>');
    expect(div.tag).toBe('div');
    expect(div.props.map((p) => p.name)).toEqual(['class', 'id', 'tabindex', 'data-id']);
  });

  it('ends a void element written in capitals with its tag', () => {
    const p = first('<P>a<BR>b<IMG SRC=a.png>c</P>');
    expect(p.children.map((c) => (c.type === 'Element' ? c.tag : c.type === 'Text' ? c.content : ''))).toEqual(['a', 'br', 'b', 'img', 'c']);
  });

  it('keeps a capitalised name as a component, never void', () => {
    expect(quiet('<Input placeholder="x"></Input><Link to="/">Home</Link>').template.map((n) => (n as ElementNode).tag)).toEqual(['Input', 'Link']);
    expect(first('<Link to="/">Home</Link>').children).toHaveLength(1);
  });

  it('keeps names it does not know as written', () => {
    expect(first('<FAQ />').tag).toBe('FAQ');
    expect(first('<svg viewBox="0 0 1 1"><linearGradient id="g" /></svg>').props[0].name).toBe('viewBox');
    expect(first('<div className="a" htmlFor="b">x</div>').props.map((p) => p.name)).toEqual(['className', 'htmlFor']);
  });

  it('closes a tag with its end tag in any case', () => {
    expect(quiet('<Button>Save</button><div>x</DIV>').template).toHaveLength(2);
  });

  it('reads events, modifiers and bindings in any case', () => {
    const button = first('<Button @CLICK={go} @Submit.PREVENT={go} :BIND={x} @rowClick={go}>x</Button>');
    expect(button.events.map((e) => [e.name, e.modifiers ?? []])).toEqual([['click', []], ['submit', ['prevent']], ['rowClick', []]]);
    expect(button.bindings.map((b) => b.name)).toEqual(['bind']);
    expect(first('<input @KeyDown={go} :Value={v}>').events[0].name).toBe('keydown');
  });

  it('reads onclick, ONCLICK and onClick on an HTML element as its click event', () => {
    for (const source of ['<button onclick="go()">x</button>', '<button ONCLICK="go()">x</button>', '<button onClick={go}>x</button>']) {
      const button = first(source);
      expect(button.events.map((e) => e.name)).toEqual(['click']);
      expect(button.props).toEqual([]);
    }
  });

  it('keeps the names of a component written in lower case, and its mistakes errors', () => {
    // Lower case is not HTML's by itself: <datatable> is DataTable's, and its
    // props, events and bindings are spelt as the component spells them.
    const table = first('<datatable onRowClick={pick} @rowSelect={pick} :selectedKey={key} Title="t" />');
    expect(table.props.map((p) => p.name)).toEqual(['onRowClick', 'Title']);
    expect(table.events.map((e) => e.name)).toEqual(['rowSelect']);
    expect(table.bindings.map((b) => b.name)).toEqual(['selectedKey']);
    expect(parse('<stack><p>x</p>').diagnostics).toMatchObject([{ severity: 'error', message: 'Unclosed tag: <stack>' }]);
    expect(parse('<div><p>x</div>').diagnostics ?? []).toEqual([]);
    expect(parse('<div><span>x').diagnostics).toMatchObject([{ severity: 'warning' }]);
  });

  it('reads a handler on a shape in a drawing as its event', () => {
    const svg = first('<svg><circle onclick="go()" r=1 /><path onClick={go} d="M0 0" /></svg>');
    expect(elements(svg.children).map((shape) => shape.events.map((e) => e.name))).toEqual([['click'], ['click']]);
  });

  it('keeps an HTML attribute written twice as its first', () => {
    expect(first('<div id=a ID=b>x</div>').props).toMatchObject([{ name: 'id', value: { value: 'a' } }]);
  });
});

describe('values as HTML writes them', () => {
  const value = (source: string, name: string) => first(source).props.find((p) => p.name === name)?.value;

  it('reads unquoted values whole', () => {
    expect(value('<img src=images/a.png alt=x>', 'src')).toEqual({ type: 'static', value: 'images/a.png' });
    expect(value('<a href=/docs/ x>y</a>', 'href')).toEqual({ type: 'static', value: '/docs/' });
    expect(value('<a href=//cdn.example.com/x>y</a>', 'href')).toEqual({ type: 'static', value: '//cdn.example.com/x' });
    expect(value('<input type=datetime-local>', 'type')).toEqual({ type: 'static', value: 'datetime-local' });
    expect(value('<font color=#fff>c</font>', 'color')).toEqual({ type: 'static', value: '#fff' });
    expect(value('<a href=?a=1&amp;b=2>q</a>', 'href')).toEqual({ type: 'static', value: '?a=1&b=2' });
  });

  it('keeps a number, a boolean and a word as they were', () => {
    const grid = first('<Grid columns=2 open=true variant=primary gap=1.5 />');
    expect(grid.props.map((p) => p.value)).toEqual([
      { type: 'number', value: 2 },
      { type: 'boolean', value: true },
      { type: 'static', value: 'primary' },
      { type: 'number', value: 1.5 },
    ]);
  });

  it('ends a tag at />, even after an unquoted value', () => {
    const doc = quiet('<img src=a.png/><p>after</p>');
    expect(doc.template.map((n) => (n as ElementNode).tag).filter(Boolean)).toEqual(['img', 'p']);
    expect(value('<a href=/>root</a>', 'href')).toEqual({ type: 'static', value: '/' });
  });

  it('reads a quoted handler written without quotes', () => {
    expect(first('<button @click=save()>s</button>').events[0]).toMatchObject({ name: 'click', quoted: true });
  });

  it('reads a textarea and a title as text, with braces still expressions', () => {
    const area = first('<textarea>Dear {name}, a < b <i>x</i></textarea>');
    expect(area.children.map((c) => c.type)).toEqual(['Text', 'Expression', 'Text']);
    expect((area.children[2] as { content: string }).content).toBe(', a < b <i>x</i>');
    expect(parse('<title>A <b> &amp; B</title>').title).toBe('A <b> & B');
  });

  it('reads CDATA as its text', () => {
    const text = first('<svg><text><![CDATA[a & b < c]]></text></svg>').children[0] as ElementNode;
    expect(text.children).toMatchObject([{ type: 'Text', content: 'a & b < c' }]);
  });

  it('gives Text its own as=, and an inline loop its variable', () => {
    expect(first('<Text as="h2">Hi</Text>').props).toMatchObject([{ name: 'as', value: { value: 'h2' } }]);
    const looped = first('<Box each={xs} as="x, i">{x}</Box>');
    expect(looped.inlineEach).toMatchObject({ itemName: 'x', indexName: 'i' });
    expect(looped.props).toEqual([]);
  });
});

describe('character references', () => {
  it('reads the names HTML reads without a semicolon, in text', () => {
    expect(decodeHtmlEntities('&amp &copy 2026 &notit; AT&T &COPY; &#169 &#xA9')).toBe('& © 2026 ¬it; AT&T © © ©');
  });

  it('leaves a name followed by a letter, a digit or = as written in an attribute', () => {
    expect(decodeHtmlEntities('?a=1&copy=2&amp;b=3&notit', true)).toBe('?a=1&copy=2&b=3&notit');
    expect(decodeHtmlEntities('&copy 2026', true)).toBe('© 2026');
  });

  it("reads HTML5's other names from the browser's own table", () => {
    // jsdom's table is parse5's, the whole of HTML's.
    expect(decodeHtmlEntities('&check; &lbrace; &nosuchname;')).toBe('✓ { &nosuchname;');
  });
});

describe('components named in another case', () => {
  const registry = (): ComponentRegistry => {
    const r = new ComponentRegistry();
    r.register('DataTable', () => React.createElement('table', { className: 'data-table' }));
    r.register('Stack', ({ children }: SoftNProps) => React.createElement('div', { className: 'stack' }, children as React.ReactNode));
    r.register('Button', ({ children }: SoftNProps) => React.createElement('button', { className: 'softn-button' }, children as React.ReactNode));
    r.register('Text', ({ children }: SoftNProps) => React.createElement('span', { className: 'text' }, children as React.ReactNode));
    return r;
  };
  const context = {
    state: {}, setState: () => {}, data: {}, props: {}, functions: {}, asyncFunctions: {}, computed: {},
  } as unknown as SoftNRenderContext;
  const draw = (source: string, r = registry()) =>
    renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(parse(source), context, r)));

  it('resolves a name to the component it spells', () => {
    const r = registry();
    expect(r.resolveName('datatable')).toBe('DataTable');
    expect(r.resolveName('STACK')).toBe('Stack');
    expect(r.resolveName('DataTable')).toBe('DataTable');
    expect(r.resolveName('nothing')).toBeUndefined();
  });

  it('leaves an HTML or SVG element written as one to the page', () => {
    const r = registry();
    expect(r.resolveName('button')).toBeUndefined();
    expect(r.resolveName('BUTTON')).toBeUndefined();
    expect(r.resolveName('text')).toBeUndefined();
  });

  it('draws them', () => {
    expect(draw('<stack><datatable /></stack><button>b</button><Button>B</Button>')).toBe(
      '<div class="stack"><table class="data-table"></table></div><button>b</button><button class="softn-button">B</button>'
    );
    expect(draw('<svg><text>t</text></svg>')).toBe('<svg><text>t</text></svg>');
  });

  it('resolves two names that differ only in case the same way every time', () => {
    const r = new ComponentRegistry();
    r.register('Chart', () => null);
    r.register('CHART', () => null);
    expect(r.resolveName('chart')).toBe('CHART');
  });
});

describe('what the composer reads', () => {
  it('reads <IMPORT … FROM=…> in any case', () => {
    expect(UI_IMPORT_PATTERN.exec('<IMPORT Header FROM="./h.ui" />')?.slice(1)).toEqual(['Header', './h.ui']);
  });

  it('reads <LINK> and unquoted values', () => {
    expect(pageStylesheetHrefs('<LINK REL=stylesheet HREF=styles/app.css><link rel="stylesheet" href="b.css">')).toEqual(['styles/app.css', 'b.css']);
    expect(pageLogicSources('<script src=main.js></script><SCRIPT SRC=more.js></SCRIPT>')).toEqual(['main.js', 'more.js']);
  });
});
