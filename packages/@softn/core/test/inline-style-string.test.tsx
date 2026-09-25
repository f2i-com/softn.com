/**
 * `style="…"` written as CSS text, the way HTML spells it.
 *
 * React takes a style object; handed a string it refuses it on a DOM element
 * and, in a component that spreads `style` into its own object, spreads the
 * characters and throws "Failed to set an indexed property" — so an ordinary
 * attribute took down the element. The renderer now turns the text into an
 * object before its style checks, so a string is held to the same remote
 * `url()` rule an object is.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import { inlineStyleObject } from '../src/renderer/inline-style';
import type { SoftNProps, SoftNRenderContext } from '../src/types';

/** Stands in for `<Stack>`: merges the author's style into its own, as the real one does. */
function StubStack(props: SoftNProps): React.ReactElement {
  const own: React.CSSProperties = { display: 'flex' };
  return React.createElement('div', { style: { ...own, ...(props.style as React.CSSProperties) } }, props.children as React.ReactNode);
}

function html(source: string, consentPending = false): string {
  const registry = new ComponentRegistry();
  registry.register('Stack', StubStack);
  const context = { state: {}, setState: () => {}, data: {}, functions: {}, computed: {}, consentPending } as unknown as SoftNRenderContext;
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(parse(source), context, registry)));
}

describe('a style attribute written as CSS text', () => {
  it('styles a raw element', () => {
    expect(html('<div style="color: red; margin-top: 4px">x</div>')).toContain('style="color:red;margin-top:4px"');
  });

  it('styles a component that merges it into its own style, instead of throwing', () => {
    const out = html('<Stack style="gap: 8px; --accent: #f60">x</Stack>');
    expect(out).toContain('display:flex');
    expect(out).toContain('gap:8px');
    expect(out).toContain('--accent:#f60');
  });

  it('is held to the remote url() rule an object is', () => {
    const out = html('<div style="background-image: url(https://attacker.example/b); color: blue">x</div>', true);
    expect(out).not.toContain('attacker.example');
    expect(out).toContain('color:blue');
  });
});

describe('inlineStyleObject', () => {
  it('camelCases names, keeps custom properties and vendor prefixes the way React spells them', () => {
    expect(inlineStyleObject('background-color: red; --gap: 2px; -webkit-mask: none; -ms-flex: 1')).toEqual({
      backgroundColor: 'red',
      '--gap': '2px',
      WebkitMask: 'none',
      msFlex: '1',
    });
  });

  it('keeps a semicolon inside quotes or parentheses as part of the value', () => {
    expect(inlineStyleObject('background: url("a;b.png"); content: \'x;y\'')).toEqual({
      background: 'url("a;b.png")',
      content: "'x;y'",
    });
  });

  it('drops empty, nameless and malformed declarations, and !important', () => {
    expect(inlineStyleObject(';; color: ; : red; 1bad: x; margin: 0 !important;')).toEqual({ margin: '0' });
  });
});
