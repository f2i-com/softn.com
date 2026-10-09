import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/parser';

describe('hyphenated component attributes', () => {
  it('preserves ARIA and data attributes with quoted and expression values', () => {
    const doc = parse('<button aria-label="Open form" aria-pressed={active === 1} data-form-id="contacts">Open</button>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template[0]).toMatchObject({ props: [
      { name: 'aria-label', value: { type: 'static', value: 'Open form' } },
      { name: 'aria-pressed', value: { type: 'expression' } },
      { name: 'data-form-id', value: { type: 'static', value: 'contacts' } },
    ] });
  });
  it('keeps subtraction in attribute expressions separate from names', () => {
    const doc = parse('<Text data-count={total-used}>{total-used}</Text>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template[0]).toMatchObject({ props: [{ name: 'data-count', value: { type: 'expression', value: { type: 'BinaryExpression', operator: '-' } } }] });
  });
});

describe('entities in a quoted attribute', () => {
  const valueOf = (source: string) => {
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    const node = doc.template[0];
    if (node.type !== 'Element') throw new Error('expected an element');
    return node.props[0].value;
  };

  it('are read as they are in text', () => {
    // An author who cannot write a double quote inside a double-quoted value
    // writes &quot;, as in HTML. It was handed on as the six characters, so a
    // placeholder showed `{ &quot;walls&quot;: [ ... ] }` to the person
    // typing into it, while the same entity in text was a quote.
    expect(valueOf('<TextArea placeholder="{ &quot;walls&quot;: [ ... ] }" />')).toEqual({
      type: 'static',
      value: '{ "walls": [ ... ] }',
    });
    expect(valueOf('<Button label="Tom &amp; Jerry &lt;3 &#39;x&#39; &#x2713; &rarr;" />')).toEqual({
      type: 'static',
      value: "Tom & Jerry <3 'x' \u2713 \u2192",
    });
    expect(valueOf("<Button label='single &quot;quoted&quot;' />")).toEqual({ type: 'static', value: 'single "quoted"' });
  });

  it('leave an ampersand that begins no entity alone', () => {
    expect(valueOf('<a href="/search?q=tea&page=2&amp;sort=new">x</a>')).toEqual({
      type: 'static',
      value: '/search?q=tea&page=2&sort=new',
    });
    expect(valueOf('<Button label="Q&A; R&D &unknown; &" />')).toEqual({ type: 'static', value: 'Q&A; R&D &unknown; &' });
  });

  it('are not read inside an expression, which is JavaScript', () => {
    const value = valueOf('<Button label={"Tom &amp; Jerry"} />');
    expect(value).toMatchObject({ type: 'expression', value: { type: 'Literal', value: 'Tom &amp; Jerry' } });
  });
});

describe('a character reference that names no character', () => {
  // String.fromCodePoint throws for a number past U+10FFFF. Inside an element
  // the parser recovers from a failure by stopping at the next text, which was
  // the text that had just failed: it read the same token for ever and took
  // the page, the editor or the test run down with it, out of memory.
  it.each(['&#99999999;', '&#x110000;', '&#xD800;', '&#0;', '&#99999999999999999999999999;'])(
    '%s is the replacement character, in text and in an attribute',
    (reference) => {
      const doc = parse(`<Text title="a ${reference} b">a ${reference} b</Text>`);
      expect(doc.diagnostics ?? []).toEqual([]);
      expect(doc.template[0]).toMatchObject({
        props: [{ name: 'title', value: { type: 'static', value: 'a \uFFFD b' } }],
        children: [{ type: 'Text', content: 'a \uFFFD b' }],
      });
    }
  );

  it('ends inside a block inside an element too', () => {
    const doc = parse('<Stack>#if (ok)\n  &#99999999; shown\n#else\n  &#x110000;\n#end\n#each (n in 3)\n  &#99999999;\n#empty\n  &#99999999;\n#end</Stack>');
    expect(doc.diagnostics ?? []).toEqual([]);
  });
});

describe('an import', () => {
  // The path was looked for directly after the word `from`, where the `=`
  // of `from="…"` stands, so it was never found: every import the parser
  // reported had an empty source, and an editor asking where a component
  // comes from was told nowhere.
  it.each([
    ['<import Header from="./components/Header.ui" />', { defaultImport: 'Header', source: './components/Header.ui' }],
    ["<import Header from='./components/Header.ui' />", { defaultImport: 'Header', source: './components/Header.ui' }],
    ['<import { Row, Cell as C } from="./table.ui" />', { namedImports: ['Row', 'C'], source: './table.ui' }],
    ['<import Header from "./components/Header.ui" />', { defaultImport: 'Header', source: './components/Header.ui' }],
  ])('%s says where it is from', (source, expected) => {
    const doc = parse(`${source}\n<App />`);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.imports).toHaveLength(1);
    expect(doc.imports[0]).toMatchObject(expected);
  });
});
