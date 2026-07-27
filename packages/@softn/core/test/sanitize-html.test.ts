/**
 * Markup sanitization for the components that inject HTML directly.
 *
 * `<Icon svg={…}>` and `<RichTextEditor value={…}>` both take a string and hand
 * it to the DOM. Those strings normally come from a record in XDB or off the
 * sync socket, so they routed around the renderer's tag denylist entirely.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeSvg, sanitizeRichText, isSafeUrl } from '../src/renderer/sanitize-html';

describe('sanitizeSvg', () => {
  it('keeps ordinary icon markup intact', () => {
    const icon = '<svg viewBox="0 0 24 24"><path d="M2 2 L20 20"/><circle cx="5" cy="5" r="2"/></svg>';
    const out = sanitizeSvg(icon);
    expect(out).toContain('<path');
    expect(out).toContain('<circle');
    expect(out).toContain('viewBox');
  });

  it('removes an img carrying an onerror handler', () => {
    const out = sanitizeSvg('<img src=x onerror="fetch(\'//evil.test\')">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/<img/i);
  });

  it('removes script elements entirely, content and all', () => {
    const out = sanitizeSvg('<svg><script>alert(1)</script><path d="M0 0"/></svg>');
    expect(out).not.toMatch(/alert\(1\)/);
    expect(out).toContain('<path');
  });

  it('strips event handlers from elements it keeps', () => {
    const out = sanitizeSvg('<svg onload="alert(1)"><path d="M0 0" onclick="alert(2)"/></svg>');
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain('<path');
  });

  it('strips javascript: from href and xlink:href', () => {
    const out = sanitizeSvg('<svg><use xlink:href="javascript:alert(1)"/></svg>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it('strips url() from style, which is a beacon', () => {
    const out = sanitizeSvg('<svg><rect style="fill:url(https://evil.test/x)"/></svg>');
    expect(out).not.toMatch(/evil\.test/);
  });

  it('drops a foreignObject wrapper but keeps nothing executable', () => {
    const out = sanitizeSvg('<svg><foreignObject><iframe src="https://evil.test"></iframe></foreignObject></svg>');
    expect(out).not.toMatch(/iframe/i);
    expect(out).not.toMatch(/evil\.test/);
  });
});

describe('sanitizeRichText', () => {
  it('keeps formatting', () => {
    const out = sanitizeRichText('<p>Hello <strong>there</strong> and <em>you</em></p>');
    expect(out).toContain('<strong>there</strong>');
    expect(out).toContain('<em>you</em>');
  });

  it('keeps safe links and images', () => {
    const out = sanitizeRichText('<a href="https://example.com">x</a><img src="/a.png">');
    expect(out).toContain('https://example.com');
    expect(out).toContain('/a.png');
  });

  it('removes scripts and handlers', () => {
    const out = sanitizeRichText('<p onclick="alert(1)">hi</p><script>alert(2)</script>');
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/alert\(2\)/);
    expect(out).toContain('hi');
  });

  it('keeps the text inside a tag it does not allow', () => {
    // Unwrapping rather than deleting: a stray wrapper must not swallow the
    // words the user actually wrote.
    const out = sanitizeRichText('<article>kept</article>');
    expect(out).toContain('kept');
    expect(out).not.toMatch(/<article/i);
  });

  it('strips javascript: links', () => {
    const out = sanitizeRichText('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('click');
  });
});

describe('isSafeUrl', () => {
  it('accepts what apps legitimately use', () => {
    for (const u of [
      'https://example.com',
      'http://192.168.0.2:8080/x',
      '/settings',
      './a.png',
      '#top',
      '?q=1',
      'mailto:a@b.com',
      'tel:+61400000000',
      'blob:http://localhost/abc',
      'data:image/png;base64,AAA',
    ]) {
      expect(isSafeUrl(u), u).toBe(true);
    }
  });

  it('rejects what executes', () => {
    for (const u of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' \tjavascript:alert(1)',
      'java\nscript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(isSafeUrl(u), u).toBe(false);
    }
  });
});
