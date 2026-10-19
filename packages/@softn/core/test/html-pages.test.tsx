/**
 * A page written as an HTML page is written.
 *
 * Most people, and every model, learned to write a page as HTML: a doctype,
 * `<html>`, `<head>` and `<body>`; `<br>` and `<img …>` with no `/>`;
 * `onclick="save()"`; an SVG icon; `<script src="main.js">` and
 * `<link rel="stylesheet">`. Each of these broke a page here, most of them
 * without a word: a void tag swallowed the rest of its parent, an icon drew
 * "Unknown component" for each of its paths, a handler was dropped. These
 * tests hold the HTML reading, beside SoftN's own components and syntax,
 * which a page can mix with it freely.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { renderToStaticMarkup } from 'react-dom/server';
import { composeBundleSource } from '../src/bundle/source-composer';
import { parse } from '../src/parser';
import type { ElementNode, SoftNDocument, TemplateNode } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNProps, SoftNRenderContext } from '../src/types';

function context(overrides: Partial<SoftNRenderContext> = {}): SoftNRenderContext {
  return {
    state: {},
    setState: () => {},
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
    ...overrides,
  };
}

function registry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register('Button', ({ children, onClick }: SoftNProps) =>
    React.createElement('button', { className: 'softn-button', onClick: onClick as () => void }, children as React.ReactNode)
  );
  return r;
}

/** A page that parses without a word, drawn as static markup. */
function html(source: string, overrides: Partial<SoftNRenderContext> = {}): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  return renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderDocument(doc, context(overrides), registry()))
  );
}

const messages = (source: string) => (parse(source).diagnostics ?? []).map((d) => `${d.severity}: ${d.message}`);

const tags = (nodes: TemplateNode[]): string[] =>
  nodes.flatMap((node) => (node.type === 'Element' ? [node.tag, ...tags(node.children)] : []));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(source: string, overrides: Partial<SoftNRenderContext> = {}): HTMLDivElement {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(React.createElement(React.Fragment, null, renderDocument(doc, context(overrides), registry()))));
  return container;
}

const WHOLE_DOCUMENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reading list</title>
  <link rel="icon" href="icon.svg">
  <style>h1 { color: teal; }</style>
  <script src="main.js"></script>
</head>
<body>
  <h1>Books</h1>
  <p>Read <b>{count}</b> of 10</p>
  <Button>Add</Button>
</body>
</html>`;

describe('a page written as a whole HTML document', () => {
  it('is its body, with the head read for its title, style and code', () => {
    const doc = parse(WHOLE_DOCUMENT);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.title).toBe('Reading list');
    expect(doc.style?.content).toBe('h1 { color: teal; }');
    // `<script src>` is a file of the app's, which the bundle composer places.
    expect(doc.script).toBeUndefined();
    expect(tags(doc.template)).toEqual(['h1', 'p', 'b', 'Button']);
    expect(html(WHOLE_DOCUMENT, { state: { count: 3 } })).toBe(
      '<h1>Books</h1><p>Read <b>3</b> of 10</p><button class="softn-button">Add</button>'
    );
  });

  it('keeps the attributes of a body that has them, on a div', () => {
    const doc = parse('<html><body class="page" style="margin: 0"><p>x</p></body></html>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template).toHaveLength(1);
    const body = doc.template[0] as ElementNode;
    expect(body.tag).toBe('div');
    expect(body.props.map((prop) => prop.name)).toEqual(['class', 'style']);
    expect(tags(body.children)).toEqual(['p']);
  });

  it('reads a title, meta or link at the top of a page without a head as the head would', () => {
    const doc = parse('<title>Notes</title><meta charset="utf-8"><div>x</div>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.title).toBe('Notes');
    expect(tags(doc.template)).toEqual(['div']);
  });
});

describe('void elements', () => {
  it('end with their tags, with or without a slash', () => {
    expect(html('<div>a<br>b<hr><img src="x.png" alt="x"><input type="text" name="q"><p>c</p></div>')).toBe(
      '<div>a<br/>b<hr/><img src="x.png" alt="x"/><input type="text" name="q"/><p>c</p></div>'
    );
    expect(html('<p>one<br/>two<br />three</p>')).toBe('<p>one<br/>two<br/>three</p>');
  });

  it('pass over the closing tags pages wrote while they needed one', () => {
    expect(html('<div>a<br></br>b<input type="text"></input><p>c</p></div>')).toBe(
      '<div>a<br/>b<input type="text"/><p>c</p></div>'
    );
  });

  it('are the lower-case HTML elements only: a component of the same name has children', () => {
    const r = registry();
    r.register('Link', ({ children }: SoftNProps) => React.createElement('a', null, children as React.ReactNode));
    const doc = parse('<Link to="/">Home</Link><p>after</p>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context(), r)))).toBe(
      '<a>Home</a><p>after</p>'
    );
  });
});

describe('names HTML spells its own way', () => {
  it('reads a custom element name as one tag', () => {
    const doc = parse('<div><my-card some-attr="1">x</my-card><p>after</p></div>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(tags(doc.template)).toEqual(['div', 'my-card', 'p']);
  });

  it('reads <Logic>, <Script> and <Style> as the blocks the lexer always took them for', () => {
    const doc = parse('<Logic>let x = 1</Logic><Style>p { margin: 0 }</Style><p>{x}</p>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.logic?.code).toBe('let x = 1');
    expect(doc.style?.content).toBe('p { margin: 0 }');
    expect(tags(doc.template)).toEqual(['p']);
  });

  it('gives React its names for HTML attributes', () => {
    expect(
      html('<label for="n">Name</label><input id="n" readonly maxlength="5" tabindex="0" value="Ada"><table><tr><td colspan="2"></td></tr></table>')
    ).toBe(
      '<label for="n">Name</label><input id="n" readonly="" maxLength="5" tabindex="0" value="Ada"/><table><tr><td colSpan="2"></td></tr></table>'
    );
  });
});

describe('named characters', () => {
  it('are HTML 4’s, beside the ones pages here already used', () => {
    expect(html('<p>&euro;5 &eacute;t&eacute; &rsaquo; &frac12; &alpha; &check; &copy;</p>')).toBe('<p>€5 été › ½ α ✓ ©</p>');
  });

  it('leave a name HTML does not have as written, an object’s own members included', () => {
    expect(html('<p>&nosuch; &constructor; &toString;</p>')).toBe('<p>&amp;nosuch; &amp;constructor; &amp;toString;</p>');
  });
});

describe('blocks written inside the page', () => {
  it('are the page’s, wherever they stand', () => {
    const doc = parse('<div><p>{x}</p><style>p { color: red }</style><script>let x = 2</script></div>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.script?.code).toBe('let x = 2');
    expect(doc.style?.content).toBe('p { color: red }');
    expect(tags(doc.template)).toEqual(['div', 'p']);
  });

  it('pass over a script that is data, and say a script from another site is not loaded', () => {
    expect(parse('<script type="application/ld+json">{"@type": "Book"}</script><p>x</p>').script).toBeUndefined();
    expect(messages('<script src="https://cdn.example.com/x.js"></script><p>x</p>')).toEqual([
      'warning: <script src="https://cdn.example.com/x.js"> is not loaded: an app\'s code runs in its own sandbox, ' +
        "from the app's own files, so a script from another site cannot run beside it. Put the code the page needs in a file of the app",
    ]);
    expect(messages('<head><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><p>x</p>')).toEqual([
      'warning: <link rel="stylesheet" href="https://cdn.example.com/x.css"> is not loaded: an app\'s styles come from ' +
        "the app's own files. Put the rules the page needs in a .css file of the app, or in a <style> block",
    ]);
  });

  it('refuse Python written inside the page', () => {
    expect(messages('<script type="text/python">x = 1</script>')).toEqual([
      'error: Python is not written inside a page, where its indentation is not safe: put it in a .py file and refer to it with <script src="main.py">',
    ]);
  });
});

describe('text that keeps its whitespace', () => {
  it('is the text of a <pre>, as written, less the line break after the tag', () => {
    expect(html('<pre>\n  a\n   b</pre><p>  c\n  d</p>')).toBe('<pre>  a\n   b</pre><p>c d</p>');
    expect(html('<pre><code>if (a) {"{"}\n  go()\n}</code></pre>')).toBe('<pre><code>if (a) {\n  go()\n}</code></pre>');
  });

  it('is the text a <textarea> starts with', () => {
    expect(html('<textarea rows="3">Dear {name},\n  thanks</textarea>', { state: { name: 'Ada' } })).toBe(
      '<textarea rows="3">Dear Ada,\n  thanks</textarea>'
    );
  });
});

describe('a field given a starting value', () => {
  it('starts with it and can be changed, as in HTML', () => {
    const page = mount('<input id="f" value="Ada"><input id="c" type="checkbox" checked>');
    const field = page.querySelector<HTMLInputElement>('#f')!;
    const box = page.querySelector<HTMLInputElement>('#c')!;
    expect(field.value).toBe('Ada');
    expect(box.checked).toBe(true);
    act(() => {
      field.value = 'Grace';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      box.click();
    });
    expect(field.value).toBe('Grace');
    expect(box.checked).toBe(false);
  });

  it('is left to the page when the page keeps it in step', () => {
    const doc = parse('<input :bind={name}>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(html('<input :bind={name}>', { state: { name: 'Ada' } })).toBe('<input value="Ada"/>');
  });
});

describe('a handler written as HTML writes one', () => {
  it('runs its code when the event fires, with return false as preventDefault', () => {
    const save = vi.fn();
    const page = mount('<button id="b" onclick="save(1); save(2)">Go</button><a id="a" href="#x" onclick="save(3); return false">x</a>', {
      functions: { save },
    });
    act(() => page.querySelector<HTMLButtonElement>('#b')!.click());
    expect(save.mock.calls).toEqual([[1], [2]]);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      page.querySelector<HTMLAnchorElement>('#a')!.dispatchEvent(click);
    });
    expect(save.mock.calls.at(-1)).toEqual([3]);
    expect(click.defaultPrevented).toBe(true);
  });

  it('is a property like any other on a component, where on* is not HTML', () => {
    const doc = parse('<Card onSave="later" />');
    const card = doc.template[0] as ElementNode;
    expect(card.events).toEqual([]);
    expect(card.props.map((prop) => prop.name)).toEqual(['onSave']);
  });

  it('is a warning, and no handler, when it is code a page cannot run', () => {
    const doc = parse('<button onclick="if (a) save()">Go</button>');
    expect((doc.template[0] as ElementNode).events).toEqual([]);
    expect(doc.diagnostics?.map((d) => d.severity)).toEqual(['warning']);
  });
});

describe('an SVG icon', () => {
  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>' +
    '<clipPath id="c"><rect width="24" height="24"/></clipPath></defs>' +
    '<g clip-path="url(#c)"><path d="M5 12h14"/><circle cx="12" cy="12" r="10" fill="url(#g)"></circle>' +
    '<polyline points="1,2 3,4"/></g></svg>';

  it('draws its shapes, by the names SVG gives them', () => {
    const out = html(ICON);
    expect(out).not.toContain('Unknown component');
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('<clipPath id="c">');
    expect(out).toContain('<path d="M5 12h14"></path>');
    expect(out).toContain('fill="url(#g)"');
  });

  it('loads nothing from outside the app that the app may not load', () => {
    const pending = { consentPending: true };
    const out = html(
      '<svg><use href="#icon"/><use href="https://attacker.example/sprite.svg#icon"/>' +
        '<rect fill="url(https://attacker.example/p.svg#paint)" stroke="url(#ok)"/></svg>',
      pending
    );
    expect(out).toBe('<svg><use href="#icon"></use><use></use><rect stroke="url(#ok)"></rect></svg>');
  });
});

describe('a bundle written as HTML files', () => {
  const compose = (files: Record<string, string>, main = 'index.html') =>
    composeBundleSource(new Map(Object.entries(files)), main);
  const parsed = (files: Record<string, string>, main?: string): SoftNDocument => {
    const doc = parse(compose(files, main).source);
    expect(doc.diagnostics ?? []).toEqual([]);
    return doc;
  };

  it('takes its code from <script src>, in .js, as from <logic src>', () => {
    const doc = parsed({
      'index.html': '<html><head><script src="js/main.js"></script></head><body><p>{count}</p></body></html>',
      'js/main.js': 'let count = 1\nimport "./helpers.js"',
      'js/helpers.js': 'function twice(n) { return n * 2 }',
    });
    expect(doc.logic?.code).toBe('let count = 1\nimport "js/helpers.js"');
    expect(tags(doc.template)).toEqual(['p']);
  });

  it('runs a page’s inline <script> beside the code of the pages it imports', () => {
    const doc = parsed({
      'index.html': '<import Header from="./header.html" /><script>let title = "Books"</script><Header /><p>{count}</p>',
      'header.html': '<script src="header.js"></script><h1>{title}</h1>',
      'header.js': 'let count = 2',
    });
    expect(doc.script).toBeUndefined();
    expect(doc.logic?.code).toBe('let count = 2\nlet title = "Books"');
    expect(tags(doc.template)).toEqual(['h1', 'p']);
  });

  it('takes Python from <script src="main.py">', () => {
    const composed = compose({
      'index.html': '<script src="main.py"></script><p>{count}</p>',
      'main.py': 'count = 1\n',
    });
    expect(composed.python?.modules).toEqual(['main']);
  });

  it('leaves a script from another site, or one that is data, to the parser', () => {
    const source = compose({
      'index.html': '<script src="https://cdn.example.com/x.js"></script><script type="application/json">{}</script><p>x</p>',
    }).source;
    expect(source).toContain('<script src="https://cdn.example.com/x.js"></script>');
    expect(source).toContain('<script type="application/json">{}</script>');
  });

  it('places the rules of a stylesheet the page links to', () => {
    const doc = parsed({
      'index.html': '<head><link rel="stylesheet" href="css/site.css"></head><p>x</p>',
      'css/site.css': 'p { color: teal; }',
    });
    expect(doc.style?.content).toBe('p { color: teal; }');
  });
});
