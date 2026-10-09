/**
 * No element's style has a state that takes a longhand away from a
 * shorthand.
 *
 * `{ ...card, ...(picked ? { borderColor } : {}) }` over a `card` that says
 * `border: '1px solid grey'`: when the state ends React clears
 * `borderColor`, and with it the colour the shorthand had set. A browser
 * then draws the border in the colour of the text, so a collection that was
 * no longer picked still looked picked, a palette item that had been
 * dragged lost its border, and the console had an error each time. jsdom
 * keeps the shorthand's text, so no rendering test sees the colour go;
 * only the error is seen there.
 *
 * It was found five times in Builder's own components, one at a time, by
 * the console. So the rule is held in the source, as the components package
 * holds it for the shapes it writes: scripts/style-state-audit.mjs reads
 * the shape Builder writes, a state spread over a base, and the components
 * package's own audit is run over Builder's sources too.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findStateSpreadConflicts } from '../../scripts/style-state-audit.mjs';
import { findShorthandConflicts, findStateConflicts } from '../../../../packages/@softn/components/scripts/style-shorthand-audit.mjs';

const src = fileURLToPath(new URL('..', import.meta.url));

describe('the style objects of Builder’s components', () => {
  it('never spread a state over a base that takes a longhand away from the base’s shorthand', () => {
    const conflicts = findStateSpreadConflicts(src).map((c) => `${c.file}:${c.line} ${c.longhand} over ${c.shorthand}: ${c.text}`);
    expect(conflicts, 'write the base with longhands only: borderWidth, borderStyle, borderColor').toEqual([]);
  });

  it('pass the components package’s audit of an empty longhand after its shorthand, and of two named states', () => {
    const within = findShorthandConflicts(src).map((c) => `${c.file}:${c.line} ${c.longhand} after ${c.shorthand}: ${c.text}`);
    expect(within, 'write the key only when it has a value: ...(x ? { borderColor: x } : {})').toEqual([]);
    const between = findStateConflicts(src).map((c) => `${c.file}:${c.line} ${c.longhand} over ${c.shorthand}: ${c.text}`);
    expect(between).toEqual([]);
  });
});

describe('the audit of a state spread over a base', () => {
  function audit(source: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'softn-builder-style-states-'));
    try {
      writeFileSync(join(dir, 'Sample.tsx'), source);
      return findStateSpreadConflicts(dir).map((c) => `${c.longhand} over ${c.shorthand}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('catches a state named as a member of the styles object (the collection card)', () => {
    const found = audit(`
      const styles: Record<string, React.CSSProperties> = {
        node: { background: 'white', border: '1px solid grey', borderRadius: 10 },
        nodeSelected: { borderColor: 'black', boxShadow: '0 0 0 1px black' },
      };
      export function Sample({ selected }: { selected: boolean }) {
        return <div style={{ ...styles.node, ...(selected ? styles.nodeSelected : {}) }} />;
      }`);
    expect(found).toEqual(['borderColor over border']);
  });

  it('catches states named on their own, each longhand once (the palette item)', () => {
    const found = audit(`
      const item: React.CSSProperties = { padding: 6, border: '1px solid transparent' };
      const hovered: React.CSSProperties = { background: 'grey' };
      const dragging: React.CSSProperties = { opacity: 0.5, borderStyle: 'dashed', borderColor: 'black' };
      export function Sample({ isHovered, isDragging }: { isHovered: boolean; isDragging: boolean }) {
        const style = { ...item, ...(isHovered ? hovered : {}), ...(isDragging ? dragging : {}) };
        return <div style={style} />;
      }`);
    expect(found).toEqual(['borderStyle over border', 'borderColor over border']);
  });

  it('catches a state written in place, and one behind &&', () => {
    const found = audit(`
      const base = { border: '1px solid grey' };
      export function Sample({ on, wide }: { on: boolean; wide: boolean }) {
        return <div style={{ ...base, padding: 4, ...(on ? { borderColor: 'red' } : {}), ...(wide && { paddingLeft: 12 }) }} />;
      }`);
    expect(found).toEqual(['borderColor over border', 'paddingLeft over padding']);
  });

  it('passes a base written with longhands, and a longhand both states set', () => {
    const found = audit(`
      const styles = {
        card: { borderWidth: 1, borderStyle: 'solid', borderColor: 'grey' },
        picked: { borderColor: 'black' },
        plain: { border: '1px solid grey', borderColor: 'grey' },
      };
      const quiet = { borderColor: 'silver' };
      const loud = { borderColor: 'red' };
      export function Sample({ picked, error }: { picked: boolean; error: boolean }) {
        return (
          <>
            <div style={{ ...styles.card, ...(picked ? styles.picked : {}) }} />
            <div style={{ ...styles.plain, ...(picked ? styles.picked : {}) }} />
            <div style={{ border: '1px solid', ...(error ? loud : quiet) }} />
          </>
        );
      }`);
    expect(found).toEqual([]);
  });
});
