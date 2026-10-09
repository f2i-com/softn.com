// @vitest-environment jsdom
/**
 * What a field of the property panel writes is what the field says.
 *
 * The model keeps two things about a property: its value, and whether that
 * value is an expression (`open={showModal}`) or text (`title="Hello"`). The
 * panel wrote the first and never the second. So a name typed into a field
 * the panel itself labels as an expression was written as text, and
 * `open="showModal"` is a modal that is always open; text typed over a
 * property that had been an expression kept its braces, and
 * `placeholder={Your name}` does not parse. A checkbox could write `true`
 * and never `false`, so what a component does by default could not be
 * turned off; `disabled={false}` was shown ticked. And a list of records
 * could not be typed into at all: each keystroke was put through
 * `JSON.parse`, which the text the panel had put there itself does not
 * pass, and thrown away.
 *
 * Every field is driven here the way a person drives it, and held to the
 * source it produces.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from '@softn/core';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
import { insertFromPalette } from './ComponentPalette';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { PropertyPanel } from './PropertyPanel';

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

/** Open `source` on the canvas with its first `tag` selected and the panel showing it. */
function open(source: string, tag: string): void {
  const parsed = parseSource(source);
  const element = [...parsed.elements.values()].find((el) => el.componentType === tag)!;
  useCanvasStore.getState().loadState(parsed.elements, parsed.rootId);
  useCanvasStore.getState().selectElement(element.id);
  mount();
}

/** Take `tag` from the palette, as a double-click does, with the panel showing it. */
function drop(tag: string): void {
  insertFromPalette(tag);
  mount();
}

function mount(): void {
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
}

function field<T extends HTMLElement>(name: string): T {
  const label = [...host.querySelectorAll('label')].find((el) => el.textContent === name);
  if (!label) throw new Error(`the panel has no field called ${name}`);
  return document.getElementById(label.htmlFor) as T;
}

function type(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function click(input: HTMLInputElement): void {
  act(() => input.click());
}

function source(): string {
  const canvas = useCanvasStore.getState();
  const text = generateSource(canvas.elements, canvas.rootId!, '');
  // Whatever the panel wrote, the file still reads.
  expect(parse(text).diagnostics ?? [], text).toEqual([]);
  return text;
}

describe('a field the panel calls an expression', () => {
  it('writes what is typed as an expression', () => {
    drop('Modal');
    type(field<HTMLInputElement>('open'), 'showModal');
    expect(source()).toContain('open={showModal}');
    expect(field<HTMLInputElement>('open').value).toBe('showModal');
  });

  it('takes the braces a person puts around it for what they mean', () => {
    drop('Modal');
    type(field<HTMLInputElement>('open'), '{showModal}');
    expect(source()).toContain('open={showModal}');
  });

  it('is not written while it is half typed, and is once it is whole', () => {
    drop('Modal');
    const open = field<HTMLInputElement>('open');
    type(open, 'count >');
    expect(source()).not.toContain('open=');
    // What was typed is still in the field to finish.
    expect(field<HTMLInputElement>('open').value).toBe('count >');
    type(field<HTMLInputElement>('open'), 'count > 0');
    expect(source()).toContain('open={count > 0}');
  });

  it('shows text a file gave it as the text it is, and keeps it text', () => {
    open('<App><Input value="Ada" /></App>', 'Input');
    expect(field<HTMLInputElement>('value').value).toBe('"Ada"');
    type(field<HTMLInputElement>('value'), '"Grace"');
    expect(source()).toContain('value={"Grace"}');
  });

  it('is removed when it is emptied', () => {
    open('<App><Modal open={showModal} title="x" /></App>', 'Modal');
    type(field<HTMLInputElement>('open'), '');
    expect(source()).toContain('<Modal title="x" />');
  });
});

describe('a text field', () => {
  it('shows an expression in its braces and writes text typed over it as text', () => {
    open('<App><Input placeholder={hint} /></App>', 'Input');
    const placeholder = field<HTMLInputElement>('placeholder');
    expect(placeholder.value).toBe('{hint}');
    type(placeholder, 'Your name');
    expect(source()).toContain('placeholder="Your name"');
  });

  it('writes what is typed in braces as an expression', () => {
    open('<App><Input placeholder="Your name" /></App>', 'Input');
    type(field<HTMLInputElement>('placeholder'), '{hint}');
    expect(source()).toContain('placeholder={hint}');
    type(field<HTMLInputElement>('placeholder'), '{user.name || "you"}');
    expect(source()).toContain('placeholder={user.name || "you"}');
  });

  it('keeps braces that hold no expression as the text they are', () => {
    open('<App><Input placeholder="x" /></App>', 'Input');
    type(field<HTMLInputElement>('placeholder'), '{ "walls": [ ... ] }');
    expect(source()).toContain('placeholder="{ &quot;walls&quot;: [ ... ] }"');
  });

  it('removes the property when it is emptied, and leaves an empty one a file has', () => {
    open('<App><Input placeholder="Your name" /><img src="a.png" alt="" /></App>', 'Input');
    type(field<HTMLInputElement>('placeholder'), '');
    const text = source();
    expect(text).toContain('<Input />');
    // An empty alt says the picture is decoration; it is not nothing.
    expect(text).toContain('<img src="a.png" alt="" />');
  });
});

describe('a choice', () => {
  it('shows an expression as one, and a choice made over it is text', () => {
    open('<App><Button variant={kind}>Go</Button></App>', 'Button');
    // The list cannot show an expression; the field is the expression.
    const variant = field<HTMLInputElement | HTMLSelectElement>('variant');
    expect(variant.value).toBe('kind');
    type(variant as HTMLInputElement, '');
    choose(field<HTMLSelectElement>('variant'), 'secondary');
    expect(source()).toContain('<Button variant="secondary">Go</Button>');
  });

  it('back to the default writes no attribute', () => {
    open('<App><Button variant="secondary">Go</Button></App>', 'Button');
    choose(field<HTMLSelectElement>('variant'), '');
    expect(source()).toContain('<Button>Go</Button>');
  });
});

describe('a checkbox', () => {
  it('turns off what a component does unless told not to', () => {
    drop('Modal');
    const box = field<HTMLInputElement>('closeOnEscape');
    // Not written yet, and on: that is what the component does.
    expect(box.checked).toBe(true);
    click(box);
    expect(source()).toContain('closeOnEscape={false}');
    expect(field<HTMLInputElement>('closeOnEscape').checked).toBe(false);
    click(field<HTMLInputElement>('closeOnEscape'));
    expect(source()).not.toContain('closeOnEscape');
  });

  it('turns on what a component leaves off, as a bare attribute', () => {
    open('<App><Button>Go</Button></App>', 'Button');
    const box = field<HTMLInputElement>('disabled');
    expect(box.checked).toBe(false);
    click(box);
    expect(source()).toContain('<Button disabled>Go</Button>');
    click(field<HTMLInputElement>('disabled'));
    expect(source()).toContain('<Button>Go</Button>');
  });

  it('shows {false} as off and {true} as on', () => {
    open('<App><Button disabled={false}>Go</Button></App>', 'Button');
    expect(field<HTMLInputElement>('disabled').checked).toBe(false);
    act(() => root?.unmount());
    open('<App><Button disabled={true}>Go</Button></App>', 'Button');
    expect(field<HTMLInputElement>('disabled').checked).toBe(true);
  });

  it('shows a condition as the expression it is', () => {
    open('<App><Button disabled={!ready}>Go</Button></App>', 'Button');
    expect(field<HTMLInputElement>('disabled').value).toBe('!ready');
    expect(field<HTMLInputElement>('disabled').type).toBe('text');
  });
});

describe('a number', () => {
  it('is written as a number, and an expression in its place is shown as one', () => {
    open('<App><TextArea rows={lines} /></App>', 'TextArea');
    expect(field<HTMLInputElement>('rows').value).toBe('lines');
    act(() => root?.unmount());
    open('<App><TextArea rows={4} /></App>', 'TextArea');
    const rows = field<HTMLInputElement>('rows');
    expect(rows.type).toBe('number');
    expect(rows.value).toBe('4');
    type(rows, '6');
    expect(source()).toContain('<TextArea rows={6} />');
  });
});

describe('a list of records', () => {
  it('can be typed into', () => {
    drop('DescriptionList');
    const items = field<HTMLTextAreaElement>('items');
    expect(items.value).toContain('{ label: "Status", value: "Shipped" }');
    type(items, items.value.replace('Shipped', 'Delivered'));
    expect(source()).toContain('{ label: "Status", value: "Delivered" }');
  });

  it('keeps what is typed while it does not yet read, and writes it when it does', () => {
    drop('Steps');
    const items = field<HTMLTextAreaElement>('items');
    type(items, '["Details", "Review", "Done", ');
    expect(field<HTMLTextAreaElement>('items').value).toBe('["Details", "Review", "Done", ');
    expect(source()).toContain('items={["Details", "Review", "Done"]}');
    type(field<HTMLTextAreaElement>('items'), '["Details", "Review", "Done", "Paid"]');
    expect(source()).toContain('items={["Details", "Review", "Done", "Paid"]}');
  });

  it('may be a name from the logic', () => {
    drop('Steps');
    type(field<HTMLTextAreaElement>('items'), 'checkoutSteps');
    expect(source()).toContain('items={checkoutSteps}');
  });
});

describe('a binding', () => {
  // The field's placeholder was `{expression}`, and what was typed was put
  // between braces as it stood: `{about}`, typed as the field showed, was
  // written `:bind={{about}}`, a record with one key, and half a name was
  // written into the file at every keystroke.
  it('typed in braces is the expression inside them', () => {
    drop('Modal');
    type(field<HTMLInputElement>(':bind'), '{about}');
    expect(source()).toContain(':bind={about}');
    expect(field<HTMLInputElement>(':bind').value).toBe('about');
  });

  it('is not written while it is half typed, and is once it is whole', () => {
    drop('Input');
    type(field<HTMLInputElement>(':bind'), 'form.');
    expect(source()).not.toContain(':bind');
    expect(field<HTMLInputElement>(':bind').value).toBe('form.');
    type(field<HTMLInputElement>(':bind'), 'form.title');
    expect(source()).toContain(':bind={form.title}');
  });

  it('is removed when it is emptied', () => {
    open('<App><Input :bind={title} /></App>', 'Input');
    expect(field<HTMLInputElement>(':bind').value).toBe('title');
    type(field<HTMLInputElement>(':bind'), '');
    expect(source()).toBe('<App>\n  <Input />\n</App>');
  });
});
