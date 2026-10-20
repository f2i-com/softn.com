/**
 * A quoted attribute of an HTML element is read as HTML reads it.
 *
 * In HTML a backslash is a backslash: `pattern="[A-Z]{3}-\d{3}"` asks for a
 * digit. Read as a SoftN string, `\d` was an escape for a plain `d`, and a
 * valid entry was refused, with or without any code on the page. A
 * component's string is SoftN's, and keeps its escapes.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import type { ElementNode } from '../src/parser/ast';

function prop(source: string, name: string): unknown {
  const element = parse(source).template.find((node) => node.type === 'Element') as ElementNode;
  const found = element.props.find((p) => p.name === name);
  return found && found.value.type === 'static' ? found.value.value : undefined;
}

/** The tags of an element tree, as `ul(li(a) li(b))`. */
function shape(nodes: readonly unknown[]): string {
  return (nodes as Array<{ type: string; tag?: string; content?: string; children?: unknown[] }>)
    .filter((n) => n.type === 'Element' || (n.type === 'Text' && n.content?.trim()))
    .map((n) => (n.type === 'Text' ? n.content!.trim() : `${n.tag}(${shape(n.children ?? [])})`))
    .join(' ');
}

describe('an end tag HTML lets a page leave out', () => {
  it('is where HTML puts it', () => {
    expect(shape(parse('<ul><li>a<li>b</ul><p>after</p>').template)).toBe('ul(li(a) li(b)) p(after)');
    expect(shape(parse('<p>one<p>two<div>block</div>').template)).toBe('p(one) p(two) div(block)');
    // Rows written straight into a table are in the <tbody> HTML gives them.
    expect(shape(parse('<table><tr><td>a<td>b<tr><td>c</table>').template)).toBe('table(tbody(tr(td(a) td(b)) tr(td(c))))');
    expect(shape(parse('<dl><dt>term<dd>meaning<dt>next</dl>').template)).toBe('dl(dt(term) dd(meaning) dt(next))');
    expect(shape(parse('<select><option>a<option>b</select>').template)).toBe('select(option(a) option(b))');
  });

  it('is said nothing of, and an element that needs its end tag still does', () => {
    expect(parse('<ul><li>a<li>b</ul>').diagnostics ?? []).toEqual([]);
    expect((parse('<div><span>a</div>').diagnostics ?? []).length).toBeGreaterThan(0);
  });
});

describe('a quoted attribute', () => {
  it('of an HTML element keeps its backslashes', () => {
    expect(prop('<input pattern="[A-Z]{3}-\\d{3}">', 'pattern')).toBe('[A-Z]{3}-\\d{3}');
    expect(prop("<input pattern='\\w+@\\w+' >", 'pattern')).toBe('\\w+@\\w+');
    expect(prop('<p title="a \\ b &amp; c">x</p>', 'title')).toBe('a \\ b & c');
  });

  it('of a component is SoftN’s string, as it was', () => {
    expect(prop('<Card title="one\\ntwo" />', 'title')).toBe('one\ntwo');
  });

  it('without a backslash is read as it always was', () => {
    expect(prop('<a href="/x?a=1&amp;b=2">x</a>', 'href')).toBe('/x?a=1&b=2');
  });
});
