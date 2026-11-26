/**
 * An app's font or animation named through a custom property (audit round 4).
 *
 * scope-css.ts gives each `@font-face` and `@keyframes` of an app a name of its
 * own, and renames the app's font and animation declarations to match. A
 * custom property was left as written: `:root { --font: "Brand", sans-serif }
 * p { font-family: var(--font) }` asked for "Brand", which no face was called
 * any more, so the app's own font silently did not apply (and the same for an
 * animation held in a variable). A custom property is renamed now where a font
 * or animation declaration reads it, and only there: one nothing reads as a
 * font (`content: var(--label)`) keeps its text.
 */
import { describe, expect, it } from 'vitest';
import { scopeAppCss } from '../src/loader/scope-css';
import { sanitizeBundleCSS } from '../src/loader/SoftNRenderer';

const FACE = '@font-face { font-family: "Brand"; src: url(fonts/brand.woff2) } @keyframes turn { to { rotate: 1turn } } ';

function scoped(css: string) {
  return scopeAppCss(sanitizeBundleCSS(FACE + css), 'a1');
}

describe('a custom property that holds the app’s font or animation', () => {
  it('is renamed where a font or animation declaration reads it', () => {
    const { css } = scoped(
      ':root { --brand-font: "Brand", sans-serif; --spin: turn } p { font-family: var(--brand-font) } .s { animation: var(--spin) 1s linear infinite }'
    );
    expect(css).toContain('--brand-font: "Brand a1", sans-serif');
    expect(css).toContain('--spin: turn-a1');
    // What reads them is as it was.
    expect(css).toContain('font-family: var(--brand-font)');
  });

  it('is followed through the custom properties it is passed on by, and into the font shorthand', () => {
    const { css } = scoped(':root { --base: "Brand"; --heading: var(--base), serif } h1 { font: 700 2rem var(--heading) }');
    expect(css).toContain('--base: "Brand a1"');
    expect(css).toContain('--heading: var(--base), serif');
  });

  it('is renamed where it is the fallback of a custom property that is not set', () => {
    const { css, names } = scoped('p { font-family: var(--brand-font, "Brand") } q { font-family: var(--f,Brand), serif }');
    expect(css).toContain('font-family: var(--brand-font, "Brand a1")');
    expect(css).toContain('font-family: var(--f,"Brand a1"), serif');
    expect(names?.({ fontFamily: 'var(--x, Brand)' })).toEqual({ fontFamily: 'var(--x, "Brand a1")' });
  });

  it('is renamed in an inline style that sets it', () => {
    const { names } = scoped(':root { --brand-font: serif } p { font-family: var(--brand-font) }');
    expect(names?.({ '--brand-font': '"Brand", serif', color: 'red' })).toEqual({ '--brand-font': '"Brand a1", serif', color: 'red' });
  });

  it('is left as written where nothing reads it as a font or an animation', () => {
    const { css, names } = scoped(':root { --label: "Brand"; --font: "Brand" } .x::after { content: var(--label) } p { font-family: var(--font) }');
    expect(css).toContain('--label: "Brand"');
    expect(css).toContain('--font: "Brand a1"');
    expect(names?.({ '--label': '"Brand"' })).toEqual({ '--label': '"Brand"' });
  });

  it('is left alone, as before, in an app that names no font or animation of its own', () => {
    const { css } = scopeAppCss(sanitizeBundleCSS(':root { --font: "Brand" } p { font-family: var(--font) }'), 'a1');
    expect(css).toContain('--font: "Brand"');
  });
});
