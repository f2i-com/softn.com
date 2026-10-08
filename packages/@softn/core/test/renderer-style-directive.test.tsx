/**
 * `style:property={value}`: one style property from one expression, beside
 * the `class:name={condition}` that already toggles one class.
 *
 * Without it a single dynamic property meant writing the whole object —
 * `style={{ color: accent }}` — and losing whatever a `style="…"` string on
 * the same tag said. The directive lands in the same `style` the renderer
 * already checks, so a remote `url()` written this way is withheld exactly
 * as it is in a style object.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNRenderContext, SoftNProps } from '../src/types';

function html(
  source: string,
  state: Record<string, unknown> = {},
  overrides: Partial<SoftNRenderContext> = {}
): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? []).toEqual([]);
  const registry = new ComponentRegistry();
  registry.register('Box', ({ style, className, children }: SoftNProps) =>
    React.createElement(
      'div',
      { style: style as React.CSSProperties, className: className as string },
      children as React.ReactNode
    )
  );
  const context: SoftNRenderContext = {
    state,
    setState: () => {},
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
    ...overrides,
  };
  return renderToStaticMarkup(renderDocument(doc, context, registry) as React.ReactElement);
}

describe('style: on a tag', () => {
  it('sets the property from an expression', () => {
    expect(html('<div style:color={accent}>x</div>', { accent: 'tomato' })).toBe(
      '<div style="color:tomato">x</div>'
    );
  });

  it('takes a quoted value and a bare number', () => {
    expect(html('<div style:color="red" style:opacity=0.5>x</div>')).toBe(
      '<div style="color:red;opacity:0.5">x</div>'
    );
  });

  it('spells a hyphenated property the way React does', () => {
    expect(html('<div style:font-size={size} style:background-color="navy">x</div>', { size: '2rem' })).toBe(
      '<div style="font-size:2rem;background-color:navy">x</div>'
    );
  });

  it('gives a length in pixels for a number, as a style object does', () => {
    expect(html('<div style:width={w} style:line-height={lh}>x</div>', { w: 120, lh: 1.5 })).toBe(
      '<div style="width:120px;line-height:1.5">x</div>'
    );
  });

  it('sets a custom property', () => {
    expect(html('<div style:--accent={accent}>x</div>', { accent: '#f60' })).toBe(
      '<div style="--accent:#f60">x</div>'
    );
  });

  it('sets nothing for a value that says nothing', () => {
    // `style:color={error && "red"}` leaves the colour to the stylesheet.
    for (const value of [undefined, null, false, true, '', Number.NaN]) {
      expect(html('<div style:color={c}>x</div>', { c: value })).toBe('<div>x</div>');
    }
    expect(html('<div style:color={error && "red"}>x</div>', { error: false })).toBe('<div>x</div>');
    expect(html('<div style:color={error && "red"}>x</div>', { error: true })).toBe(
      '<div style="color:red">x</div>'
    );
  });
});

describe('style: beside the rest of the style', () => {
  it('adds to a style written as CSS text', () => {
    expect(html('<div style="padding: 8px; color: black" style:color={accent}>x</div>', { accent: 'tomato' })).toBe(
      '<div style="padding:8px;color:tomato">x</div>'
    );
  });

  it('adds to a style object, wherever the attribute is written', () => {
    expect(html('<div style:color={accent} style={{ padding: "8px" }}>x</div>', { accent: 'tomato' })).toBe(
      '<div style="padding:8px;color:tomato">x</div>'
    );
  });

  it('adds to a :style binding', () => {
    expect(html('<div :style={base} style:color="red">x</div>', { base: { margin: 0 } })).toBe(
      '<div style="margin:0;color:red">x</div>'
    );
  });

  it('does not write into the object it was merged with', () => {
    const base = { padding: '8px' };
    html('<div style={base} style:color="red">x</div>', { base });
    expect(base).toEqual({ padding: '8px' });
  });

  it('reaches a component through its style prop', () => {
    expect(html('<Box style:gap={gap} className="row">x</Box>', { gap: '1rem' })).toBe(
      '<div style="gap:1rem" class="row">x</div>'
    );
  });

  it('composes with class: on the same tag', () => {
    expect(html('<div class="card" class:is-active={on} style:color={c}>x</div>', { on: true, c: 'red' })).toBe(
      '<div class="card is-active" style="color:red">x</div>'
    );
    expect(html('<div class="card" class:is-active={on} class:mt-2={on}>x</div>', { on: false })).toBe(
      '<div class="card">x</div>'
    );
  });
});

describe('style: and what the page may fetch', () => {
  const remote = 'url(https://tracker.example/beacon.png)';

  it('withholds a remote url() while consent is pending', () => {
    const out = html('<div style:background-image={bg} style:color="red">x</div>', { bg: remote }, {
      consentPending: true,
    });
    expect(out).toBe('<div style="color:red">x</div>');
  });

  it('withholds one the bundle did not declare, after consent too', () => {
    const declared = { permissions: { net: { enabled: true, allowed_hosts: ['cdn.example'] } } };
    const out = html('<div style:background-image={bg}>x</div>', { bg: remote }, {
      consentPending: false,
      egress: declared,
    });
    expect(out).toBe('<div>x</div>');
    // And lets through the host the same declaration names.
    const allowed = html(
      '<div style:background-image={bg}>x</div>',
      { bg: 'url(https://cdn.example/tile.png)' },
      { consentPending: false, egress: declared }
    );
    expect(allowed).toContain('https://cdn.example/tile.png');
  });

  it('withholds one hidden in a custom property', () => {
    const out = html('<div style:--bg={bg}>x</div>', { bg: remote }, { consentPending: true });
    expect(out).toBe('<div>x</div>');
  });

  it('keeps a url() that is the bundle\'s own', () => {
    const out = html('<div style:background-image={bg}>x</div>', { bg: 'url(blob:softn/1)' }, {
      consentPending: true,
    });
    expect(out).toContain('blob:softn/1');
  });
});
