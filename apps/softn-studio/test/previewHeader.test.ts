/**
 * The preview's header keeps the name of the file it is showing.
 *
 * The header is one row: the file's name, "Running", then the device switch,
 * the Preview | Code switch and three buttons. The name was the only part
 * allowed to shrink, and it shrank to nothing: at 900 pixels wide it was 0
 * pixels, with not even the dots of its ellipsis, and the header said
 * "Desktop, Running" of a file it did not name. The name keeps a width its
 * ellipsis can stand in, and in a narrow frame the device switch goes.
 *
 * jsdom lays nothing out, so this holds the rules; the widths (0 before, and
 * after) are measured in Chromium at 900, 1024 and 1440.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles/editor.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`));
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries(body.split(';').map((d) => d.split(':').map((part) => part.trim())).filter((d) => d.length === 2 && d[0]));
}

describe('the preview header’s file name', () => {
  it('keeps a width of its own, and still ends in an ellipsis when it is cut', () => {
    const file = rule('.st-preview-file');
    expect(file['text-overflow']).toBe('ellipsis');
    expect(file.overflow).toBe('hidden');
    expect(parseFloat(file['min-width'])).toBeGreaterThanOrEqual(3);
    expect(file['min-width']).toMatch(/rem$/);
  });

  // The device switch used to go whole in a narrow frame, to leave the name its room: with a
  // panel open beside the preview there was then no way to choose a width. Its words go now and
  // its three pictures stay, and no rule of the header's takes a control away.
  it('is shown without its folder where the frame is narrow, beside a device switch that keeps its three choices', () => {
    expect(rule('.st-preview-chrome').container).toBe('preview-header / inline-size');
    const queries = [...css.matchAll(/@container preview-header \(max-width: [\d.]+rem\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0]).toMatch(/\.st-preview-chrome \.st-device-switch \.st-switch-label,\s*\.st-preview-file \.dir \{\s*display: none;/);
    // What a narrow header hides is words (a label, the folder), never a switch or a button.
    for (const query of queries) {
      for (const [, selectors, body] of query.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (!/display:\s*none/.test(body)) continue;
        for (const selector of selectors.split(',').map((s) => s.trim())) {
          expect(selector, 'hidden in a narrow header').toMatch(/\.st-switch-label$|\.dir$/);
        }
      }
    }
  });

  it('goes over its controls, on a row of its own, before any of them is cut', () => {
    const rules = [...css.matchAll(/(^|\n)\.st-preview-chrome \{([^}]*)\}/g)].map((match) => match[2]).join('\n');
    expect(rules).toMatch(/flex-wrap:\s*wrap/);
  });
});
