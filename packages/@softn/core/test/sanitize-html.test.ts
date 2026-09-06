/**
 * Markup sanitization for the components that inject HTML directly.
 *
 * `<Icon svg={…}>` and `<RichTextEditor value={…}>` both take a string and hand
 * it to the DOM. Those strings normally come from a record in XDB or off the
 * sync socket, so they routed around the renderer's tag denylist entirely.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeSvg,
  sanitizeRichText,
  isSafeUrl,
  cssResourceReferences,
} from '../src/renderer/sanitize-html';
import { markupUrlJudge } from '../src/runtime/egress-policy';

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

/**
 * A safe scheme is still a request to somebody's server. Rich text and SVG
 * arrive as strings, never as a URL prop the renderer could judge, so the
 * sanitizer takes the same judge the renderer applies.
 */
describe("a judge from the bundle's permission", () => {
  const REMOTE = 'https://attacker.example/beacon';
  const pending = markupUrlJudge({ consentPending: true, permissions: { net: { enabled: true } } });
  const noNet = markupUrlJudge({ permissions: {} });
  const scoped = markupUrlJudge({
    permissions: { net: { enabled: true, allowed_hosts: ['cdn.example'] } },
  });

  it('withholds a remote image while consent is pending, and keeps a local one', () => {
    const out = sanitizeRichText(`<img src="${REMOTE}"><img src="/a.png">`, pending);
    expect(out).not.toContain('attacker.example');
    expect(out).toContain('/a.png');
  });

  it('refuses it outright for a bundle that declares no net', () => {
    expect(sanitizeRichText(`<img src="${REMOTE}">`, noNet)).not.toContain('attacker.example');
    expect(sanitizeRichText(`<img srcset="/a.png 1x, ${REMOTE} 2x">`, noNet)).not.toContain(
      'attacker.example'
    );
  });

  it('holds it to the allowed hosts once net is granted', () => {
    expect(sanitizeRichText(`<img src="${REMOTE}">`, scoped)).not.toContain('attacker.example');
    expect(sanitizeRichText('<img src="https://cdn.example/a.png">', scoped)).toContain(
      'cdn.example'
    );
  });

  it('lets a link through once consent is answered, and withholds it while pending', () => {
    expect(sanitizeRichText('<a href="https://example.com">x</a>', noNet)).toContain(
      'https://example.com'
    );
    expect(sanitizeRichText('<a href="https://example.com">x</a>', pending)).not.toContain(
      'https://example.com'
    );
  });

  it('judges an SVG use reference as a fetch, not a link', () => {
    expect(sanitizeSvg(`<svg><use href="${REMOTE}#i"/></svg>`, noNet)).not.toContain(
      'attacker.example'
    );
    expect(sanitizeSvg('<svg><use href="#i"/></svg>', noNet)).toContain('href="#i"');
  });

  it('is not needed for the scheme check, which stands on its own', () => {
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>', noNet)).not.toContain(
      'javascript:'
    );
  });
});

describe('a style that loads something', () => {
  const REMOTE = 'https://attacker.example/beacon';

  it('is dropped whatever spelling the fetch uses', () => {
    for (const style of [
      `background:url(${REMOTE})`,
      `background:URL(${REMOTE})`,
      `background:IMAGE-SET("${REMOTE}" 1x)`,
      `background:\\75rl(${REMOTE})`,
      `background:u/**/rl(${REMOTE})`,
    ]) {
      expect(sanitizeRichText(`<p style='${style}'>x</p>`), style).not.toContain(
        'attacker.example'
      );
    }
  });

  it('leaves a style that loads nothing alone', () => {
    expect(sanitizeRichText('<p style="color:red">x</p>')).toContain('color:red');
  });
});

describe('cssResourceReferences', () => {
  it('finds every spelling of a fetch', () => {
    expect(cssResourceReferences('url(a.png)').urls).toEqual(['a.png']);
    expect(cssResourceReferences('URL( "a.png" )').urls).toEqual(['a.png']);
    expect(cssResourceReferences('image-set("a.png" 1x, "b.png" 2x)').urls).toEqual([
      'a.png',
      'b.png',
    ]);
    expect(cssResourceReferences('image-set(url(a.png) 1x)').urls).toEqual(['a.png']);
    expect(cssResourceReferences('u/**/rl(a.png)').urls).toEqual(['a.png']);
    expect(cssResourceReferences('url("a?x=(1)")').urls).toEqual(['a?x=(1)']);
    expect(cssResourceReferences('src("f.woff2") format("woff2")').urls).toEqual(['f.woff2']);
  });

  it('is opaque about escapes and a function that never closes', () => {
    expect(cssResourceReferences('\\75rl(a.png)').opaque).toBe(true);
    expect(cssResourceReferences('url("https://x').opaque).toBe(true);
    expect(cssResourceReferences('color: red')).toEqual({ urls: [], opaque: false });
  });
});
