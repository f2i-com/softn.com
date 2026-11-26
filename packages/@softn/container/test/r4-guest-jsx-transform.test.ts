/**
 * Uncompiled JSX and TSX, as Babel, esbuild and TypeScript read it (src/jsx-transform.ts).
 *
 * What an element became was all on one line: every error after a JSX element of more than
 * one line was reported that many lines too early, in the file and in its code frame. Of the
 * named character references only six were read (`&copy;`, `&mdash;`, `&times;` showed as
 * written). A comment in an element's opening tag before its props left the element unread,
 * and the module did not compile. And `x.default / 2` was taken for a regular expression's
 * start, which swallowed the rest of the line.
 */
import { describe, expect, it } from 'vitest';
import { transformJsx } from '../src/jsx-transform';

const h = (tag: unknown, props: unknown, ...children: unknown[]) => ({ tag, props, children });
/** What the transformed element evaluates to, with a stand-in factory. */
const tree = (source: string, scope: Record<string, unknown> = {}) =>
  new Function('globalThis', ...Object.keys(scope), `return (${transformJsx(source)});`)({ __softnJsx: h, __softnFragment: 'Fragment' }, ...Object.values(scope));
const lineOf = (text: string, word: string) => text.slice(0, text.indexOf(word)).split(/\r\n|\n|\r/).length;

describe('JSX', () => {
  it('keeps every line where it was, inside an element and after it', () => {
    const sources = [
      'const a = (\n  <div>\n    <h1>Title</h1>\n    <p>Body</p>\n  </div>\n);\nMARK_1;',
      'const a = <div\n  id="x"\n  onClick={() => {\n    MARK_1();\n  }}\n  title="t"\n>\n  text {MARK_2}\n  more\n</div>;\nMARK_3;',
      'const a = <A b={"https://x.com"} c={\'//\'}>{"//"}</A>;\nMARK_1;',
      'const a = <div>\n  {/* a comment\n     over lines */}\n  {MARK_1}\n</div>;\nMARK_2;',
      'const a = <>\n  <A {...p}\n    {...q} />\n  {MARK_1 // note\n  }\n</>;\nMARK_2;',
      'const a = <div title="multi\nline">x</div>;\nMARK_1;',
      'const a = <a>\n  <b>\n    <c>\n    </c>\n  </b>\n</a\n>;\nMARK_1;',
    ];
    for (const source of sources) {
      const out = transformJsx(source);
      for (const mark of source.match(/MARK_[0-9]/g) ?? []) expect([source, mark, lineOf(out, mark)]).toEqual([source, mark, lineOf(source, mark)]);
      expect(out.split('\n').length).toBe(source.split('\n').length);
    }
  });

  it('reads every named character reference XHTML has, in text and in a prop', () => {
    const copy = String.fromCharCode(0xa9);
    const out = tree('<p title="&copy; 2024 &amp; co">&copy; &hellip; &mdash; &times; &rarr; &euro; &trade; &deg; &hearts; &unknown; &ZeroWidthSpace;</p>') as { props: { title: string }; children: string[] };
    expect(out.props.title).toBe(`${copy} 2024 & co`);
    expect(out.children[0]).toBe([0xa9, 0x2026, 0x2014, 0xd7, 0x2192, 0x20ac, 0x2122, 0xb0, 0x2665].map((c) => String.fromCharCode(c)).join(' ') + ' &unknown; &ZeroWidthSpace;');
  });

  it('reads an element with a comment before its props', () => {
    expect(tree('<div /* where */ id="x" />')).toEqual({ tag: 'div', props: { id: 'x' }, children: [] });
    expect(tree('<div\n  // why\n  id="y"\n/>')).toEqual({ tag: 'div', props: { id: 'y' }, children: [] });
  });

  it('divides after a property named like a keyword', () => {
    const sizes = { default: 8 };
    expect(tree('<div style={{ width: sizes.default / 2 }}>{sizes.default / 4}</div>', { sizes })).toEqual({ tag: 'div', props: { style: { width: 4 } }, children: [2] });
  });
});
