/**
 * A class given as a list or as a record of conditions.
 *
 * `className={["card", selected && "is-selected"]}` is how a class that
 * depends on something is written wherever React is written, and people
 * write it here. React turns a list into text by joining it with commas and
 * a record by calling it `[object Object]`, so the element came out with
 * `class="card,false"` or `class="[object Object]"`: no error, and none of
 * the classes it was meant to have.
 *
 * A list is its entries that are text, in order; a record is its keys whose
 * values hold; either may hold the other. That is all the element is given,
 * and `class:name={condition}` is added to it as it is to plain text.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNProps, SoftNRenderContext } from '../src/types';

function html(source: string, state: Record<string, unknown> = {}): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const registry = new ComponentRegistry();
  // A component that hands its className on, as the built-in ones do.
  registry.register('Card', (props: SoftNProps) => React.createElement('section', { className: props.className as string }, props.children as React.ReactNode));
  const context = { state, setState: () => {}, data: {}, props: {}, functions: {}, asyncFunctions: {}, computed: {} } as unknown as SoftNRenderContext;
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context, registry)));
}

const state = { on: true, off: false, tone: 'warm', none: null };

describe('a class that is a list', () => {
  it('is its entries that are text', () => {
    expect(html('<div className={["card", on && "is-on", off && "is-off", none, tone]}>x</div>', state)).toBe('<div class="card is-on warm">x</div>');
    expect(html('<div class={["card", on && "is-on"]}>x</div>', state)).toBe('<div class="card is-on">x</div>');
  });

  it('is given to a component as text too', () => {
    expect(html('<Card className={["card", off ? "is-off" : "is-live"]}>x</Card>', state)).toBe('<section class="card is-live">x</section>');
  });

  it('with nothing that holds is no class at all', () => {
    expect(html('<div className={[off && "is-off", none]}>x</div>', state)).toBe('<div>x</div>');
  });
});

describe('a class that is a record', () => {
  it('is its keys whose values hold', () => {
    expect(html('<div className={{ card: true, "is-on": on, "is-off": off, warm: tone === "warm" }}>x</div>', state)).toBe('<div class="card is-on warm">x</div>');
  });

  it('may stand in a list, and a list in a list', () => {
    expect(html('<div className={["card", { "is-on": on, "is-off": off }, ["a", ["b", off && "c"]]]}>x</div>', state)).toBe('<div class="card is-on a b">x</div>');
  });
});

describe('class:name beside a class that is not text', () => {
  it('is added to it', () => {
    expect(html('<div className={["card", on && "is-on"]} class:extra={on} class:never={off}>x</div>', state)).toBe('<div class="card is-on extra">x</div>');
    expect(html('<div class={{ card: true }} class:extra={on}>x</div>', state)).toBe('<div class="card extra">x</div>');
  });
});

describe('a class that is text', () => {
  it('is as it was', () => {
    expect(html('<div className="card  spaced">x</div>')).toBe('<div class="card  spaced">x</div>');
    expect(html('<div className={on ? "a b" : "a"}>x</div>', state)).toBe('<div class="a b">x</div>');
    expect(html('<div className={none}>x</div>', state)).toBe('<div>x</div>');
  });
});
