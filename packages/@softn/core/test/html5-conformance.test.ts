/**
 * A page written as HTML is read as HTML5 reads it: SoftN's parser beside a
 * spec-conformant one (the test environment's DOMParser, jsdom's parse5), on
 * plain HTML fragments, compared by
 * tags, attributes and text (whitespace collapsed; `on…` handlers, which
 * SoftN turns into events, left out).
 *
 * What the comparison holds: tag and attribute names in any case, unquoted
 * values, the end tags HTML lets a page leave out and the elements it implies
 * (a table's `<tbody>`, a row around cells written straight into a table),
 * the elements an end tag out of order closes and opens again, raw text in
 * `<textarea>` and `<title>`, CDATA in SVG, and character references with and
 * without their `;`. `DIFFERENCES` are where SoftN reads a page its own way,
 * on purpose, each pinned to that reading.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import type { TemplateNode } from '../src/parser/ast';

type Shape = string | { html: string };

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim().replaceAll('<', '&lt;');
const attributes = (pairs: Array<[string, string]>): string =>
  pairs
    .filter(([name]) => !/^on/i.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ` ${name}=${JSON.stringify(value)}`)
    .join('');
const join = (nodes: Shape[]): string => {
  const out: Shape[] = [];
  for (const node of nodes) {
    if (typeof node === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += ` ${node}`;
    else out.push(node);
  }
  return out.map((node) => (typeof node === 'string' ? collapse(node) : node.html)).join('');
};

function html5(fragment: string): string {
  const shape = (parent: ParentNode): string =>
    join(
      [...parent.childNodes].map((node): Shape => {
        if (node.nodeType === 3 || node.nodeType === 4) return (node as Text).data;
        if (node.nodeType !== 1) return '';
        const element = node as Element;
        const inside = element.localName === 'template' ? (element as HTMLTemplateElement).content : element;
        const attrs = attributes([...element.attributes].map((a) => [a.name, a.value]));
        return { html: `<${element.localName}${attrs}>${shape(inside)}</${element.localName}>` };
      })
    );
  // The test environment's DOMParser is jsdom's, which parses with parse5.
  return shape(new DOMParser().parseFromString(`<!DOCTYPE html><body>${fragment}</body>`, 'text/html').body);
}

function softn(fragment: string): string {
  const shape = (nodes: TemplateNode[]): string =>
    join(
      nodes.map((node): Shape => {
        if (node.type === 'Text') return node.content;
        if (node.type !== 'Element') return { html: `[${node.type}]` };
        const attrs = attributes(
          node.props.map((p) => [p.name, p.value.type === 'static' ? p.value.value : p.value.type === 'boolean' ? '' : String(p.value.value)])
        );
        return { html: `<${node.tag}${attrs}>${shape(node.children)}</${node.tag}>` };
      })
    );
  return shape(parse(fragment).template);
}

const CONFORMS: Record<string, string> = {
  impliedParagraph: '<p>One<p>Two',
  paragraphEndedByBlock: '<p>Text<div>block</div>',
  paragraphEndedByTable: '<p>Text<table><tr><td>x</td></tr></table>',
  paragraphEndedByList: '<p>intro<ul><li>a</ul>after',
  strayParagraphEnd: '<div>a</p>b</div>',
  listItems: '<ul><li>a<li>b<li>c</ul>',
  nestedLists: '<ul><li>a<ul><li>b</ul><li>c</ul>',
  listItemEndsParagraph: '<ul><li><p>a<li>b</ul>',
  definitions: '<dl><dt>a<dd>b<dt>c<dd>d</dl>',
  definitionsReversed: '<dl><dd>a<dt>b</dl>',
  table: '<table><tr><td>1<td>2<tr><td>3</table>',
  tableSections: '<table><thead><tr><th>h<tbody><tr><td>b<tfoot><tr><td>f</table>',
  tableHeadOnly: '<table><thead><tr><th>a<tr><th>b</table>',
  caption: '<table><caption>Cap<tr><td>x</table>',
  columns: '<table><colgroup><col span=2><col></colgroup><tr><td>x</table>',
  cellsInTable: '<table><td>x</td></table>',
  nestedTables: '<table><tr><td><table><tr><td>in</table></td><td>b</table>',
  emptyTable: '<table></table><p>x</p>',
  options: '<select><option>a<option selected>b<optgroup label=g><option>c</select>',
  optionGroups: '<select><optgroup label=a><option>1<optgroup label=b><option>2</select>',
  optionsOutsideSelect: '<option>a<option>b',
  capitals: '<DIV CLASS="x" ID=y>hi</DIV>',
  capitalEndTag: '<div>hi</DIV>',
  capitalVoids: '<p>a<BR>b<IMG SRC=a.png ALT="">c</p>',
  capitalDocument: '<P>One<P>Two<UL><LI>a<LI>b</UL>',
  attributeCase: '<div TabIndex=0 Title="t" DATA-X=1 Aria-Label=L>x</div>',
  unquoted: '<input type=text value=hello disabled><a href=/about/us>x</a><img src=a.png alt=x>',
  unquotedOdd: '<input type=datetime-local><div data-x=a&amp;b title=a:b>t</div><font color=#fff>c</font>',
  singleQuoted: "<input value='single quoted' title='a \"b\"'>",
  duplicateAttribute: '<div id=a id=b>x</div>',
  textareaText: '<textarea>a <b>b</b> &amp; c</textarea>',
  titleText: '<div><title>A <b>&amp;</b></title></div>',
  entities: '<p>&copy; &COPY; &#169; &#xA9; &amp; &lt;tag&gt; &quot; &nbsp;x</p>',
  entitiesWithoutSemicolons: '<p>&amp &copy 2026 a&b &notit;</p>',
  entitiesInAttributes: '<a title="a &amp; b &quot;q&quot;" href="?a=1&amp;b=2&copy=3">t</a>',
  wordsWithEntities: '<p>Tom &amp; Jerry AT&T &frac12; &lt;3</p>',
  lessThanInText: '<p>1 < 2 and 3 > 2, a <= b</p>',
  misnested: '<p><b><i>x</b>y</i>z</p>',
  misnestedLink: '<a href=1>x<b>y</a>z</b>',
  misnestedDeep: '<b>1<i>2<u>3</b>4</u>5</i>6',
  unclosedInline: '<div><span>text</div><p>after</p>',
  unclosedAtEnd: '<div><span>text',
  nestedLinks: '<a href=1>one<a href=2>two</a></a>',
  nestedButtons: '<button>one<button>two</button></button>',
  headings: '<h1>a<h2>b</h2></h1>',
  comments: '<!-- a --><p>x<!-- <b> --></p>',
  svg: '<svg viewBox="0 0 10 10"><linearGradient id=g></linearGradient><path d="M0 0"/><circle r=1 /></svg>',
  svgCdata: '<svg><text><![CDATA[x < y]]></text></svg>',
  mathml: '<math><mi>x</mi><mo>=</mo><mn>2</mn></math>',
  customElement: '<my-card some-attr>hi</my-card>',
  booleans: '<button disabled=disabled>b</button><details open><summary>S</summary>body</details>',
  buttonParagraph: '<button><p>x</button>',
  preformatted: '<pre>\nline1\n  line2</pre>',
  voids: '<p>a<br/>b<hr/>c</p>',
  lineBreakEnd: '<p>a</br>b</p>',
  imageIsImg: '<image src=x.png>',
  inlineAroundBlock: '<span><div>x</div></span>',
  ruby: '<ruby>漢<rp>(</rp><rt>kan<rt>ji</ruby>',
  noscript: '<noscript><p>no js</p></noscript><p>after</p>',
  template: '<template id=row><p>x</p></template>',
  dataElement: '<p><data value="1">One</data></p>',
};

/** Where SoftN reads a page its own way, and what it reads instead. */
const DIFFERENCES: Record<string, [source: string, softn: string, why: string]> = {
  selfClosing: ['<div/>text', '<div></div>text', 'a `/>` ends any SoftN tag, where HTML ignores it on a non-void element'],
  nestedForm: ['<form><input name=a><form><input name=b></form></form>', '<form><input name="a"></input><form><input name="b"></input></form></form>', 'a form inside a form is kept, where HTML drops the inner tag'],
  blockInFormatting: ['<i><p>x</i>y</p>', '<i><p>x</p></i>y<p></p>', "HTML's adoption agency moves a block out of a formatting element; SoftN reopens formatting elements only around inline content"],
  paragraphThroughInline: ['<p><span><div>x</div></span></p>', '<p><span><div>x</div></span></p>', 'a block inside an inline element inside a paragraph stays there'],
};

describe('a page written as HTML', () => {
  it.each(Object.entries(CONFORMS))('reads %s as HTML5 does', (_name, fragment) => {
    expect(softn(fragment)).toBe(html5(fragment));
  });

  it.each(Object.entries(DIFFERENCES))('reads %s its own way, on purpose', (_name, [fragment, reading]) => {
    expect(softn(fragment)).toBe(reading);
    expect(softn(fragment)).not.toBe(html5(fragment));
  });
});
