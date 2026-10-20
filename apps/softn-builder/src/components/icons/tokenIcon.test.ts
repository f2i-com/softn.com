/**
 * Every row of the palette shows a glyph for what it adds. 68 of its rows
 * once showed the same clock: the registry named icons (`credit-card`,
 * `bell`, `mic`) that TokenIcon had never drawn, and each fell through to
 * its fallback.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { componentRegistry } from '../../utils/componentRegistry';
import { blockPalette, textNodeMeta } from '../../utils/blocks';
import { getNativeHtmlMeta } from '../../utils/nativeHtmlMetadata';
import { TokenIcon, hasTokenGlyph } from './TokenIcon';

const draw = (token?: string) => renderToStaticMarkup(createElement(TokenIcon, { token }));

/** Every token something on the palette or the canvas names, with who names it. */
function tokensInUse(): Map<string, string[]> {
  const metas = [...componentRegistry, ...blockPalette, textNodeMeta, getNativeHtmlMeta('div'), getNativeHtmlMeta('button')];
  const used = new Map<string, string[]>();
  for (const meta of metas) {
    if (!meta) continue;
    used.set(meta.icon, [...(used.get(meta.icon) ?? []), meta.name]);
  }
  return used;
}

describe('TokenIcon', () => {
  const used = tokensInUse();

  it('has a glyph for every icon the registry, the blocks and native elements name', () => {
    const missing = [...used].filter(([token]) => !hasTokenGlyph(token)).map(([token, names]) => `${token} (${names.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('draws none of them as the fallback, and no two of them alike', () => {
    const fallback = draw('no-such-token');
    const drawn = new Map<string, string>();
    for (const token of used.keys()) {
      const markup = draw(token);
      expect(markup, token).not.toBe(fallback);
      expect(markup).toContain('<svg');
      drawn.set(markup, [drawn.get(markup), token].filter(Boolean).join(' = '));
    }
    const alike = [...drawn.values()].filter((tokens) => tokens.includes(' = '));
    expect(alike).toEqual([]);
  });
});
