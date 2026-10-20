/**
 * A page's lowercase elements are tags; logic's comparisons are not.
 *
 * The app page sends a bundle's `.html` pages to the highlighter, and since
 * parser 13 a lowercase name in a `.ui` page is an HTML element too, yet the
 * rules coloured only capitalised components: `<div>`, `<section>` and
 * `<input>` read as prose. Logic must not gain the same rule — `i<n` is a
 * comparison there — so pages are read as markup and logic as before.
 */

import { describe, expect, it } from 'vitest';
import { highlight, languageOf, type HighlightLanguage } from '../src/lib/highlight';
import { SAMPLES } from '../src/data/language';

const tokens = (source: string, language: HighlightLanguage): Array<[string, string]> =>
  highlight(source, language).map((el) => [el.props.className as string, el.props.children as string]);
const tagged = (source: string, language: HighlightLanguage) =>
  tokens(source, language)
    .filter(([cls]) => cls === 'tok-tag')
    .map(([, text]) => text);

describe('markup', () => {
  it('reads pages as markup, logic as logic and Python as Python', () => {
    expect(languageOf('index.html')).toBe('markup');
    expect(languageOf('pages/tasks.htm')).toBe('markup');
    expect(languageOf('ui/main.ui')).toBe('markup');
    expect(languageOf('assets/icon.svg')).toBe('markup');
    expect(languageOf('logic/main.logic')).toBe('softn');
    expect(languageOf('main.js')).toBe('softn');
    expect(languageOf('logic/main.py')).toBe('python');
  });

  it('colours lowercase elements, the doctype and comments in a page', () => {
    const page = '<!doctype html>\n<!-- the list -->\n<section class="tasks">\n  <input type="text" />\n  <Button @click={add}>Add</Button>\n</section>';
    const out = tokens(page, 'markup');
    expect(out.map(([, text]) => text).join('')).toBe(page);
    // A run of one class is one span, so a closing tag and its `>` are one.
    expect(tagged(page, 'markup')).toEqual(expect.arrayContaining(['<!doctype html>', '<section', '<input', '/>', '<Button', '</Button>', '</section>']));
    expect(out).toContainEqual(['tok-com', '<!-- the list -->']);
    expect(out).toContainEqual(['tok-attr', 'type']);
  });

  it('leaves a comparison in a page’s script a comparison', () => {
    expect(tagged('<script>\nfor (let i=0; i<n; i++) total += i;\nif (a < b) go();\n</script>', 'markup')).toEqual(['<script>', '</script>']);
  });

  it('reads a comment that never closes to the end, once', () => {
    const page = `<p>start</p>\n${'<!-- open '.repeat(20_000)}`;
    const out = tokens(page, 'markup');
    expect(out.map(([, text]) => text).join('')).toBe(page);
    expect(out[out.length - 1][0]).toBe('tok-com');
  });
});

describe('logic', () => {
  it('finds no tag in a loop’s comparison', () => {
    expect(tagged('for (let i=0; i<n; i++) { total += i }', 'softn')).toEqual([]);
  });

  it('finds no tag in the landing page’s logic sample', () => {
    const logic = SAMPLES.find((s) => s.file.endsWith('.logic'))!;
    expect(languageOf(logic.file)).toBe('softn');
    expect(tagged(logic.source, languageOf(logic.file))).toEqual([]);
  });
});
