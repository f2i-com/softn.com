/**
 * MarkdownEditor preview regressions.
 *
 * The preview goes through `dangerouslySetInnerHTML`, and preview content
 * routinely arrives from XDB or sync rather than from the person reading it.
 *
 * Assertions query the rendered elements rather than the container's HTML: the
 * source textarea is still in the DOM in preview mode (just `display: none`),
 * so a string search would match the raw markdown and prove nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from './dom';
import { MarkdownEditor } from '../src/editors/MarkdownEditor';

beforeEach(() => {
  document.body.innerHTML = '';
});

function render(markdown: string): HTMLElement {
  return mount(<MarkdownEditor value={markdown} viewMode="preview" />).container;
}

describe('link targets', () => {
  it('cannot break out of the href attribute', () => {
    // The up-front escape covers & < > but not the quote, and the target went
    // straight into href="…" — so this closed the attribute and opened an
    // event handler on the host page.
    const link = render('[x](" onmouseover="alert(1))').querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('onmouseover')).toBeNull();
    expect(link!.attributes.length).toBeLessThanOrEqual(3); // href, target, rel
  });

  it('rejects javascript: targets', () => {
    const link = render('[go](javascript:alert(1))').querySelector('a');
    expect(link!.getAttribute('href')).not.toMatch(/javascript:/i);
  });

  it('keeps ordinary links working', () => {
    const link = render('[docs](https://example.com/a)').querySelector('a');
    expect(link!.getAttribute('href')).toBe('https://example.com/a');
    expect(link!.textContent).toBe('docs');
  });

  it('keeps relative links', () => {
    const link = render('[home](/index.html)').querySelector('a');
    expect(link!.getAttribute('href')).toBe('/index.html');
  });
});

describe('images', () => {
  it('render as images rather than links', () => {
    // The link rule ran first and `![alt](url)` also matches it, so every
    // image came out as the literal text `!` followed by an anchor.
    const container = render('![Logo](/logo.png)');
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/logo.png');
    expect(img!.getAttribute('alt')).toBe('Logo');
  });

  it('escape their alt text', () => {
    const img = render('![" onerror="alert(1)](/logo.png)').querySelector('img');
    expect(img!.getAttribute('onerror')).toBeNull();
  });

  it('reject javascript: sources', () => {
    const img = render('![x](javascript:alert(1))').querySelector('img');
    expect(img!.getAttribute('src')).not.toMatch(/javascript:/i);
  });
});
