import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/parser';

describe('hyphenated component attributes', () => {
  it('preserves ARIA and data attributes with quoted and expression values', () => {
    const doc = parse('<button aria-label="Open form" aria-pressed={active === 1} data-form-id="contacts">Open</button>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template[0]).toMatchObject({ props: [
      { name: 'aria-label', value: { type: 'static', value: 'Open form' } },
      { name: 'aria-pressed', value: { type: 'expression' } },
      { name: 'data-form-id', value: { type: 'static', value: 'contacts' } },
    ] });
  });
  it('keeps subtraction in attribute expressions separate from names', () => {
    const doc = parse('<Text data-count={total-used}>{total-used}</Text>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template[0]).toMatchObject({ props: [{ name: 'data-count', value: { type: 'expression', value: { type: 'BinaryExpression', operator: '-' } } }] });
  });
});
