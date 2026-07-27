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
