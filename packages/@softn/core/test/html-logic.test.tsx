/**
 * Logic written as browser code is written.
 *
 * A page written as HTML comes with code written the way a `.js` file is:
 * `export function send(e) { e.preventDefault(); … e.target.value … }`,
 * called from `<form onsubmit="send(event)">`. Each part of that failed: the
 * `export` kept the app from opening, the record a logic function is given
 * for an event had no `target` and no `preventDefault`, so the handler threw
 * at its first line, and the form, which nothing kept from submitting,
 * reloaded the page and the app with it.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { composeBundleSource } from '../src/bundle/source-composer';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import { moduleSyntaxAsScript } from '../src/runtime/module-syntax';
import { sanitizeArgs } from '../src/runtime/vm-args';
import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';
import { HostJsAdapter } from '../src/runtime/host-js';
import type { SoftNRenderContext } from '../src/types';

describe('logic written as a module', () => {
  it('is read as the script it is', () => {
    const written = [
      'import { total, tax } from "./cart.js";',
      "import { helper } from '../lib/helpers.js'",
      'export function save() {}',
      'export async function load() {}',
      'export const LIMIT = 3',
      'export let count = 0',
      'export class Cart {}',
      'export default function main() {}',
      '  export { save, load };',
      'export default main',
      'export { pick } from "./pick.js"',
    ].join('\n');
    expect(moduleSyntaxAsScript(written).split('\n')).toEqual([
      'import "./cart.js"',
      "import '../lib/helpers.js'",
      'function save() {}',
      'async function load() {}',
      'const LIMIT = 3',
      'let count = 0',
      'class Cart {}',
      'function main() {}',
      '  ',
      '',
      'import "./pick.js"',
    ]);
  });

  it('leaves what would mean something else as written', () => {
    for (const line of [
      'import { total as sum } from "./cart.js"',
      'import cart from "./cart.js"',
      'import * as cart from "./cart.js"',
      'import { debounce } from "lodash"',
      'export default function () {}',
      'const text = "export function"',
      'import "./cart.js"',
    ]) {
      expect(moduleSyntaxAsScript(line)).toBe(line);
    }
  });

  it('is placed by the bundle composer like any other logic file', () => {
    const composed = composeBundleSource(
      new Map(
        Object.entries({
          'index.html': '<script src="js/main.js"></script><p>{count}</p>',
          'js/main.js': 'import { total } from "./cart.js"\nexport let count = total()',
          'js/cart.js': 'export function total() { return 2 }',
        })
      ),
      'index.html'
    );
    expect(parse(composed.source).logic?.code).toBe('import "js/cart.js"\nlet count = total()');
  });
});

describe('the record a logic function is given for an event', () => {
  it('has the element the event happened on, as data, and whether it was cancelled', () => {
    const form = document.createElement('form');
    const field = document.createElement('input');
    field.name = 'title';
    field.value = 'Dune';
    field.dataset.id = '7';
    form.appendChild(field);
    const native = new Event('input', { bubbles: true });
    const [record] = sanitizeArgs([{ nativeEvent: native, target: field, currentTarget: form }]) as Array<
      Record<string, unknown>
    >;
    expect(record.type).toBe('input');
    expect(record.defaultPrevented).toBe(false);
    expect(record.target).toMatchObject({ tagName: 'INPUT', name: 'title', value: 'Dune', dataset: { id: '7' } });
    expect(record.currentTarget).toMatchObject({ tagName: 'FORM' });
  });

  it('describes no element outside the one the handler is on', () => {
    const outside = document.createElement('input');
    outside.value = 'the host’s own field';
    const [onWindow] = sanitizeArgs([{ nativeEvent: new Event('keydown'), target: outside, currentTarget: window }]) as Array<
      Record<string, unknown>
    >;
    expect(onWindow.target).toBeNull();
    const [elsewhere] = sanitizeArgs([
      { nativeEvent: new Event('click'), target: outside, currentTarget: document.createElement('div') },
    ]) as Array<Record<string, unknown>>;
    expect(elsewhere.target).toBeNull();
  });

  const SCRIPT = `
function send(e) {
  e.preventDefault();
  e.stopPropagation();
  return [e.target.value, Object.keys(e).indexOf("preventDefault"), JSON.stringify(e).indexOf("preventDefault")];
}
const pick = (e) => { e.preventDefault(); return e.target.checked };
async function later(e) { e.preventDefault(); return 1 }
function plain(record) { return typeof record.preventDefault }
`;
  const event = {
    type: 'submit',
    defaultPrevented: false,
    target: { tagName: 'INPUT', value: 'Dune', checked: true, dataset: {} },
    currentTarget: null,
  };

  it('can be cancelled in ZIPP, where cancelling does nothing, and keeps its data as it was', async () => {
    const engine = await ZippWasmAdapter.create();
    await engine.initializeScript(SCRIPT);
    expect(engine.callFunction('send', [event])).toEqual(['Dune', -1, -1]);
    expect(engine.callFunction('pick', [event])).toBe(true);
    expect(() => engine.callFunction('later', [event])).not.toThrow();
    // Data that is not an event is not given an event's methods.
    expect(engine.callFunction('plain', [{ type: 'book' }])).toBe('undefined');
    engine.dispose();
  });

  it('is given to logic whose comments read like declarations', async () => {
    // "function for (each) row" in a comment once named `for`, and the entry
    // written for it, `typeof for`, kept the whole script from compiling.
    const engine = await ZippWasmAdapter.create();
    await engine.initializeScript('// wrap the function for (each) row, and the function if (any) is async\n' + SCRIPT);
    expect(engine.callFunction('send', [event])).toEqual(['Dune', -1, -1]);
    engine.dispose();
  });

  it('can be cancelled in the page’s own JavaScript too', async () => {
    const engine = await HostJsAdapter.create();
    await engine.initializeScript(SCRIPT);
    expect(engine.callFunction('send', [event])).toEqual(['Dune', -1, -1]);
    expect(engine.callFunction('plain', [{ type: 'book' }])).toBe('undefined');
    engine.dispose();
  });
});

describe('a form with nowhere to send what it holds', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function mount(source: string, functions: Record<string, (...args: unknown[]) => unknown>): HTMLDivElement {
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    const context = {
      state: {},
      setState: () => {},
      data: {},
      props: {},
      functions,
      asyncFunctions: {},
      computed: {},
    } as SoftNRenderContext;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(React.Fragment, null, renderDocument(doc, context, new ComponentRegistry()))));
    return container;
  }

  const submit = (form: HTMLFormElement): Event => {
    const event = new Event('submit', { bubbles: true, cancelable: true });
    act(() => {
      form.dispatchEvent(event);
    });
    return event;
  };

  it('keeps its page when submitted, and its handler still runs', () => {
    const send = vi.fn();
    const page = mount(
      '<form id="a" onsubmit="send(event)"><input name="x"></form><form id="b"><button>Go</button></form>' +
        '<form id="c" action="/search"></form><dialog open><form id="d" method="dialog"></form></dialog>',
      { send }
    );
    expect(submit(page.querySelector<HTMLFormElement>('#a')!).defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(submit(page.querySelector<HTMLFormElement>('#b')!).defaultPrevented).toBe(true);
    // A form that names where it goes, or closes a dialog, does that.
    expect(submit(page.querySelector<HTMLFormElement>('#c')!).defaultPrevented).toBe(false);
    expect(submit(page.querySelector<HTMLFormElement>('#d')!).defaultPrevented).toBe(false);
  });
});
