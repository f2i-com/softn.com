/**
 * What Round 3's parser changes left behind (audit round 4).
 *
 * - Round 3 read names in markup by Unicode's ID_Continue, but the check for a
 *   `#` that opens a block still read the word after it as ASCII letters:
 *   `#endổ` and `#ifで` were taken for `#end` and `#if`, the lexer opened a
 *   block header, the word came out as a name and not the block's keyword, and
 *   the header never closed: the rest of the page was lost.
 * - Round 3 kept a block whose header cannot be read, so its branches are not
 *   drawn. For a header written bare in the middle of a line, which is words
 *   (`Rinse #each day`), that hid the rest of the element.
 * - A bad `key=` in a bare `#each` header dropped the list as well.
 * - `1e` before a line break counted that line twice.
 * - The composer's reader of imported pages (page-include.ts) read a tag's
 *   name to its first hyphen and a raw block to an exact `</name>`, where the
 *   lexer now reads `<style-box>` as one element and ends `</style >`.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import type { TemplateNode } from '../src/parser';
import { readInclude } from '../src/bundle/page-include';

/** The words a page draws whatever its state: text outside every block, in order. */
function drawnText(nodes: TemplateNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'Text') out += node.content;
    else if (node.type === 'Element') out += drawnText(node.children ?? []);
  }
  return out;
}

describe('a word after # that runs on into a name', () => {
  it('is words, and the page goes on', () => {
    const doc = parse('<p>#endổ</p>\n<p>after</p>');
    expect(drawnText(doc.template)).toContain('#endổ');
    expect(drawnText(doc.template)).toContain('after');
    expect(drawnText(parse('<p>条件は#ifで分岐します</p>\n<p>after</p>').template)).toContain('after');
    const each = parse('<p>Post #each_day and #end_of_season</p><p>after</p>');
    expect(drawnText(each.template)).toBe('Post #each_day and #end_of_season' + 'after');
  });

  it('still opens a block where the word ends', () => {
    const doc = parse('#if (ok)\n<p>yes</p>\n#end\n<p>after</p>');
    expect(doc.template.some((node) => node.type === 'IfBlock')).toBe(true);
    expect(drawnText(doc.template)).toBe('after');
  });
});

describe('a block header that cannot be read', () => {
  it('written bare in the middle of a line, is words, and the page goes on', () => {
    const doc = parse('<main>\n<p>run #each-time</p>\n<p>after</p>\n</main>');
    expect(drawnText(doc.template)).toContain('after');
    expect(doc.diagnostics?.length ?? 0).toBeGreaterThan(0);
  });

  it('that starts its line, or is in parentheses, still keeps its block, and draws no branch', () => {
    const lineStart = parse('<div>\n#if admin ? yes\n<p>admin only</p>\n#end\n</div>');
    expect(drawnText(lineStart.template)).not.toContain('admin only');
    const parenthesised = parse('<div>#if (admin ? yes) <p>admin only</p> #end</div>');
    expect(drawnText(parenthesised.template)).not.toContain('admin only');
  });
});

describe('an end tag in a branch that closes nothing open', () => {
  // Round 3 kept a mistake inside a branch in its branch; an end tag after it
  // (the `</a>` of an `<a>` whose tag could not be read, or a stray `</b>`)
  // was still taken for the block's end, and the #else after it was drawn for
  // everyone.
  it('is passed over, and the #else stays the block’s', () => {
    for (const source of [
      '#if (admin)\n<a href={u ? v}>link</a>\n#else\n<p>secret</p>\n#end',
      '#if (admin)\n<p>x</p></b>\n#else\n<p>secret</p>\n#end',
      '<div>#if (admin)\n<span>x</span></i>\n#else\n<p>secret</p>\n#end</div>',
    ]) {
      const doc = parse(source);
      expect(drawnText(doc.template), source).not.toContain('secret');
    }
  });

  it('is passed over, and the #empty stays the loop’s', () => {
    const doc = parse('<ul>#each (x in xs)\n<li>{x}</li></b>\n#empty\n<li>none</li>\n#end</ul>');
    expect(drawnText(doc.template)).not.toContain('none');
  });

  it('still ends the block where it closes the element the block is in', () => {
    const doc = parse('<div>#if (a)\n<p>x</p>\n</div>\n<p>after</p>');
    expect(drawnText(doc.template)).toContain('after');
  });
});

describe('a key that cannot be read in a bare #each header', () => {
  it('is said, and the list is still the list', () => {
    const doc = parse('#each x in xs key={x ?}\n<p>{x}</p>\n#end');
    const each = doc.template.find((node) => node.type === 'EachBlock');
    expect(each && each.type === 'EachBlock' && each.iterable).toMatchObject({ type: 'Identifier', name: 'xs' });
    expect(doc.diagnostics?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('a number that had no exponent before a line break', () => {
  it('leaves the lines after it counted once', () => {
    const doc = parse('<p>{a +\n1e\n}</p>\n<p>{b ?}</p>');
    const lines = (doc.diagnostics ?? []).map((d) => d.loc.line);
    expect(lines).toContain(4);
    expect(lines.every((line) => line <= 4)).toBe(true);
    expect((doc.diagnostics ?? []).every((d) => d.loc.column >= 0)).toBe(true);
  });
});

describe('an imported page read by the composer', () => {
  const page = (extra: string) =>
    `<data>\n<collection name="t" as="t" />\n</data>\n<style>.a{}</style>\n<App>\n${extra}<p>x</p>\n</App>`;

  it('reads a custom element named after a block as an element', () => {
    const plain = readInclude(page(''));
    const custom = readInclude(page('<style-box>y</style-box>\n'));
    expect(plain.collections.map((c) => c.name)).toEqual(['t']);
    expect(custom.collections.map((c) => c.name)).toEqual(['t']);
    expect(custom.styles).toEqual(plain.styles);
    expect(custom.markup).toContain('<style-box>y</style-box>');
  });

  it('ends a raw block where the lexer ends it', () => {
    const spaced = readInclude('<data>\n<collection name="t" as="t" />\n</data>\n<style>.a{}</style >\n<App><p>x</p></App>');
    expect(spaced.collections.map((c) => c.name)).toEqual(['t']);
    expect(spaced.styles.length).toBe(1);
  });

  it('takes a custom element named data-… at the top for an element, not a data block', () => {
    const include = readInclude('<data-grid>x</data-grid>\n<p>y</p>');
    expect(include.markup).toContain('<data-grid>x</data-grid>');
  });
});
