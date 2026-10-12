/**
 * NavItem's `variant`, which it took and ignored: every item was drawn the
 * default way.
 *
 *  - default: muted until it is the current page, which is filled with the
 *    primary colour (as before);
 *  - ghost: never filled; the current page is shown by a light wash and full
 *    text colour, for a navigation that should not shout;
 *  - primary: filled with the primary colour whether current or not, for an
 *    item that is an action ("New project") in a list of places.
 */

import { describe, expect, it } from 'vitest';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { mount } from './dom';
import { builtinComponents } from '../src/registry';

const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

function item(attributes: string) {
  const doc = parse(`<NavItem label="Home" ${attributes} />`);
  expect(doc.diagnostics ?? []).toEqual([]);
  const context = { state: {}, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;
  const view = mount(<>{renderDocument(doc, context, registry)}</>);
  const button = view.container.querySelector('button')!;
  return { button, view };
}

const PRIMARY = /var\(--color-primary\b/;

describe('NavItem variants', () => {
  it('default: muted, and filled with the primary colour when it is the current page', () => {
    const idle = item('');
    expect(idle.button.style.background).toBe('transparent');
    idle.view.unmount();
    const current = item('active');
    expect(current.button.style.background).toMatch(PRIMARY);
    expect(current.button.getAttribute('aria-current')).toBe('page');
    current.view.unmount();
  });

  it('ghost: never filled; the current page has a wash and full text colour', () => {
    const idle = item('variant="ghost"');
    expect(idle.button.style.background).toBe('transparent');
    idle.view.unmount();
    const current = item('variant="ghost" active');
    expect(current.button.style.background).not.toMatch(PRIMARY);
    expect(current.button.style.background).not.toBe('transparent');
    expect(current.button.style.color).toMatch(/var\(--color-text\b/);
    expect(current.button.getAttribute('aria-current')).toBe('page');
    current.view.unmount();
  });

  it('primary: filled with the primary colour, current or not, in its text colour', () => {
    for (const attributes of ['variant="primary"', 'variant="primary" active']) {
      const { button, view } = item(attributes);
      expect(button.style.background).toMatch(PRIMARY);
      expect(button.style.color).toMatch(/var\(--color-primary-text\b/);
      expect(button.className).toContain('softn-nav-item--primary');
      view.unmount();
    }
  });

  it('keeps hover from washing out a primary item', () => {
    const { button, view } = item('variant="primary"');
    const rules = Array.from(view.container.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
    expect(rules).toMatch(/\.softn-nav-item:hover:not\(\.active\):not\(\.softn-nav-item--primary\)/);
    expect(button.className).toContain('softn-nav-item--primary');
    view.unmount();
  });
});
