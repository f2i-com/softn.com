/**
 * The language layer's reading of a page, round 3 of the audit: what a page
 * says is what it is read as, and a mistake in one part of it stays there.
 *
 * - A mistake that stops the reading of something inside an `#if`, an
 *   `#else` or an `#each` stays in that branch. It used to unwind the whole
 *   block: the block was dropped, the parent read on from the middle of it,
 *   and every branch's content was drawn unconditionally, the `#else` of an
 *   admin-only `#if` included.
 * - A custom element whose name begins with a block's or a raw-text
 *   element's name (`<style-box>`, `<logic-panel>`, `<data-grid>`,
 *   `<title-bar>`, `<pre-view>`) is a custom element, as HTML reads it. Its
 *   first word was taken for the block, and the rest of the page became a
 *   stylesheet, the logic, a data block or the text of a `<title>`.
 * - Text keeps the white space HTML keeps: a no-break space typed as itself
 *   (U+00A0) and an ideographic space (U+3000) are characters, not the
 *   spaces between words that a run collapses. `10&nbsp;km` was already kept;
 *   `10 km` written with the character itself was not.
 * - A numeric reference HTML reads through the Windows-1252 table
 *   (`&#150;`, `&#146;`) is the character a browser shows.
 * - A name the engine takes is a name in markup too: kana, Arabic, Hebrew,
 *   Devanagari, Thai, Vietnamese letters.
 * - After a number whose exponent turned out not to be one (`1em`), the
 *   columns of the rest of the line are where the words are.
 */

import { describe, expect, it } from 'vitest';
import { parse, tokenize, TokenType, PARSER_VERSION } from '../src/parser';
import type { ElementNode, SoftNDocument, TemplateNode } from '../src/parser/ast';

/** The tree without places, as plain data. */
const shape = (nodes: unknown): unknown => JSON.parse(JSON.stringify(nodes, (key, value) => (key === 'loc' ? undefined : value)));

const messages = (doc: SoftNDocument) => (doc.diagnostics ?? []).map((d) => d.message);

/** Every text node's content under `nodes`, in order. */
function texts(nodes: TemplateNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TemplateNode[]) => {
    for (const node of list) {
      if (node.type === 'Text') out.push(node.content);
      if (node.type === 'Element') walk(node.children);
      if (node.type === 'IfBlock') {
        walk(node.consequent);
        if (Array.isArray(node.alternate)) walk(node.alternate);
        else if (node.alternate) walk([node.alternate]);
      }
      if (node.type === 'EachBlock') {
        walk(node.body);
        if (node.emptyFallback) walk(node.emptyFallback);
      }
    }
  };
  walk(nodes);
  return out;
}

const first = (doc: SoftNDocument) => doc.template[0] as ElementNode;

describe('a mistake inside a block branch', () => {
  it('keeps the #if, and the #else stays behind its condition', () => {
    const doc = parse('<div>#if (show)\n{done ? "yes"}\n<p>shown</p>\n#else\n<p>secret</p>\n#end</div>');
    const div = first(doc);
    expect(div.children.map((child) => child.type)).toEqual(['IfBlock']);
    const block = div.children[0];
    if (block.type !== 'IfBlock') throw new Error('expected an IfBlock');
    expect(texts(block.consequent)).toEqual(['shown']);
    expect(texts(block.alternate as TemplateNode[])).toEqual(['secret']);
    expect(messages(doc)).toEqual(['Unexpected token "}" (EXPR_END), expected COLON']);
  });

  it('keeps a top-level #if, and what it guards is not drawn for everyone', () => {
    const doc = parse('#if (admin)\n{[1, 2}\n<p>admin only</p>\n#end\n<p>public</p>');
    expect(doc.template.map((node) => node.type)).toEqual(['IfBlock', 'Element']);
    expect(texts(doc.template)).toEqual(['admin only', 'public']);
    const block = doc.template[0];
    if (block.type !== 'IfBlock') throw new Error('expected an IfBlock');
    expect(texts(block.consequent)).toEqual(['admin only']);
  });

  it('keeps an #each and its #empty apart', () => {
    const doc = parse('<ul>#each (x in xs)\n{x ? 1}\n<li>{x}</li>\n#empty\n<li>none</li>\n#end</ul>');
    const list = first(doc);
    expect(list.children.map((child) => child.type)).toEqual(['EachBlock']);
    const block = list.children[0];
    if (block.type !== 'EachBlock') throw new Error('expected an EachBlock');
    expect(block.body.map((node) => node.type)).toEqual(['Element']);
    expect(texts(block.emptyFallback ?? [])).toEqual(['none']);
  });

  it('reads on after the mistake, inside the branch', () => {
    const doc = parse('#if (a)\n<p>one</p>\n{f(}\n<p>two</p>\n#elseif (b)\n<p>three</p>\n#end');
    const block = doc.template[0];
    if (block.type !== 'IfBlock') throw new Error('expected an IfBlock');
    expect(texts(block.consequent)).toEqual(['one', 'two']);
    expect(block.alternate && !Array.isArray(block.alternate) && texts(block.alternate.consequent)).toEqual(['three']);
  });
});

describe('the end tag of a <style>, <logic> or <script> with space before its >', () => {
  it('ends the block, as HTML ends one, and the page goes on after it', () => {
    const doc = parse('<style>.a{color:red}</style >\n<logic>let a = 1</logic\n>\n<script>let b = 2</SCRIPT\t>\n<p>after</p>');
    expect(doc.style?.content).toBe('.a{color:red}');
    expect(doc.logic?.code).toBe('let a = 1');
    expect(doc.script?.code).toBe('let b = 2');
    expect(texts(doc.template)).toEqual(['after']);
    expect(doc.diagnostics).toBeUndefined();
  });

  it('is not a longer name that begins with the block’s', () => {
    const doc = parse('<logic>let s = "</logical>"</logic><p>after</p>');
    expect(doc.logic?.code).toBe('let s = "</logical>"');
    expect(texts(doc.template)).toEqual(['after']);
  });
});

describe('an #end or #else that belongs to no block', () => {
  it('is said, where it was passed over without a word', () => {
    const doc = parse('<h2>#End of year</h2><p>if not, #else nothing</p>');
    expect(texts(doc.template)).toEqual(['of year', 'if not, ', 'nothing']);
    expect(doc.diagnostics?.map((d) => [d.severity, d.message, d.loc.column])).toEqual([
      ['warning', '"#End" belongs to no #if or #each open here, so it was passed over and is not drawn. To show the words, write \\#End', 5],
      ['warning', '"#else" belongs to no #if or #each open here, so it was passed over and is not drawn. To show the words, write \\#else', 33],
    ]);
  });

  it('is drawn when it is escaped', () => {
    const doc = parse('<h2>\\#End of year</h2>');
    expect(texts(doc.template)).toEqual(['#End of year']);
    expect(doc.diagnostics).toBeUndefined();
  });

  it('is not said for a block’s own', () => {
    expect(parse('#if (a)\n<p>x</p>\n#else\n<p>y</p>\n#end\n#each (i in xs)\n{i}\n#empty\nnone\n#end').diagnostics).toBeUndefined();
  });
});

describe('a block header that cannot be read', () => {
  it('keeps the #if and its #else, guarding the first branch with nothing', () => {
    const doc = parse('<div>#if (admin ? yes)\n<p>admin only</p>\n#else\n<p>public</p>\n#end\n<p>after</p></div>');
    const div = first(doc);
    expect(div.children.map((child) => child.type)).toEqual(['IfBlock', 'Element']);
    const block = div.children[0];
    if (block.type !== 'IfBlock') throw new Error('expected an IfBlock');
    expect(block.condition).toMatchObject({ type: 'Identifier', name: 'undefined' });
    expect(texts(block.consequent)).toEqual(['admin only']);
    expect(texts(block.alternate as TemplateNode[])).toEqual(['public']);
    expect(texts(div.children.slice(1))).toEqual(['after']);
    expect(messages(doc)).toEqual(['Unexpected token ")" (RPAREN), expected COLON']);
  });

  it('keeps an #each whose header has no `in`, and its #empty', () => {
    const doc = parse('<ul>#each (row rows)\n<li>{row}</li>\n#empty\n<li>none</li>\n#end</ul><p>after</p>');
    const list = first(doc);
    expect(list.children.map((child) => child.type)).toEqual(['EachBlock']);
    const block = list.children[0];
    if (block.type !== 'EachBlock') throw new Error('expected an EachBlock');
    expect(block.itemName).toBe('row');
    expect(block.iterable).toMatchObject({ type: 'Identifier', name: 'undefined' });
    expect(texts(block.emptyFallback ?? [])).toEqual(['none']);
    expect(doc.template).toHaveLength(2);
  });

  it('keeps a bare header to its line', () => {
    const doc = parse('#if ok ?\n<p>guarded</p>\n#end\n<p>after</p>');
    expect(doc.template.map((node) => node.type)).toEqual(['IfBlock', 'Element']);
  });

  it('keeps an #each whose key cannot be read, its rows going by their index', () => {
    const doc = parse('<ul>#each (row in rows) key={row ? id}\n<li>{row}</li>\n#end</ul>');
    const block = first(doc).children[0];
    if (block.type !== 'EachBlock') throw new Error('expected an EachBlock');
    expect(block.keyExpression).toBeUndefined();
    expect(block.body.map((node) => node.type)).toEqual(['Element']);
    expect(messages(doc)).toHaveLength(1);
  });
});

describe('a `{` left open at the end of the page', () => {
  it('is said at the top of a page', () => {
    const doc = parse('<p>before</p>\n{count');
    expect(doc.diagnostics).toEqual([
      {
        message: 'This "{" has no closing "}", so the rest of the page, from here to its end, was read as its expression',
        severity: 'error',
        loc: { line: 2, column: 1, start: 14, end: 15 },
      },
    ]);
  });

  it('is said in a paragraph, a list item or a cell, whose end tags may be left out', () => {
    for (const source of ['<p>{count</p><p>after</p>', '<li>{a</li><li>b</li>', '<td>{x</td><td>y</td>']) {
      expect(messages(parse(source))).toEqual([
        'This "{" has no closing "}", so the rest of the page, from here to its end, was read as its expression',
      ]);
    }
  });

  it('is left to an element around it that is not closed either', () => {
    expect(messages(parse('<ul><li>{a</li><li>b</li></ul>'))).toEqual(['<ul> is not closed, so it ends at the end of the page']);
  });

  it('is said in an attribute', () => {
    expect(parse('<p title={a + b>x</p>').diagnostics?.[0]).toMatchObject({ loc: { column: 10, start: 9 } });
  });

  it('is left to the unclosed tag where there is one', () => {
    expect(messages(parse('<Text>{count</Text><Text>after</Text>'))).toEqual(['Unclosed tag: <Text>']);
  });

  it('says nothing for a page whose braces close', () => {
    expect(parse('<p>{a}</p><p title={b}>{`x${y}`}</p>').diagnostics).toBeUndefined();
  });
});

describe('a custom element named after a block', () => {
  for (const [tag, block] of [
    ['style-box', 'style'],
    ['logic-panel', 'logic'],
    ['script-loader', 'script'],
    ['data-grid', 'data'],
    ['import-list', 'imports'],
    ['component-card', 'component'],
  ] as const) {
    it(`reads <${tag}> as an element, and the page after it`, () => {
      const doc = parse(`<${tag} rows="3"><b>inside</b></${tag}>\n<p>after</p>`);
      expect(doc.template.map((node) => (node.type === 'Element' ? node.tag : node.type))).toEqual([tag, 'p']);
      expect(texts(doc.template)).toEqual(['inside', 'after']);
      expect(first(doc).props.map((prop) => prop.name)).toEqual(['rows']);
      expect(doc.style).toBeUndefined();
      expect(doc.logic).toBeUndefined();
      expect(doc.script).toBeUndefined();
      expect(doc.data).toBeUndefined();
      expect(doc.imports).toEqual([]);
      expect(doc.component).toBeUndefined();
      void block;
      expect(doc.diagnostics).toBeUndefined();
    });
  }

  for (const tag of ['title-bar', 'textarea-field', 'iframe-frame', 'xmp-view', 'noembed-x', 'noframes-x']) {
    it(`reads <${tag}> as an element whose tags are tags`, () => {
      const doc = parse(`<div><${tag}>hello <b>x</b></${tag}><p>after</p></div>`);
      const div = first(doc);
      expect(div.children.map((node) => (node.type === 'Element' ? node.tag : node.type))).toEqual([tag, 'p']);
      expect(texts(doc.template)).toEqual(['hello ', 'x', 'after']);
      expect(doc.diagnostics).toBeUndefined();
    });
  }

  it('reads <title-bar> at the top of a page as an element, not as the head\'s title', () => {
    const doc = parse('<title-bar>Inbox</title-bar><p>after</p>');
    expect(doc.title).toBeUndefined();
    expect(doc.template.map((node) => (node.type === 'Element' ? node.tag : node.type))).toEqual(['title-bar', 'p']);
  });

  it('reads <html-view>, <head-line> and <body-text> as elements, not as a document\'s wrappers', () => {
    const doc = parse('<html-view>a</html-view><head-line>b</head-line><body-text>c</body-text>');
    expect(doc.template.map((node) => (node.type === 'Element' ? node.tag : node.type))).toEqual(['html-view', 'head-line', 'body-text']);
    expect(texts(doc.template)).toEqual(['a', 'b', 'c']);
  });

  it('collapses the white space of a <pre-view>, which is not a <pre>', () => {
    const doc = parse('<pre-view>  a\n   b  </pre-view>');
    expect(texts(doc.template)).toEqual([' a b ']);
  });

  it('still reads the blocks themselves', () => {
    const doc = parse('<style>.a { color: red }</style>\n<logic>let n = 1</logic>\n<pre>  x\n  y</pre>\n<title>T</title>');
    expect(doc.style?.content).toBe('.a { color: red }');
    expect(doc.logic?.code).toBe('let n = 1');
    expect(texts(doc.template)).toEqual(['  x\n  y']);
    expect(doc.title).toBe('T');
  });
});

describe('white space HTML does not collapse', () => {
  it('keeps a no-break space typed as itself', () => {
    expect(texts(parse('<p>10\xa0km</p>').template)).toEqual(['10\xa0km']);
    expect(texts(parse('<p>a \xa0 b</p>').template)).toEqual(['a \xa0 b']);
  });

  it('keeps a cell that holds only a no-break space', () => {
    const doc = parse('<table><tr><td>\xa0</td></tr></table>');
    expect(texts(doc.template)).toEqual(['\xa0']);
  });

  it('keeps an ideographic space at the start of a line of Japanese', () => {
    expect(texts(parse('<p>\u{3000}こんにちは</p>').template)).toEqual(['\u{3000}こんにちは']);
  });

  it('keeps a no-break space after an expression and after an element', () => {
    expect(texts(parse('<p>{n}\xa0km</p>').template)).toEqual(['\xa0km']);
    expect(texts(parse('<p><b>10</b>\xa0km</p>').template)).toEqual(['10', '\xa0km']);
  });

  it('still collapses the spaces, tabs and line breaks HTML collapses', () => {
    expect(texts(parse('<p>  a \t\n  b  </p>').template)).toEqual([' a b ']);
  });
});

describe('a numeric reference in the Windows-1252 range', () => {
  it('is the character a browser shows', () => {
    expect(texts(parse('<p>a&#150;b &#146;s &#128; &#x93;q&#x94; &#133;</p>').template)).toEqual(['a–b ’s € “q” …']);
  });

  it('leaves the five numbers the table has no character for, and the rest of the range', () => {
    expect(texts(parse('<p>&#129;&#141;&#143;&#144;&#157;&#160;&#127;</p>').template)).toEqual(['\x81\x8d\x8f\x90\x9d\xa0\x7f']);
  });

  it('is read in an attribute too', () => {
    const doc = parse('<p title="x&#151;y">z</p>');
    expect(first(doc).props[0].value).toEqual({ type: 'static', value: 'x—y' });
  });
});

describe('a name the engine takes', () => {
  for (const name of ['なまえ', 'カタカナ', 'tổng', 'اسم', 'שם', 'नाम', 'ชื่อ', 'գին', 'café', 'счётчик', '数']) {
    it(`is read whole in markup: ${name}`, () => {
      const doc = parse(`<p>{${name}}</p>`);
      expect(doc.diagnostics).toBeUndefined();
      expect(shape(first(doc).children)).toEqual([{ type: 'Expression', expression: { type: 'Identifier', name } }]);
    });
  }

  it('is a name after a dot and in a handler', () => {
    const doc = parse('<button @click={() => tổng = giá.số + 1}>x</button>');
    expect(doc.diagnostics).toBeUndefined();
    expect(shape(first(doc).events[0].handler)).toMatchObject({
      type: 'ArrowFunctionExpression',
      body: {
        type: 'AssignmentExpression',
        left: { type: 'Identifier', name: 'tổng' },
        right: { left: { object: { name: 'giá' }, property: { name: 'số' } } },
      },
    });
  });

  it('is not a sign: × and ÷ are operators no expression has, and said as such', () => {
    const doc = parse('<p>{a×b}</p>');
    expect(messages(doc).length).toBe(1);
  });
});

describe('the place of what follows a number that had no exponent', () => {
  it('counts the columns of the rest of the line from where it is', () => {
    const tokens = tokenize('<p>{1em + x}</p>');
    const at = (literal: string) => tokens.find((token) => token.literal === literal)!;
    expect([at('em').column, at('em').start]).toEqual([6, 5]);
    expect([at('+').column, at('+').start]).toEqual([9, 8]);
    expect([at('x').column, at('x').start]).toEqual([11, 10]);
    expect(tokens.find((token) => token.type === TokenType.NUMBER)?.literal).toBe('1');
  });

  it('points a diagnostic at the word', () => {
    const doc = parse('<p>{2e+ok}</p>');
    expect(doc.diagnostics?.[0]).toMatchObject({ loc: { line: 1, column: 6, start: 5 } });
  });
});

describe('the line an #elif is said on', () => {
  it('is its own, for each of many, counted once through the page', () => {
    const source = '<div>\n' + Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? '#elif x' : '<p>y</p>')).join('\r\n') + '\n</div>';
    const lines = (parse(source).diagnostics ?? []).filter((d) => d.message.startsWith('"#elif"')).map((d) => d.loc.line);
    expect(lines).toEqual(Array.from({ length: 25 }, (_, i) => 2 + i * 2));
  });
});

describe('the parser version', () => {
  it('moved with what parse now returns', () => {
    expect(PARSER_VERSION).toBe(18);
  });
});
