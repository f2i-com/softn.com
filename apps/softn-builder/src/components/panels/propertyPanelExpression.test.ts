// @vitest-environment jsdom
/**
 * A field that holds an expression shows what it holds.
 *
 * It was one line of text. New app > Dashboard gives a list whose `data` is
 * three records written as one expression, and the field showed the first
 * thirty characters of it. The field is a box as tall as its text now, one
 * line for `count > 0` and as many as a list takes; what is typed is never
 * laid out again unasked; and text that is not a whole expression yet is
 * kept in the field, not written, and said to be so in words.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from '@softn/core';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
import { applyStarterTemplate } from '../../utils/newProject';
import { sameExpression } from '../../utils/propValues';
import { undoCanvas } from '../../utils/canvasHistory';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useHistoryStore } from '../../stores/historyStore';
import { NOT_WHOLE } from './ExpressionField';
import { PropertyPanel } from './PropertyPanel';

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  useHistoryStore.getState().clear();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const canvas = () => useCanvasStore.getState();

function mount(): void {
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
}

/** Open `source` on the canvas with its first `tag` selected and the panel showing it. */
function open(source: string, tag: string): void {
  const parsed = parseSource(source);
  const element = [...parsed.elements.values()].find((el) => el.componentType === tag)!;
  canvas().loadState(parsed.elements, parsed.rootId);
  canvas().selectElement(element.id);
  mount();
}

/** The Dashboard a new app starts from, with its list selected. */
function dashboardList(): string {
  applyStarterTemplate('dashboard');
  const list = [...canvas().elements.values()].find((el) => el.componentType === 'SmartList')!;
  canvas().selectElement(list.id);
  useHistoryStore.getState().clear();
  mount();
  return list.id;
}

function field(name: string): HTMLTextAreaElement {
  const label = [...host.querySelectorAll('label')].find((el) => el.textContent === name);
  if (!label) throw new Error(`the panel has no field called ${name}`);
  return document.getElementById(label.htmlFor) as HTMLTextAreaElement;
}

function type(box: HTMLTextAreaElement, text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function source(): string {
  const text = generateSource(canvas().elements, canvas().rootId!, '');
  // Whatever the panel wrote, the file still reads.
  expect(parse(text).diagnostics ?? [], text).toEqual([]);
  return text;
}

const layOut = () => host.querySelector<HTMLButtonElement>('[data-action="lay-out"]');
const note = (box: HTMLTextAreaElement) => document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent ?? null;

describe('a long list in an expression field', () => {
  it('is shown whole, in a box that takes its height from the text', () => {
    const id = dashboardList();
    const data = field('data');
    const written = canvas().elements.get(id)!.props.data as string;
    expect(written.length).toBeGreaterThan(120);
    expect(data.tagName).toBe('TEXTAREA');
    // All of it, as it is written: nothing cut short, nothing laid out again.
    expect(data.value).toBe(written);
    expect(data.value).not.toContain('\n');
    // The box grows by the copy of its text its wrapper draws (styles/builder.css, .bl-pp-grow).
    expect(data.parentElement!.className).toBe('bl-pp-grow');
    expect(data.parentElement!.getAttribute('data-value')).toBe(written);
  });

  it('is edited in place, and what is typed is written as it was typed', () => {
    dashboardList();
    const data = field('data');
    const next = data.value.replace('Overdue', 'Paid').replace('}, {', '},\n   {');
    type(data, next);
    expect(field('data').value).toBe(next);
    expect(source()).toContain(`data={${next.split('\n')[0]}`);
    expect(field('data').parentElement!.getAttribute('data-value')).toBe(next);
  });
});

describe('a short expression', () => {
  it('stays one line', () => {
    open('<App><Modal open={count > 0} title="x" /></App>', 'Modal');
    const box = field('open');
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.rows).toBe(1);
    expect(box.value).toBe('count > 0');
    expect(layOut()).toBeNull();
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });

  it('keeps the space typed after it while the field is in use, and writes it without', () => {
    open('<App><Modal title="x" /></App>', 'Modal');
    type(field('open'), 'a');
    // On the way to `a + b`: the space is not taken from under the caret.
    type(field('open'), 'a ');
    expect(field('open').value).toBe('a ');
    expect(source()).toContain('open={a}');
    type(field('open'), 'a +');
    expect(field('open').value).toBe('a +');
    expect(source()).toContain('open={a}');
    type(field('open'), 'a + b');
    expect(source()).toContain('open={a + b}');
    // Left with space at its end, the field shows what was written.
    type(field('open'), 'a + b  ');
    act(() => { field('open').dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(field('open').value).toBe('a + b');
  });
});

describe('text that is not a whole expression yet', () => {
  it('is kept in the field, is not written, and is said to be so in words', () => {
    const id = dashboardList();
    const before = canvas().elements.get(id)!.props.data;
    const half = '[{ title: "Write the brief", status: "Done" }, ';
    type(field('data'), half);

    const data = field('data');
    expect(data.value).toBe(half);
    expect(canvas().elements.get(id)!.props.data).toBe(before);
    expect(useHistoryStore.getState().past).toHaveLength(0);
    expect(data.getAttribute('aria-invalid')).toBe('true');
    // Under the field, not in a tooltip.
    expect(note(data)).toBe(NOT_WHOLE);
    expect(data.getAttribute('title')).toBeNull();
    expect(host.querySelector('[data-expression-pending]')?.textContent).toBe(NOT_WHOLE);
    // Nothing is offered for text that is not written.
    expect(layOut()).toBeNull();

    type(field('data'), `${half}{ title: "Send the invoice", status: "Paid" }]`);
    expect(field('data').getAttribute('aria-invalid')).toBeNull();
    expect(host.querySelector('[data-expression-pending]')).toBeNull();
    expect(source()).toContain('{ title: "Send the invoice", status: "Paid" }]}');
  });

  // The two fields are the same field of the panel, drawn for one element
  // and then the other: what was half typed for the first is the first's.
  it('is not shown in the same field of the next element picked', () => {
    open('<App><Modal title="One" /><Modal title="Two" /></App>', 'Modal');
    type(field('open'), 'count >');
    expect(field('open').value).toBe('count >');
    const second = [...canvas().elements.values()].filter((el) => el.componentType === 'Modal')[1];
    act(() => canvas().selectElement(second.id));
    expect(field('open').value).toBe('');
    expect(field('open').getAttribute('aria-invalid')).toBeNull();
    expect(source()).not.toContain('open=');
  });
});

describe('laying a list out over lines', () => {
  it('is a button, not something done to what was typed, and puts an entry on each line', () => {
    const id = dashboardList();
    const before = canvas().elements.get(id)!.props.data as string;
    const button = layOut();
    expect(button?.textContent).toBe('Lay it out over lines');

    act(() => button!.click());
    const after = canvas().elements.get(id)!.props.data as string;
    expect(after).toBe(
      '[\n  { title: "Write the brief", status: "Done" },\n  { title: "Review the designs", status: "Open" },\n  { title: "Send the invoice", status: "Overdue" }\n]'
    );
    // The same expression, in the field as it is in the element and the file.
    expect(sameExpression(before, after)).toBe(true);
    expect(field('data').value).toBe(after);
    expect(source()).toContain(`data={${after.split('\n')[0]}`);
    // Laid out, it is not offered again.
    expect(layOut()).toBeNull();
    expect(document.activeElement).toBe(field('data'));

    // One step for Undo, which puts the line back as it was.
    expect(useHistoryStore.getState().past).toHaveLength(1);
    act(() => { undoCanvas(); });
    expect(canvas().elements.get(id)!.props.data).toBe(before);
    expect(field('data').value).toBe(before);
  });

  it('is a step of its own, apart from what is typed before and after it', () => {
    const id = dashboardList();
    type(field('data'), field('data').value.replace('Overdue', 'Paid'));
    act(() => layOut()!.click());
    type(field('data'), field('data').value.replace('Paid', 'Sent'));
    expect(useHistoryStore.getState().past).toHaveLength(3);
    act(() => { undoCanvas(); });
    expect(canvas().elements.get(id)!.props.data).toContain('status: "Paid" }\n]');
    act(() => { undoCanvas(); });
    expect(canvas().elements.get(id)!.props.data).toContain('status: "Paid" }]');
  });

  it('is not offered for a short list, for a name, or for a call', () => {
    open('<App><Steps items={["Details", "Review"]} /></App>', 'Steps');
    expect(layOut()).toBeNull();
    type(field('items'), 'checkoutStepsForTheWholeOfTheLongCheckoutThatWeHaveBuilt');
    expect(layOut()).toBeNull();
    type(field('items'), 'steps.filter((step) => step.shown && step.title !== "Hidden one")');
    expect(layOut()).toBeNull();
    // And is for a list long enough to run past the line.
    type(field('items'), '["Details of the order", "Review the order", "Pay for the order", "Done"]');
    expect(layOut()).not.toBeNull();
  });

  it('is offered for a binding as for a property', () => {
    open('<App><Input :class={{ wide: isWide, quiet: !loud, pressed: isPressed && !isDisabled }} /></App>', 'Input');
    const button = layOut();
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(source()).toContain(':class={{\n');
    expect(field(':class').value).toBe('{\n  wide: isWide,\n  quiet: !loud,\n  pressed: isPressed && !isDisabled\n}');
  });
});
