/**
 * Mistakes an author or an AI makes in markup, and what the page says.
 *
 * Each of these used to draw a page that was wrong with nothing to say why,
 * or to say something about a different line of it:
 *
 * - A `<` in words, `1 < 2` or `I <3 it`, was read as the start of a tag. The
 *   rest of the paragraph became an element named "" and the page drew
 *   "Unknown component: <>", under a diagnostic about spreading attributes.
 *   HTML reads a `<` that cannot begin a tag as text, and so does this now.
 * - `@click="save()"`, a handler written as a quoted string the way other
 *   frameworks spell it, gave the button no handler and no diagnostic.
 * - `@click={() => { save() }}`, an arrow with a block body: its braces were
 *   read as a record, so `{ save() }` called the record `{ save }` and the
 *   button did nothing, with no diagnostic, and `{ a = 1; b = 2 }` was
 *   reported as a default written in a record. It runs now; what in a body
 *   cannot run is said, with why.
 * - An `#if` or `#each` with no `#end` took everything after it, up to the
 *   end of the element it stood in or of the page, and said nothing. `#endif`,
 *   which other template languages use, is words here, so it did the same.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNRenderContext } from '../src/types';

function html(source: string, state: Record<string, unknown> = {}): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const context = { state, setState: () => {}, data: {}, functions: {}, computed: {} } as unknown as SoftNRenderContext;
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context, new ComponentRegistry())));
}

const messages = (source: string) => (parse(source).diagnostics ?? []).map((d) => `${d.loc.line}: ${d.message}`);

/**
 * Each diagnostic's severity. A page the parser used to read without a word
 * is warned of, not refused: the Builder takes an error for a page it cannot
 * write back as written, and it could write those pages.
 */
const severities = (source: string) => (parse(source).diagnostics ?? []).map((d) => d.severity);

describe('a < in words', () => {
  it('is text, where it cannot begin a tag', () => {
    expect(html('<p>1 < 2 and {a < 2 ? "yes" : "no"}</p>', { a: 1 })).toBe('<p>1 &lt; 2 and yes</p>');
    expect(html('<p>I <3 it</p>')).toBe('<p>I &lt;3 it</p>');
    expect(html('<p>a <= b</p>')).toBe('<p>a &lt;= b</p>');
    expect(html('<p>left <- right</p>')).toBe('<p>left &lt;- right</p>');
    expect(html('<p>< 5 left</p>')).toBe('<p>&lt; 5 left</p>');
    expect(html('<div><p>x</p> < <p>y</p></div>')).toBe('<div><p>x</p> &lt; <p>y</p></div>');
  });

  it('still begins a tag, a closing tag and a comment where it can', () => {
    expect(html('<p>a<b>bold</b></p>')).toBe('<p>a<b>bold</b></p>');
    expect(html('<p>a <b>bold</b> c</p>')).toBe('<p>a <b>bold</b> c</p>');
    expect(html('<div><!-- note --><p>x</p></div>')).toBe('<div><p>x</p></div>');
  });
});

describe('a handler written as a quoted string', () => {
  // It was words, with a warning that said where the braces went. Quoted code
  // is how HTML writes `onclick="save()"` and how Vue writes `@click`, so it
  // is read as that code now, run when the event fires.
  it('is the code it holds, run when the event fires', () => {
    const event = (source: string) => {
      const doc = parse(source);
      expect(doc.diagnostics ?? [], source).toEqual([]);
      return (doc.template[0] as { events: Array<{ handler: { type: string }; modifiers?: string[] }> }).events[0];
    };
    expect(event('<button @click="save()">x</button>').handler.type).toBe('ArrowFunctionExpression');
    expect(event('<button @click="save(); close()">x</button>').handler.type).toBe('ArrowFunctionExpression');
    // A name alone is the function to call, as `@click={save}` is.
    expect(event('<button @click="save">x</button>').handler.type).toBe('Identifier');
    expect(event('<a href="#" @click="go(); return false">x</a>').modifiers).toEqual(['prevent']);
  });

  it('is reported when it is code a page cannot run', () => {
    expect(messages('<div>\n<button @click="if (a) save()">x</button>\n</div>')).toEqual([
      '2: @click="if (a) save()" could not be read as a handler, so it does nothing. ' +
        `Call a function of the app's logic, as in @click="save()", or write @click={() => …}`,
    ]);
    expect(severities('<button @click="if (a) save()">x</button>')).toEqual(['warning']);
    expect(messages('<button @click="">x</button>')).toEqual([
      '1: @click="" has no handler: write the code to run in the quotes, or @click={…}',
    ]);
  });
});

describe('an arrow with a block body', () => {
  // `() => { save() }` is how a handler that does several things is written.
  // Its braces were read as a record, so it did nothing (`{ save() }` called
  // the record `{ save }`), or half of what was written. It runs now, one
  // statement after another, as the author meant: what markup can say of a
  // statement is what it can say of an expression. What it cannot say is
  // reported, with why, and that handler does nothing.
  it('is read as the statements it holds, with nothing to report', () => {
    for (const source of [
      '<button @click={() => { save() }}>x</button>',
      '<button @click={(e) => { save(e); close() }}>x</button>',
      '<button @click={() => {\n  count = count + 1\n  save()\n}}>x</button>',
      '<button @click={() => { a = 1; b = 2; }}>x</button>',
      '<Chart format={(v) => { return v * 2 }} />',
      '<button @click={() => {}}>x</button>',
    ]) {
      expect(messages(source), source).toEqual([]);
    }
  });

  it('says why a statement markup does not read cannot run', () => {
    const cannot = (what: string) =>
      `1: This handler's { } body cannot run: ${what}. Markup runs a body's expressions one after another, ` +
      'as in @click={() => { count++; save() }}; anything more belongs in a logic function the handler calls';
    expect(messages('<button @click={() => { if (ok) save() }}>x</button>')).toEqual([cannot('"if" is a statement markup does not read')]);
    expect(messages('<button @click={() => { let n = 1; save(n) }}>x</button>')).toEqual([cannot('"let" is a statement markup does not read')]);
    expect(messages('<button @click={() => { for (const t of items) save(t) }}>x</button>')).toEqual([cannot('"for" is a statement markup does not read')]);
    expect(messages('<button @click={() => { save() close() }}>x</button>')).toEqual([
      cannot('two statements on one line need a ";" between them'),
    ]);
    expect(severities('<button @click={() => { if (ok) save() }}>x</button>')).toEqual(['warning']);
  });

  it('is not confused with an arrow that makes a record', () => {
    expect(messages('<Chart format={(v) => ({ label: v })} />')).toEqual([]);
    expect(messages('<Chart format={() => { label: "x" }} />')).toEqual([]);
  });
});

describe('#elif, which other languages spell #elseif', () => {
  // `#elif` is not a block here, so it was words: drawn on the page inside
  // the branch before it, with the branch it meant to start drawn there too.
  it('is warned of where it is written, with the word to use', () => {
    const source = '#if (a)\n<p>a</p>\n#elif (b)\n<p>b</p>\n#end';
    expect(messages(source)).toEqual([
      '3: "#elif" is not a SoftN block, so it is shown as words: write #elseif (or #else if)',
    ]);
    expect(severities(source)).toEqual(['warning']);
    expect(messages('<div>\n#if (a)\n<p>a</p>\n  #elsif (b)\n<p>b</p>\n#end\n</div>')).toEqual([
      '4: "#elsif" is not a SoftN block, so it is shown as words: write #elseif (or #else if)',
    ]);
  });

  it('is left alone in words', () => {
    expect(messages('<p>Python writes #elif for else-if</p>')).toEqual([]);
  });
});

describe('a // comment after something on the line, before a closing tag', () => {
  // In markup `//` begins a comment wherever a new piece of the page
  // begins, and runs to the end of the line, closing tag and all. What was
  // said was a mismatched tag at the parent's closing tag, lines away.
  it('is an error on its own line, naming the tag it took', () => {
    const said = messages('<div>\n  <p>{count} // items</p>\n</div>');
    expect(said[0]).toBe(
      '2: This // comment runs to the end of its line and takes the "</p>" after it with it. ' +
        'Put the comment on a line of its own, or write the words in braces, as in {"// items"}'
    );
    // The `</div>` after it ends the paragraph, as in HTML, with nothing more to say.
    expect(said.length).toBeGreaterThanOrEqual(1);
  });

  it('is not said of a line of markup commented out, or of a note after a closing tag', () => {
    expect(messages('<div>\n  // <Button>Save</Button>\n  <p>x</p>\n</div>')).toEqual([]);
    expect(messages('<div>\n  <p>{a}</p> // a note\n</div>')).toEqual([]);
  });
});

describe('a block with no #end', () => {
  it('is reported where it opens, for #if and for #each', () => {
    expect(messages('<div>\n#if (a)\n  <p>x</p>\n</div>')).toEqual([
      '2: This #if has no #end, so it runs to the end of the element it is in. Write #end where it should stop',
    ]);
    expect(messages('#each (t in tasks)\n<p>{t}</p>\n<p>after</p>')).toEqual([
      '1: This #each has no #end, so it runs to the end of the page. Write #end where it should stop',
    ]);
    expect(messages('<div>\n#if (a)\n<p>a</p>\n#else\n<p>b</p>\n</div>')).toEqual([
      '2: This #if has no #end, so it runs to the end of the element it is in. Write #end where it should stop',
    ]);
    expect(severities('<div>\n#if (a)\n  <p>x</p>\n</div>')).toEqual(['warning']);
  });

  it('says what #endif is, when that is what ended it', () => {
    expect(messages('#if (a)\n<p>a</p>\n#endif\n<p>after</p>')).toEqual([
      '1: This #if has no #end, so it runs to the end of the page. Write #end where it should stop ("#endif" on line 3 is not one: SoftN closes every block with #end)',
    ]);
  });

  it('says nothing when the chain is closed', () => {
    expect(messages('#if (a)\n<p>a</p>\n#elseif (b)\n<p>b</p>\n#else\n<p>c</p>\n#end')).toEqual([]);
    expect(messages('#each (t in tasks)\n<p>{t}</p>\n#empty\n<p>none</p>\n#end')).toEqual([]);
    expect(messages('<div>#if (a)<p>a</p>#end#if (b)<p>b</p>#end</div>')).toEqual([]);
  });
});

describe('a block header without parentheses', () => {
  // `#if ok` read the rest of the page as its condition, and the page drew
  // nothing at all, under "expected LPAREN".
  it('runs to the end of its line', () => {
    expect(html('#if ok\n<p>yes</p>\n#else\n<p>no</p>\n#end', { ok: true })).toBe('<p>yes</p>');
    expect(html('#if ok\n<p>yes</p>\n#else\n<p>no</p>\n#end', { ok: false })).toBe('<p>no</p>');
    expect(html('#if items.includes(2) && ok\n<p>two</p>\n#end', { items: [1, 2], ok: true })).toBe('<p>two</p>');
    expect(html('#if a\nA\n#elseif b\nB\n#else if (c)\nC\n#end', { a: false, b: false, c: true }).trim()).toBe('C');
    // `#else if c` is still the #else branch with the words "if c" in it, as
    // it always was: without the parenthesis `#else` cannot tell them apart.
    expect(html('#if a\nA\n#else if you like\n#end', { a: false }).trim()).toBe('if you like');
    expect(html('<ul>\n#each item in items\n<li>{item}</li>\n#end\n</ul>', { items: ['x', 'y'] })).toBe('<ul><li>x</li><li>y</li></ul>');
    expect(html('#each item, i in items key={item}\n<p>{i}{item}</p>\n#end', { items: ['x'] })).toBe('<p>0x</p>');
  });

  it('says what it did not read, past the condition on its line', () => {
    expect(messages('#if ok yes\n<p>x</p>\n#end')).toEqual([
      '1: "yes" is not part of this block\'s header, so it was not read: a header without parentheses runs to the end of its line, so put the condition in parentheses',
    ]);
  });
});

describe('an #each written with of', () => {
  it('is the same loop as in, as JavaScript\'s for…of writes it', () => {
    expect(html('#each (item of items)\n<p>{item}</p>\n#end', { items: ['a', 'b'] })).toBe('<p>a</p><p>b</p>');
    expect(html('#each ([k, v] OF pairs)\n<p>{k}{v}</p>\n#end', { pairs: [['a', 1]] })).toBe('<p>a1</p>');
  });
});

describe('another framework\'s way of writing a page', () => {
  it('names Svelte\'s and Handlebars\' blocks, once each, and the page still draws', () => {
    const said = messages('<div>{#if ok}<p>yes</p>{:else}<p>no</p>{/if}</div><p>after</p>');
    expect(said).toHaveLength(3);
    expect(said[0]).toMatch(/^1: "\{#if" is how Svelte or Handlebars writes a block\. SoftN writes #if \(condition\)/);
    expect(messages('{{#each items}}<p>x</p>{{/each}}')[0]).toMatch(/"\{\{#each" is how Svelte or Handlebars/);
    // The rest of the page is read as the page, not as the block's condition.
    const doc = parse('<div>{#if ok}<p>yes</p>{/if}</div><p>after</p>');
    expect(doc.template.map((n) => (n.type === 'Element' ? n.tag : n.type))).toEqual(['div', 'p']);
  });

  it('says that {{ name }} shows a record', () => {
    expect(messages('<p>Hello {{ name }}</p>')).toEqual([
      '1: "{{ … }}" shows a record, not a value: SoftN writes a value in single braces, as in {name}',
    ]);
    expect(messages('<div style={{ color: "red" }}>x</div>')).toEqual([]);
  });

  it('says that markup is not written inside braces', () => {
    expect(messages('<div>{ok && <p>yes</p>}</div>')[0]).toMatch(/^1: Markup is not written inside \{ \}: show it when a condition holds with #if/);
  });

  it('names Angular\'s attributes and Vue\'s directives, with what SoftN writes', () => {
    expect(messages('<p *ngIf="ok">yes</p>')).toEqual([
      '1: "*ngIf="ok"" is how Angular writes this, so it was not read: SoftN writes #if (ok) … #end, or if={ok} on the tag',
    ]);
    expect(messages('<input [value]="name">')).toEqual(['1: "[value]="name"" is how Angular writes this, so it was not read: SoftN writes value={name}']);
    expect(messages('<button (click)="save()">x</button>')).toEqual([
      '1: "(click)="save()"" is how Angular writes this, so it was not read: SoftN writes @click={() => save()}, or onclick="save()"',
    ]);
    expect(messages('<input [(ngModel)]="name">')[0]).toMatch(/SoftN writes :bind=\{name\}$/);
    expect(messages('<li v-for="item in items">x</li>')).toEqual(['1: "v-for" is Vue\'s, so it does nothing here: SoftN writes #each (item in items) … #end']);
    expect(messages('<input :value="name">')).toEqual(['1: :value="name" is how Vue writes this: SoftN writes :value={name}']);
  });

  it('reads a template literal written as an attribute\'s value', () => {
    expect(html('<p title=`Hi ${name}`>x</p>', { name: 'Ada' })).toBe('<p title="Hi Ada">x</p>');
  });
});
