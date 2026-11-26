/**
 * A keystroke in the picked element's form read the whole page five times:
 * the form reads the element, the change is checked against the page before
 * and after it, and the pane and the form read the element again in the
 * changed page. On a page of 42 KB that was 22 ms a keystroke here. A text is
 * read once while it is in use now (5.7 ms), and what is read is the same.
 */
import { describe, expect, it, vi } from 'vitest';

const parsed: string[] = [];
vi.mock('@softn/core', async (original) => {
  const core = await original<typeof import('@softn/core')>();
  return {
    ...core,
    parse: (text: string) => {
      parsed.push(text);
      return core.parse(text);
    },
  };
});

import { readElement, withAttribute, withText } from '../src/edit/sourceEdits';

const PAGE = '<div class="page">\n  <h1 id="title">Notes</h1>\n  <p class="foot" title="end">The end</p>\n</div>\n';

describe('the page, read for a change made from the picked element’s form', () => {
  it('is read once for each text, and reads the same', () => {
    const nameStart = PAGE.indexOf('<p ') + 1;
    let text = PAGE;
    for (const words of ['The end!', 'Fin', 'Done now']) {
      parsed.length = 0;
      // As one keystroke goes: the form draws, the change is written, and the pane and the form draw again.
      const element = readElement(text, nameStart)!;
      const next = withText(text, element, words)!;
      expect(readElement(next, nameStart)?.text?.value).toBe(words);
      expect(readElement(next, nameStart)?.text?.value).toBe(words);
      // The page as it was is the text read for the keystroke before.
      expect(parsed.filter((read) => read === next)).toHaveLength(1);
      expect(parsed.filter((read) => read === text).length).toBeLessThanOrEqual(1);
      text = next;
    }
    parsed.length = 0;
    const element = readElement(text, nameStart)!;
    const titled = withAttribute(text, element, 'title', 'the finish')!;
    expect(readElement(titled, nameStart)?.attributes.find((attribute) => attribute.name === 'title')?.value).toBe('the finish');
    expect(parsed).toEqual([titled]);
    expect(titled).toBe(text.replace('title="end"', 'title="the finish"'));
  });
});
