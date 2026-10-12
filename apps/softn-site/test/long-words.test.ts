/**
 * Text other people wrote cannot make a page wider than the screen.
 *
 * A name, a description, a tag, a comment, a suggested category, a file
 * name, the path in the address: none of it is the site's, and none of it has
 * to contain a space. Measured in Chromium on the built site, with the
 * directory answering with every such text at the longest it keeps and no
 * space in it:
 *
 * - a comment signed with a 40-letter name (anyone can post one, no account)
 *   made the app page's one column 524px wide in a 320px viewport — the
 *   comment box, its Post button, the rating and the side cards ran off the
 *   right edge, where the page does not scroll;
 * - a suggested category with a 32-letter name made the publish form's
 *   "Your name" and "Category" fields 605px wide on the same phone, and the
 *   home page 420px;
 * - a publisher's own long name, description or version notes made their
 *   app's page 8622px wide at 320 and 8683px at 1280, and the update page
 *   4628px; a mistyped address made the not-found page as wide as the path.
 *
 * A layout cannot be measured in jsdom, so this holds the stylesheet to the
 * three rules that fixed it; the measurement itself is a Chromium run.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { declarations }` in the sheet, media rules flattened, with the media query it sits in. */
function rules(): Array<{ selectors: string[]; body: string; media: string }> {
  const out: Array<{ selectors: string[]; body: string; media: string }> = [];
  const walk = (text: string, media: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let close = open + 1;
      while (close < text.length && depth > 0) {
        if (text[close] === '{') depth += 1;
        else if (text[close] === '}') depth -= 1;
        close += 1;
      }
      const body = text.slice(open + 1, close - 1);
      if (head.startsWith('@media')) walk(body, head);
      else if (!head.startsWith('@')) out.push({ selectors: head.split(',').map((s) => s.trim()), body, media });
      i = close;
    }
  };
  walk(css, '');
  return out;
}

const all = rules();
const declares = (selector: string, declaration: RegExp, media?: RegExp): boolean =>
  all.some((r) => r.selectors.includes(selector) && declaration.test(r.body) && (media ? media.test(r.media) : true));

describe('a long word in text the site did not write', () => {
  it('breaks at the end of the line on every page that shows such text', () => {
    for (const page of ['.directory', '.app-page', '.publish']) {
      expect(declares(page, /overflow-wrap:\s*anywhere/), page).toBe(true);
    }
    // The home page shows the same cards, shelf and category pills.
    for (const box of ['.app-card', '.featured-card', '.pill']) {
      expect(declares(box, /overflow-wrap:\s*anywhere/), box).toBe(true);
    }
  });

  it('cannot widen a column: the grids that hold it have tracks that start at nothing', () => {
    const tracks = all.filter((r) => r.selectors.some((s) => ['.app-head', '.app-columns', '.field-row'].includes(s)) && /grid-template-columns/.test(r.body));
    expect(tracks.length).toBeGreaterThanOrEqual(4);
    for (const rule of tracks) {
      const value = /grid-template-columns:\s*([^;]+);/.exec(rule.body)![1];
      // A bare `fr` is `minmax(auto, fr)`: as wide as the widest thing in it.
      expect(value.replace(/minmax\([^)]*\)/g, ''), `${rule.selectors.join(', ')} ${rule.media}`).not.toMatch(/fr/);
    }
  });

  it('cannot widen a field: a select is no wider than its row, whatever its longest option', () => {
    for (const select of ['.field select', '.sort select']) {
      expect(declares(select, /max-width:\s*100%/), select).toBe(true);
    }
  });
});
