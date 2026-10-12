/**
 * A Popover whose trigger a page writes as a component.
 *
 * Its trigger was a prop, and a page can give a prop only text: a Popover
 * opened from a Button or an Icon could not be written in a page at all.
 * Without `trigger`, its first child is the trigger and the rest is what it
 * shows; `trigger="Help"` works as it did.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { mount, click, type Mounted } from './dom';
import { builtinComponents } from '../src/registry';

const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

function page(source: string) {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const context = { state: {}, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;
  view = mount(<>{renderDocument(doc, context, registry)}</>);
  return view.container;
}

function key(target: Element | null, name: string): KeyboardEvent {
  if (!target) throw new Error(`key ${name}: no target`);
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('a Popover whose trigger is a component', () => {
  it('opens from a Button written as its first child, and shows the rest', () => {
    const container = page(`<Popover>
  <Button>Help</Button>
  <Text>What this setting does.</Text>
</Popover>`);
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('Help');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // The Button is the control: it is not wrapped in a second one.
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.textContent).not.toContain('What this setting does.');

    click(button);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toBe('What this setting does.');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(dialog.id);

    act(() => button.focus());
    key(button, 'Escape');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('makes an Icon trigger a button reached and opened from the keyboard', () => {
    const container = page('<Popover><Icon name="info" ariaLabel="About" /><Text>Details</Text></Popover>');
    const trigger = container.querySelector<HTMLElement>('[role="button"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.querySelector('svg'), 'the icon is the trigger').not.toBeNull();
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    act(() => trigger.focus());
    key(trigger, 'Enter');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toBe('Details');
    expect(dialog.querySelector('svg'), 'and not in the popup').toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('still takes its trigger as text, with every child shown in the popup', () => {
    const container = page('<Popover trigger="Help"><Text>One</Text><Text>Two</Text></Popover>');
    const trigger = container.querySelector<HTMLElement>('[role="button"]')!;
    expect(trigger.textContent).toBe('Help');
    click(trigger);
    expect(container.querySelector('[role="dialog"]')?.textContent).toBe('OneTwo');
  });
});
