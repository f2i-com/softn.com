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
  it('is reported, with the braces it needs', () => {
    expect(messages('<div>\n<button @click="save()">x</button>\n</div>')).toEqual([
      '2: @click takes its handler in braces, not in quotes: write @click={() => save()}',
    ]);
    expect(messages('<button @click="save">x</button>')).toEqual([
      '1: @click takes its handler in braces, not in quotes: write @click={save}',
    ]);
    expect(severities('<button @click="save()">x</button>')).toEqual(['warning']);
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
    expect(said.length).toBeGreaterThan(1);
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
