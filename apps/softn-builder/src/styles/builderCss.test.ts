/**
 * builder.css copies the light theme's tokens onto the canvas artboard, which
 * is paper in both themes. The copy must stay the brand's: a token changed
 * in tokens.css and not here would draw the canvas in last year's colours.
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
  it('gives the canvas the light tokens exactly as the brand declares them', () => {
    const light = declarations(block(tokensCss, ":root[data-theme='light']"));
    const canvas = declarations(block(builderCss, '[data-builder-canvas]'));
    const copied = [...canvas.keys()].filter((name) => light.has(name));
    expect(copied.length).toBeGreaterThan(10);
    for (const name of copied) expect(canvas.get(name), name).toBe(light.get(name));
  });

  it('keeps coral and mint to their jobs: no class paints an accent as a background', () => {
    // Coral is the language and mint is the machine; a button, a tab or a
    // selected row filled with either is the drift this file was written to end.
    const rules = builderCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/background(-color)?:\s*var\(--(coral|mint)\)/);
  });
});
