/**
 * CodeEditor's highlight layer.
 *
 * The highlighted HTML sits under a transparent textarea, so anything the
 * highlighter emits that the user did not type shifts every character after it
 * out of alignment with the caret they are actually moving.
 */

import type React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from './dom';
import { CodeEditor } from '../src/editors/CodeEditor';

beforeEach(() => {
  document.body.innerHTML = '';
});

type Language = React.ComponentProps<typeof CodeEditor>['language'];

/**
 * The text the highlight layer actually displays.
 *
 * Identified as the element holding the colour spans. Reading the whole
 * container would also pick up the line-number gutter and the textarea's own
 * copy of the code, which is what makes a loose selector here misleading
 * rather than merely wrong.
 */
function highlighted(code: string, language: Language = 'javascript'): string {
  const { container } = mount(<CodeEditor value={code} language={language} />);
  const span = container.querySelector('span[style*="color"]');
  const layer = (span?.parentElement as HTMLElement | null) ?? findPlainLayer(container);
  return (layer?.textContent ?? '').replace(/\n$/, '');
}

/**
 * With no patterns for the language there are no spans, so fall back to the
 * last leaf element — the highlight layer sits just before the textarea.
 */
function findPlainLayer(container: HTMLElement): HTMLElement | null {
  const divs = Array.from(container.querySelectorAll<HTMLElement>('div'));
  return divs.filter((d) => d.children.length === 0).pop() ?? null;
}

describe('highlighting code that contains a comment', () => {
  it('does not display the colours it emitted', () => {
    // Patterns were applied one after another over HTML that already contained
    // injected `<span style="color: …">`, so the string pattern matched a
    // colour literal from an earlier pass. The text `"color: #a1a1aa">` became
    // visible in the layer under the textarea, and everything after the first
    // comment sat offset from what the user typed.
    const out = highlighted('// total\nlet x = 1');

    expect(out).not.toMatch(/color:/);
    expect(out).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('shows exactly the code it was given', () => {
    const code = '// total\nlet x = 1';
    expect(highlighted(code).replace(/\s+/g, ' ').trim()).toBe(code.replace(/\s+/g, ' ').trim());
  });

  it('does the same for a block comment', () => {
    const out = highlighted('/* note */\nconst y = "s"');
    expect(out).not.toMatch(/color:/);
  });

  it('does the same for a string containing a slash', () => {
    const out = highlighted('const p = "a//b"');
    expect(out).not.toMatch(/color:/);
    expect(out).toContain('a//b');
  });

  it('still applies colour spans', () => {
    const { container } = mount(<CodeEditor value={'const x = 1'} language="javascript" />);
    expect(container.querySelectorAll('span[style*="color"]').length).toBeGreaterThan(0);
  });

  it('leaves plain text alone', () => {
    expect(highlighted('just words', 'plain').trim()).toBe('just words');
  });
});
