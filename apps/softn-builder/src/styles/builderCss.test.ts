/**
 * builder.css declares the brand's accents again for the canvas's page, the
 * light pair for a light page and the dark pair for a dark one: the page is
 * the app's, light or dark as the project says and not as the editor is,
 * and the marks Builder draws on it (the outline of what is selected, the
 * line where a drop goes) have to be the pair that shows there. The copies
 * must stay the brand's: an accent changed in tokens.css and not here would
 * draw the canvas's marks in last year's colours.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const builderCss = readFileSync(new URL('./builder.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('../../../../packages/@softn/brand/src/tokens.css', import.meta.url), 'utf8');

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  return css.slice(start, css.indexOf('}', start));
}

function declarations(css: string): Map<string, string> {
  return new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().toLowerCase()]));
}

describe('builder.css', () => {
  it.each([
    ['light', ":root[data-theme='light']"],
    ['dark', ':root'],
  ])('gives a %s page on the canvas the accents exactly as the brand declares them for that side', (side, brand) => {
    const declared = declarations(block(tokensCss, brand));
    const page = declarations(block(builderCss, `[data-builder-page='${side}']`));
    const accents = [...page.keys()].filter((name) => declared.has(name));
    expect(accents.sort()).toEqual(['--coral', '--coral-glow', '--danger', '--mint', '--mint-edge', '--mint-glow', '--mint-glow-soft', '--sand', '--select', '--warn']);
    for (const name of accents) expect(page.get(name), name).toBe(declared.get(name));
    // And one thing of the canvas's own beside them: the ground of a block's header.
    expect([...page.keys()].filter((name) => !declared.has(name))).toEqual(['--block-ground']);
  });

  it('takes the grounds, the text and the lines of the page on the canvas from the colours of the app, not of the editor', () => {
    // The page was paper in both themes, with the editor's light tokens
    // copied onto it: a dark project was dark components on a white sheet.
    const page = declarations(block(builderCss, '[data-builder-page]'));
    for (const name of ['--ink', '--ink-2', '--ink-3', '--paper', '--dim', '--dimmer', '--line', '--line-soft', '--line-strong']) {
      expect(page.get(name), name).toMatch(/var\(--color-(bg|text|text-muted|surface)[,)]/);
    }
    // And nothing of the kind is declared for the frame around it, which is the editor's.
    expect(builderCss).not.toContain('[data-builder-canvas] {');
  });

  it('marks the code editor with focus as the rest of the Builder marks focus: 2px of mint', () => {
    // It was 1px of the strong line, about 1.7:1 against the panel.
    expect(block(builderCss, '#root :focus-visible:not(.bl-code-editor *)')).toMatch(/outline:\s*2px solid var\(--mint\)/);
    expect(block(builderCss, '.bl-code-editor:focus-within')).toMatch(/box-shadow:\s*inset 0 0 0 2px var\(--mint\)/);
  });

  it('keeps coral and mint to their jobs: no class paints an accent as a background', () => {
    // Coral is the language and mint is the machine; a button, a tab or a
    // selected row filled with either is the drift this file was written to end.
    const rules = builderCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/background(-color)?:\s*var\(--(coral|mint)\)/);
  });
});
