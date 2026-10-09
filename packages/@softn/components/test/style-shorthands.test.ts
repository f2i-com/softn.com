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
import { findShorthandConflicts, findStateConflicts } from '../scripts/style-shorthand-audit.mjs';

describe('style objects in src/', () => {
  it('never let a longhand that may be empty follow its shorthand', () => {
    const conflicts = findShorthandConflicts().map((c) => `${c.file}:${c.line} ${c.longhand} after ${c.shorthand}: ${c.text}`);
    expect(conflicts, 'write the key only when it has a value: ...(x ? { paddingTop: x } : {})').toEqual([]);
  });

  it('never take a longhand away from a shorthand between two states of one element', () => {
    // `isActive ? { ...button, borderColor } : button`: going back, React
    // clears borderColor, and with it the colour `border` had set. A
    // browser then draws the border in the colour of the text. Seen on the
    // page of a Pagination that had just been left.
    const conflicts = findStateConflicts().map((c) => `${c.file}:${c.line} ${c.longhand} over ${c.shorthand}: ${c.text}`);
    expect(conflicts, 'give both states the longhand, or write the base with longhands only').toEqual([]);
  });
});

describe('the audit of two states', () => {
  function audit(source: string) {
    const dir = mkdtempSync(join(tmpdir(), 'softn-style-states-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'Sample.tsx'), source);
      return findStateConflicts(join(dir, 'src')).map((c) => `${c.longhand} over ${c.shorthand}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('catches a state that adds a longhand to what the other state has (the Pagination case)', () => {
    const found = audit(`
      export function Sample(active: boolean) {
        const button = { border: '1px solid grey', padding: 4 };
        const chosen = { ...button, borderColor: 'blue', color: 'white' };
        return <button style={active ? chosen : button} />;
      }`);
    expect(found).toEqual(['borderColor over border']);
  });

  it('catches it whichever branch has the longhand, and through a second spread', () => {
    const found = audit(`
      export function Sample(bad: boolean) {
        const base = { border: '1px solid grey' };
        const input = { ...base, width: '100%' };
        const wrong = { ...input, borderColor: 'red', paddingLeft: 2 };
        return <input style={bad ? input : wrong} />;
      }`);
    expect(found).toEqual(['borderColor over border']);
  });

  it('passes two states that both set the longhand, and a base written in longhands', () => {
    const found = audit(`
      export function Sample(active: boolean) {
        const button = { border: '1px solid grey', borderColor: 'grey' };
        const chosen = { ...button, borderColor: 'blue' };
        const plain = { borderWidth: 1, borderStyle: 'solid', borderColor: 'grey' };
        const marked = { ...plain, borderColor: 'blue' };
        return [<button style={active ? chosen : button} />, <button style={active ? marked : plain} />];
      }`);
    expect(found).toEqual([]);
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
