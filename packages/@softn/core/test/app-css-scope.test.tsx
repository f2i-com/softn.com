/**
 * An app's style block styles the app and nothing else (loader/scope-css.ts).
 *
 * A `<style>` applies to the whole document, so a bundle's CSS reached the
 * host's own interface: the permission bar could be hidden or reworded, and
 * the box the host keeps an app's paint in could be undone. These read the
 * scoped CSS as text; e2e/tests/app-isolation.spec.ts reads what a real
 * browser makes of it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { scopeAppCss } from '../src/loader/scope-css';
import { SoftNRenderer, sanitizeBundleCSS } from '../src/loader/SoftNRenderer';
import { cssResourceReferences } from '../src/renderer/sanitize-html';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IN = ':where([data-softn-app="a1"])';
const ROOT = ':where([data-softn-app="a1"] > *)';

function scoped(css: string): string {
  return scopeAppCss(sanitizeBundleCSS(css), 'a1').css;
}

/** The preludes of the top-level rules, as written out: strings and unquoted urls are skipped whole. */
function preludes(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const quote = css[i] === '"' || css[i] === "'" ? css[i] : null;
    if (quote) {
      while (++i < css.length && css[i] !== quote && css[i] !== '\n');
      continue;
    }
    if (/^url\([^"']/i.test(css.slice(i, i + 5))) {
      i = css.indexOf(')', i);
      continue;
    }
    if (css[i] === '{') {
      if (depth === 0) out.push(css.slice(start, i).trim());
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) start = i + 1;
    } else if (css[i] === ';' && depth === 0) start = i + 1;
  }
  return out;
}

describe('an app stylesheet is kept to the app', () => {
  it('puts every selector under the app', () => {
    const css = scoped('.card { color: red } h1, .title > b { margin: 0 }');
    expect(preludes(css)).toEqual([`${IN} .card`, `${IN} h1, ${IN} .title > b`]);
  });

  it('makes html, body and :root the app’s own element', () => {
    const css = scoped(':root { --brand: teal } body { margin: 0 } html body.dark .x { color: red } body > main { padding: 0 }');
    expect(preludes(css)).toEqual([ROOT, ROOT, `${ROOT}.dark .x`, `${ROOT} > main`]);
  });

  it('drops what would be beside the app rather than in it', () => {
    expect(preludes(scoped('body + .x { display: none } :root ~ * { display: none } + .y { color: red } ~ .z { color: red }'))).toEqual([]);
    expect(preludes(scoped('body + .x, .ok { color: red }'))).toEqual([`${IN} .ok`]);
  });

  it('keeps group rules, scoping what is inside them', () => {
    const css = scoped('@media (min-width: 40em) { .a { color: red } @supports (display: grid) { body { display: grid } } } @layer base, app; @layer app { .b { color: blue } }');
    expect(css).toContain(`@media (min-width: 40em) {\n${IN} .a {`);
    expect(css).toContain(`@supports (display: grid) {\n${ROOT} {`);
    expect(css).toContain('@layer base, app;');
    expect(css).toContain(`@layer app {\n${IN} .b {`);
  });

  it('drops at-rules that reach the whole document or choose their own scope', () => {
    const css = scoped(
      '@import "x.css"; @property --c { syntax: "<color>"; inherits: false; initial-value: red } @scope (.consent) { * { display: none } } @page { margin: 0 } @view-transition { navigation: auto } @font-palette-values --p { font-family: X } @unknown-thing { .a { color: red } } .ok { color: red }'
    );
    expect(preludes(css)).toEqual([`${IN} .ok`]);
  });

  it('renames the app’s fonts and animations, and its CSS and inline styles follow', () => {
    const result = scopeAppCss(
      sanitizeBundleCSS(
        '@font-face { font-family: "IBM Plex Sans"; src: url(fonts/plex.woff2) } @keyframes softn-consent-fade-in { to { opacity: 0 } } .a { font-family: "IBM Plex Sans", sans-serif; animation: softn-consent-fade-in 1s } .b { font: 12px/1.2 IBM Plex Sans }'
      ),
      'a1'
    );
    expect(result.css).toContain('font-family:"IBM Plex Sans a1"');
    expect(result.css).toContain('@keyframes softn-consent-fade-in-a1 {');
    expect(result.css).toContain('font-family: "IBM Plex Sans a1", sans-serif');
    expect(result.css).toContain('animation: softn-consent-fade-in-a1 1s');
    expect(result.css).toContain('font: 12px/1.2 "IBM Plex Sans a1"');
    expect(result.names?.({ fontFamily: 'IBM Plex Sans', animationName: 'softn-consent-fade-in', color: 'red' })).toEqual({
      fontFamily: '"IBM Plex Sans a1"',
      animationName: 'softn-consent-fade-in-a1',
      color: 'red',
    });
    // A name the app did not give is left to mean what it meant.
    expect(result.css).not.toContain('sans-serif a1');
  });

  it('reads blocks the way the browser does', () => {
    // An unquoted url is one token: the `{` in it opens nothing, so the rule after it is a rule of its own.
    expect(preludes(scoped('.a { background: url(x{) } .softn-consent-bar { display: none }'))).toEqual([
      `${IN} .a`,
      `${IN} .softn-consent-bar`,
    ]);
    // A `}` in a string, or in an attribute selector, closes nothing.
    expect(preludes(scoped('.a { content: "}" } [title="}"] .b { color: red } .c { color: red }'))).toEqual([
      `${IN} .a`,
      `${IN} [title="}"] .b`,
      `${IN} .c`,
    ]);
    // A newline ends a string that was never closed, and the block goes on.
    expect(preludes(scoped('.a { content: "x\n; color: red } .softn-consent-bar { display: none }'))).toEqual([
      `${IN} .a`,
      `${IN} .softn-consent-bar`,
    ]);
    // A stray `}` or `;` at the top ends nothing that is let through unscoped.
    expect(preludes(scoped('} .softn-consent-bar { display: none } x; .y { color: red }'))).toEqual([
      `${IN} .softn-consent-bar`,
      `${IN} .y`,
    ]);
    // Comments and HTML comment markers.
    expect(preludes(scoped('<!-- .a /* , body */ , .b { color: red } -->'))).toEqual([`${IN} .a, ${IN} .b`]);
    // A block the file never closes is closed.
    expect(scoped('.a { color: red')).toBe(`${IN} .a { color: red}\n`);
  });

  it('keeps nested rules under their parent', () => {
    const css = scoped('.a { color: red; .b { color: blue } &:hover { color: green } }');
    expect(css).toBe(`${IN} .a { color: red; .b { color: blue } &:hover { color: green } }\n`);
  });
});

describe('a URL a custom property fills in is not let through', () => {
  it('treats a resource function fed by var(), attr() or env() as loading something unknown', () => {
    for (const value of ['image-set(var(--u))', 'image-set(var(--u) 1x)', 'src(var(--u))', '-webkit-image-set(attr(data-u))', 'cross-fade(env(x), url(a.png))']) {
      expect(cssResourceReferences(value).opaque).toBe(true);
    }
    expect(cssResourceReferences('var(--bg)').opaque).toBe(false);
    expect(sanitizeBundleCSS('.a { --u: "https://evil.example/x.png"; background-image: image-set(var(--u)) }')).toBe(
      '.a { --u: "https://evil.example/x.png"; background-image: none }'
    );
  });
});

describe('the renderer draws an app inside its own element', () => {
  let root: Root | null = null;
  let container: HTMLElement;
  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container?.remove();
  });

  it('marks the app and writes its style block scoped to it', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const source = '<style>\nbody { margin: 0 }\n.card { color: red }\n</style>\n<div class="card">Hi</div>';
    await act(async () => {
      root!.render(<SoftNRenderer source={source} />);
    });
    for (let i = 0; i < 50 && !container.querySelector('style'); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    const app = container.querySelector('[data-softn-app]') as HTMLElement;
    expect(app).not.toBeNull();
    expect(app.style.display).toBe('contents');
    const name = app.getAttribute('data-softn-app');
    const css = container.querySelector('style')?.textContent ?? '';
    expect(css).toContain(`:where([data-softn-app="${name}"]) .card`);
    expect(css).toContain(`:where([data-softn-app="${name}"] > *)`);
    expect(css).not.toMatch(/(^|\})\s*(body|\.card)\s*\{/);
    expect(app.querySelector('.card')?.textContent).toBe('Hi');
  });
});
