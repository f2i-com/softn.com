/**
 * No style object may set a longhand that can be empty after the shorthand
 * that covers it.
 *
 * React writes an undefined style value as `style[name] = ''`, and an empty
 * longhand takes its part back out of a shorthand set before it. Since the
 * first release that drew every `<Stack padding>` with no padding above its
 * content (`padding` then an undefined `paddingTop`), gave `<Grid>` no gap at
 * all (`gap` then undefined `columnGap` and `rowGap`), and left a bordered
 * Accordion open at the top. Nothing here could see it: jsdom and server
 * rendering skip an undefined value, and only a browser clears.
 *
 * So the rule is checked in the source (scripts/style-shorthand-audit.mjs),
 * and the checker itself is held to the shapes it has to catch.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findShorthandConflicts } from '../scripts/style-shorthand-audit.mjs';

describe('style objects in src/', () => {
  it('never let a longhand that may be empty follow its shorthand', () => {
    const conflicts = findShorthandConflicts().map((c) => `${c.file}:${c.line} ${c.longhand} after ${c.shorthand}: ${c.text}`);
    expect(conflicts, 'write the key only when it has a value: ...(x ? { paddingTop: x } : {})').toEqual([]);
  });
});

describe('the audit', () => {
  function audit(source: string) {
    const dir = mkdtempSync(join(tmpdir(), 'softn-style-audit-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'Sample.tsx'), source);
      return findShorthandConflicts(join(dir, 'src')).map((c) => `${c.longhand} after ${c.shorthand}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('catches an optional prop used bare after the shorthand (the Stack case)', () => {
    const found = audit(`
      interface BoxProps { padding?: string; paddingTop?: string }
      export function Box({ padding = 'md', paddingTop }: BoxProps) {
        const style = { padding, paddingTop };
        return style;
      }`);
    expect(found).toEqual(['paddingTop after padding']);
  });

  it('catches a conditional that ends in undefined, a guard, and null (the Grid and Accordion cases)', () => {
    const found = audit(`
      export function Sample(gap: string, columnGap: string | undefined, first: boolean, on: boolean) {
        return [
          { gap, columnGap: columnGap ? columnGap : undefined },
          { border: '1px solid', borderTop: first ? undefined : 'none' },
          { borderRadius: 8, borderTopLeftRadius: on && 8 },
          { margin: 0, marginTop: null },
        ];
      }`);
    expect(found).toEqual([
      'columnGap after gap',
      'borderTop after border',
      'borderTopLeftRadius after borderRadius',
      'marginTop after margin',
    ]);
  });

  it('catches a shorthand that arrived by a spread of an object in the same file (the DatePicker case)', () => {
    const found = audit(`
      const sizes = { sm: { padding: '4px 8px' }, md: { padding: '8px 12px' } };
      const base = { border: '1px solid' };
      export function Sample(size: 'sm' | 'md', clear: boolean, error: boolean) {
        return [
          { ...sizes[size], paddingRight: clear ? '2rem' : undefined },
          { ...base, borderColor: error ? 'red' : undefined },
        ];
      }`);
    expect(found).toEqual(['paddingRight after padding', 'borderColor after border']);
  });

  it('accepts a longhand that always has a value, one written before the shorthand, and one written only when set', () => {
    const found = audit(`
      interface P { padding?: string; paddingTop?: string }
      export function Sample({ padding, paddingTop }: P, title: boolean, tight: boolean) {
        return [
          { padding, paddingTop: title ? '0' : '1rem' },
          { paddingTop, padding },
          { padding, ...(paddingTop ? { paddingTop } : {}) },
          { font: 'inherit', fontSize: tight ? '0.75rem' : '1rem' },
          { borderBottom: tight ? '1px solid' : undefined, backgroundColor: tight ? 'red' : undefined },
        ];
      }`);
    expect(found).toEqual([]);
  });

  it('does not take a required prop, or one with a default, for an empty value', () => {
    const found = audit(`
      interface P { padding: string; paddingTop: string; paddingBottom?: string }
      export function Sample({ padding, paddingTop, paddingBottom = '0' }: P) {
        return { padding, paddingTop, paddingBottom };
      }`);
    expect(found).toEqual([]);
  });
});
