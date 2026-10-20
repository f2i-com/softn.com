/**
 * Reading a published file costs in proportion to its length.
 *
 * The app page shows a bundle's source highlighted, and the source is the
 * publisher's. A string token is a quote, anything but that quote, and the
 * quote again; when the closing quote is missing the rule reads on to the end
 * of the file before giving up. A file of escaped quotes — `"\"\"\"…` — has
 * a quote every other character and none of them closes, so the rule read
 * the rest of the file from each one: 256 KB of it, the most the directory
 * hands the page for one file, held the tab for 11 to 25 seconds when
 * measured, every time the pane was drawn. A quote that does not close says
 * the same of every quote like it up to where its own reading stopped, so
 * each stretch of the file is now read for a closing quote once.
 *
 * The first three tests time the work, which is the defect: the ceiling is
 * four seconds against a few tens of milliseconds now.
 */

import { describe, expect, it } from 'vitest';
import { highlight, type HighlightLanguage } from '../src/lib/highlight';

const BACKSLASH = String.fromCharCode(92);
/** What the directory sends at most for one file (apps/softn-api/lib/bundle.php, listSource). */
const MOST_TEXT = 256 * 1024;

const tokens = (source: string, language: HighlightLanguage = 'softn'): Array<[string, string]> =>
  highlight(source, language).map((el) => [el.props.className as string, el.props.children as string]);

function timed(source: string, language: HighlightLanguage): number {
  const started = performance.now();
  const out = highlight(source, language);
  const took = performance.now() - started;
  expect(out.map((el) => el.props.children as string).join('')).toBe(source);
  return took;
}

describe('a file of quotes that never close', () => {
  // Read once this takes a few tens of milliseconds; read once per quote it
  // took 25 seconds as markup and 24 as Python on a busy machine.
  it('is read once as markup, not once per quote', () => {
    for (const quote of ['"', "'", '`']) {
      expect(timed((quote + BACKSLASH).repeat(MOST_TEXT / 2), 'softn'), quote).toBeLessThan(4000);
    }
  }, 600_000);

  // Pages are read with the markup rules now (a page's lowercase tags), which
  // share the string rule: the same file there costs the same.
  it('is read once as a page', () => {
    for (const quote of ['"', "'", '`']) {
      expect(timed((quote + BACKSLASH).repeat(MOST_TEXT / 2), 'markup'), quote).toBeLessThan(4000);
    }
    expect(timed('<!doctype '.repeat(MOST_TEXT / 10), 'markup')).toBeLessThan(4000);
  }, 600_000);

  it('is read once as Python, on one long line', () => {
    for (const quote of ['"', "'"]) {
      expect(timed((quote + BACKSLASH).repeat(MOST_TEXT / 2), 'python'), quote).toBeLessThan(4000);
    }
  }, 600_000);

  it('is read once when every quote stops at its own line break', () => {
    // An escaped backslash and then a line break is not a broken escape, and
    // a reader that took it for one would start over at each of these.
    const unit = BACKSLASH + BACKSLASH + '\n' + BACKSLASH + '"';
    expect(timed('"' + unit.repeat(MOST_TEXT / unit.length), 'softn')).toBeLessThan(4000);
  }, 600_000);
});

describe('what counts as a string is unchanged', () => {
  it('still closes a string at the next quote of its kind, escapes aside', () => {
    expect(tokens(`a "b ${BACKSLASH}" c" d`)).toEqual([
      ['tok-expr', 'a '],
      ['tok-str', `"b ${BACKSLASH}" c"`],
      ['tok-expr', ' d'],
    ]);
  });

  it('gives up on a quote that never closes and reads the next kind of quote as before', () => {
    expect(tokens(`"${BACKSLASH}"x 'y' ${BACKSLASH}"`)).toEqual([
      ['tok-expr', `"${BACKSLASH}"x `],
      ['tok-str', "'y'"],
      ['tok-expr', ` ${BACKSLASH}"`],
    ]);
  });

  it('tries again after a backslash at a line end, which stops one string and not the next', () => {
    const source = `"a${BACKSLASH}\nb" "c"`;
    expect(tokens(source)).toEqual([
      ['tok-expr', `"a${BACKSLASH}\nb`],
      ['tok-str', '" "'],
      ['tok-expr', 'c"'],
    ]);
  });

  it('keeps a Python string to its line, and a later line gets its own', () => {
    expect(tokens(`x = "abc${BACKSLASH}"\ny = "ok"`, 'python')).toEqual([
      ['tok-expr', 'x '],
      ['tok-punc', '='],
      ['tok-expr', ` "abc${BACKSLASH}"\ny `],
      ['tok-punc', '='],
      ['tok-expr', ' '],
      ['tok-str', '"ok"'],
    ]);
  });
});
