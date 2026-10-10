/**
 * The preview's header keeps the name of the file it is showing.
 *
 * The header is one row: the file's name, the device, "Running", then the
 * Preview | Code switch and three buttons. The name was the only part allowed
 * to shrink, and it shrank to nothing: at 900 pixels wide it was 0 pixels,
 * with not even the dots of its ellipsis, and the header said "Desktop,
 * Running" of a file it did not name. The device word gives way first now,
 * and the name keeps a width its ellipsis can stand in.
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

  it('is not what gives way first: the device word is', () => {
    const file = rule('.st-preview-file');
    const tag = rule('.st-preview-tag');
    expect(Number(tag['flex-shrink'])).toBeGreaterThan(Number(file['flex-shrink'] ?? 1));
    expect(parseFloat(tag['min-width'])).toBe(0);
    expect(tag.overflow).toBe('hidden');
  });

  it('is shown without its folder, and without the device word beside it, where the frame is narrow', () => {
    expect(rule('.st-preview-chrome').container).toBe('preview-header / inline-size');
    const narrow = /@container preview-header \(max-width: [\d.]+rem\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(/\.st-preview-tag,\s*\.st-preview-file \.dir \{\s*display: none;/);
  });
});
