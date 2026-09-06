/**
 * Bundle CSS sanitization.
 *
 * A `<style>` block in a `.softn` is authored by the bundle, and the result is
 * injected into the host page. Any url() the browser fetches from it is a
 * beacon: it tells the remote host who opened the app and when, without the
 * bundle ever asking for the `net` capability.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeBundleCSS } from '../src/loader/SoftNRenderer';
import { cssResourceReferences, isRemoteUrl } from '../src/renderer/sanitize-html';

describe('remote url() references', () => {
  it('are removed when unquoted', () => {
    expect(sanitizeBundleCSS('background: url(https://evil.test/x)')).not.toContain('evil.test');
  });

  it('are removed when quoted', () => {
    expect(sanitizeBundleCSS('background: url("https://evil.test/x")')).not.toContain('evil.test');
    expect(sanitizeBundleCSS("background: url('https://evil.test/x')")).not.toContain('evil.test');
  });

  it('are removed when the URL contains a closing paren', () => {
    // The single pattern used `[^)]*`, which cannot cross a literal `)`. A
    // perfectly ordinary query string put one inside the quotes, the match
    // failed, and the declaration reached the page untouched.
    expect(sanitizeBundleCSS('background: url("https://evil.test/b?a=(b)")')).not.toContain(
      'evil.test'
    );
    expect(sanitizeBundleCSS("background: url('https://evil.test/b?a=(b)')")).not.toContain(
      'evil.test'
    );
  });

  it('are removed for protocol-relative URLs', () => {
    expect(sanitizeBundleCSS('background: url(//evil.test/x)')).not.toContain('evil.test');
    expect(sanitizeBundleCSS('background: url("//evil.test/x")')).not.toContain('evil.test');
  });

  it('are removed for data: and javascript:', () => {
    expect(sanitizeBundleCSS('background: url("data:text/html,<script>")')).not.toContain('data:');
    expect(sanitizeBundleCSS('background: url("javascript:alert(1)")')).not.toContain(
      'javascript:'
    );
  });

  it('survive an @import in any form', () => {
    expect(sanitizeBundleCSS('@import url("https://evil.test/x.css");')).not.toContain('evil.test');
    expect(sanitizeBundleCSS('@import "https://evil.test/x.css";')).not.toContain('evil.test');
  });

  // CSS does not require whitespace after an at-keyword, and a comment separates
  // tokens just as well. Each of these fetched the stylesheet while the two cases
  // above were passing.
  it('survive an @import with no whitespace after the at-keyword', () => {
    expect(sanitizeBundleCSS('@import"https://evil.test/x.css";')).not.toContain('evil.test');
    expect(sanitizeBundleCSS("@import'https://evil.test/x.css';")).not.toContain('evil.test');
    expect(sanitizeBundleCSS('@IMPORT"https://evil.test/x.css";')).not.toContain('evil.test');
  });

  it('survive an @import separated by a comment', () => {
    expect(sanitizeBundleCSS('@import/**/"https://evil.test/x.css";')).not.toContain('evil.test');
    expect(sanitizeBundleCSS('@import/*x*/url("https://evil.test/x.css");')).not.toContain('evil.test');
  });

  // The word boundary that makes the separator optional must not turn a nonsense
  // at-keyword into a matching @import; the url() pass is what neutralises this.
  it('does not leave a remote url() behind when the at-keyword is glued to url(', () => {
    expect(sanitizeBundleCSS('@importurl("https://evil.test/x.css");')).not.toContain('evil.test');
  });
});

describe('url() references a bundle legitimately uses', () => {
  it('keeps relative paths', () => {
    expect(sanitizeBundleCSS('background: url(fonts/a.woff2)')).toContain('fonts/a.woff2');
    expect(sanitizeBundleCSS('background: url("./img/logo.png")')).toContain('./img/logo.png');
    expect(sanitizeBundleCSS("background: url('/assets/bg.png')")).toContain('/assets/bg.png');
  });

  it('leaves unrelated declarations alone', () => {
    const css = '.a { color: red; display: flex; }';
    expect(sanitizeBundleCSS(css)).toBe(css);
  });

  it('still strips the legacy execution vectors', () => {
    expect(sanitizeBundleCSS('width: expression(alert(1))')).not.toContain('alert');
    expect(sanitizeBundleCSS('-moz-binding: url(x.xml#y);')).not.toContain('-moz-binding:');
    expect(sanitizeBundleCSS('behavior: url(x.htc);')).not.toContain('behavior:');
  });
});

/** The remote targets a browser would still fetch from a run of CSS: none, once sanitized. */
function remoteTargets(css: string): string[] {
  return cssResourceReferences(css).urls.filter(isRemoteUrl);
}

describe('the other spellings of a fetch', () => {
  it('removes the image functions that take their target as a string', () => {
    const out = sanitizeBundleCSS(
      '.a { background-image: image-set("https://evil.test/a.png" 1x, "https://evil.test/b.png" 2x); }'
    );
    expect(out).not.toContain('evil.test');
    expect(out).toContain('background-image: none');
    expect(sanitizeBundleCSS('@font-face { src: src("https://evil.test/f.woff2"); }')).not.toContain(
      'evil.test'
    );
    expect(
      sanitizeBundleCSS(
        '.a { background: cross-fade(url(https://evil.test/a.png) 50%, "https://evil.test/b.png"); }'
      )
    ).not.toContain('evil.test');
  });

  it('keeps the same functions when they point at the bundle', () => {
    expect(
      sanitizeBundleCSS('.a { background-image: image-set("img/a.png" 1x, "img/a@2x.png" 2x); }')
    ).toContain('img/a@2x.png');
  });

  it('matches a function name whatever its case', () => {
    expect(sanitizeBundleCSS('.a { background: URL(https://evil.test/a.png) }')).not.toContain(
      'evil.test'
    );
    expect(
      sanitizeBundleCSS('.a { background: Image-Set("https://evil.test/a.png" 1x) }')
    ).not.toContain('evil.test');
  });

  it('leaves nothing fetchable behind an escaped function name or scheme', () => {
    expect(remoteTargets(sanitizeBundleCSS('.a { background: \\75rl(https://evil.test/a.png) }'))).toEqual([]);
    expect(remoteTargets(sanitizeBundleCSS('.a { background: url(\\68ttps://evil.test/a.png) }'))).toEqual([]);
    expect(
      remoteTargets(sanitizeBundleCSS('.a { background: image-set("\\68ttps://evil.test/a.png" 1x) }'))
    ).toEqual([]);
  });
});
