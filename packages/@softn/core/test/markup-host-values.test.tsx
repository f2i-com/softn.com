/**
 * Markup never holds a piece of the browser.
 *
 * An expression in a `.ui` file runs in the host page, not in the script VM,
 * and the evaluator reads any member of any value. A handler written in
 * markup was handed the live DOM event, and `e.target.ownerDocument
 * .defaultView` is the page's `window`: from there a bundle a stranger wrote
 * could call anything the page can (`eval`, `fetch`, `localStorage`, a desktop
 * shell's IPC), and `insertAdjacentHTML` or `setAttribute` were one member
 * away without going that far.
 *
 * A handler is now given what a script is given of an event, the plain
 * record, with the few things only a handler can use: `preventDefault()`,
 * `stopPropagation()`, and `target` / `currentTarget` as records of what the
 * element holds. A document, a window and every other node are nothing.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { registerComponent, type SoftNComponent } from '../src/renderer/registry';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reached = () => (globalThis as { __softnReached?: unknown }).__softnReached;

/** A component that hands its page callbacks pieces of the browser, as a careless one might. */
function HostProbe(props: {
  onNode?: (node: unknown) => void;
  onBag?: (bag: unknown) => void;
  onPress?: (direction: string) => void;
  render?: (node: unknown) => unknown;
}) {
  return (
    <div>
      <button id="node" onClick={(e) => props.onNode?.(e.currentTarget)}>node</button>
      <button id="bag" onClick={(e) => props.onBag?.({ event: e, list: [e.currentTarget], doc: document, win: window })}>bag</button>
      <button id="press" onClick={() => props.onPress?.('up')}>press</button>
      <button id="render" onClick={(e) => props.render?.(e.currentTarget)}>render</button>
    </div>
  );
}
registerComponent('HostProbe', HostProbe as unknown as SoftNComponent);

let root: Root | null = null;
let container: HTMLElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  delete (globalThis as { __softnReached?: unknown }).__softnReached;
  vi.restoreAllMocks();
});

const LOGIC = `<logic>
let got = ''
let n = 0
let seen = ''
function add() { n = n + 1 }
function note(ev) { seen = ev === null ? 'null' : Object.keys(ev).sort().join(',') }
function noteTarget(ev) { seen = Object.keys(ev.target).sort().join(',') + '/' + ev.target.tagName + '/' + typeof ev.target.focus }
</logic>`;

async function mount(body: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={`${LOGIC}\n<div>${body}<p id="out">n={n}|{got}|{seen}</p></div>`} appId="markup-host-values" scriptExecutionMode="main" />);
  });
  for (let i = 0; i < 60 && !/^n=/.test(container.querySelector('#out')?.textContent ?? ''); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
}

async function fire(id: string, event?: Event) {
  await act(async () => {
    const el = container.querySelector(`#${id}`) as HTMLElement;
    if (event) el.dispatchEvent(event);
    else el.click();
    await sleep(60);
  });
}

const shown = () => container.querySelector('#out')?.textContent;

const RUN = '"globalThis.__softnReached = 1"';

describe('a handler written in markup cannot reach the page through its event', () => {
  // Each of these ran the string in the host page.
  const ways: Array<[string, string]> = [
    ['the target\'s document', `(e) => e.target.ownerDocument.defaultView.eval(${RUN})`],
    ['the event\'s view', `(e) => e.view.eval(${RUN})`],
    ['the native event\'s view', `(e) => e.nativeEvent.view.eval(${RUN})`],
    ['the root node', `(e) => e.target.getRootNode().defaultView.eval(${RUN})`],
    ['the element it is on', `(e) => e.currentTarget.ownerDocument.defaultView.eval(${RUN})`],
    ['a parent chain', `(e) => e.target.parentNode.parentNode.ownerDocument.defaultView.eval(${RUN})`],
    ['the composed path', `(e) => e.nativeEvent.composedPath().map((x) => x.eval ? x.eval(${RUN}) : 0)`],
    ['a block body', `(e) => { e.target.ownerDocument.defaultView.eval(${RUN}) }`],
    ['a taken-apart parameter', `({ target }) => target.ownerDocument.defaultView.eval(${RUN})`],
    ['the keys of the event', `(e) => Object.values(e).map((v) => v && v.eval ? v.eval(${RUN}) : 0)`],
    [
      'the entries of the event, read by Object itself',
      `(e) => Object.values({ a: e }).map(Object.entries).flat(1).map(Object.values).flat(2).map(Object.entries).flat(1).map((p) => p && p[0] === "eval" ? p[1](${RUN}) : 0)`,
    ],
  ];
  for (const [name, handler] of ways) {
    it(`through ${name}`, async () => {
      await mount(`<button id="b" @click={${handler}}>x</button>`);
      await fire('b');
      expect(reached()).toBeUndefined();
    });
  }

  it('and cannot write markup or attributes into the page from the element', async () => {
    await mount(
      `<button id="a" @click={(e) => e.currentTarget.insertAdjacentHTML("beforeend", "<i id=planted></i>")}>x</button>` +
        `<button id="b" @click={(e) => e.target.setAttribute("data-planted", "1")}>y</button>` +
        `<button id="c" @click={(e) => e.target.ownerDocument.body.setAttribute("data-planted", "1")}>z</button>`
    );
    await fire('a');
    await fire('b');
    await fire('c');
    expect(document.querySelector('#planted')).toBeNull();
    expect(container.querySelector('#b')?.hasAttribute('data-planted')).toBe(false);
    expect(document.body.hasAttribute('data-planted')).toBe(false);
  });

  it('nor through an element, or a bag holding one, that a component hands a callback', async () => {
    await mount(
      `<HostProbe onNode={(node) => node.ownerDocument.defaultView.eval(${RUN})} ` +
        `onBag={(bag) => { bag.win.eval(${RUN}); bag.doc.defaultView.eval(${RUN}); bag.list[0].ownerDocument.defaultView.eval(${RUN}); bag.event.view.eval(${RUN}) }} ` +
        `render={(node) => node.ownerDocument.defaultView.eval(${RUN})} />`
    );
    await fire('node');
    await fire('bag');
    await fire('render');
    expect(reached()).toBeUndefined();
  });
});

describe('what a handler written in markup is given instead', () => {
  it('the key that was pressed, as Studio\'s guide writes it', async () => {
    await mount(`<input id="f" @keydown={(e) => e.key === "Enter" && add()} />`);
    await fire('f', new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(shown()).toBe('n=0||');
    await fire('f', new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(shown()).toBe('n=1||');
  });

  it('preventDefault and stopPropagation, which reach the real event', async () => {
    await mount(`<div id="outer" @click={() => add()}><form id="form" @submit={(e) => { e.preventDefault(); add() }}><button id="in" type="button" @click={(e) => e.stopPropagation()}>x</button></form></div>`);
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    await fire('form', submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(shown()).toBe('n=1||');
    await fire('in');
    // The click stopped at the button: the div's handler did not run.
    expect(shown()).toBe('n=1||');
  });

  it('what the element holds: its value, its data attributes, whether it is the one the handler is on', async () => {
    await mount(
      `<div id="row" data-id="r7" @click={(e) => got = e.currentTarget.dataset.id + ":" + e.target.tagName + ":" + (e.target === e.currentTarget) + ":" + e.currentTarget.contains(e.target)}>` +
        `<span id="inner">x</span></div>` +
        `<input id="f" value="typed" @focus={(e) => got = e.target.value + ":" + (e.target === e.currentTarget)} />`
    );
    await fire('inner');
    expect(shown()).toBe('n=0|r7:SPAN:false:true|');
    await fire('row');
    expect(shown()).toBe('n=0|r7:DIV:true:true|');
    await fire('f', new FocusEvent('focusin', { bubbles: true }));
    expect(shown()).toBe('n=0|typed:true|');
  });

  it('where the pointer was', async () => {
    await mount(`<button id="b" @click={(e) => got = e.type + ":" + e.clientX + ":" + e.shiftKey}>x</button>`);
    await fire('b', new MouseEvent('click', { bubbles: true, clientX: 12, shiftKey: true }));
    expect(shown()).toBe('n=0|click:12:true|');
  });

  it('a script handed the event gets its data, and the element it happened on as data', async () => {
    await mount(`<button id="b" @click={(e) => note(e)}>x</button>`);
    await fire('b', new MouseEvent('click', { bubbles: true, clientX: 3 }));
    const keys = (shown() ?? '').split('|')[2].split(',');
    for (const key of ['type', 'clientX', 'target', 'currentTarget', 'defaultPrevented']) expect(keys).toContain(key);
    // No method and no piece of the browser crosses into a script.
    for (const key of ['preventDefault', 'stopPropagation', 'view', 'nativeEvent']) expect(keys).not.toContain(key);
  });

  it('the element crosses as what a form’s handler reads, and nothing it can do', async () => {
    await mount(`<button id="b" name="go" @click={(e) => noteTarget(e)}>x</button>`);
    await fire('b', new MouseEvent('click', { bubbles: true }));
    expect((shown() ?? '').split('|')[2]).toBe('dataset,id,name,tagName,type,value/BUTTON/undefined');
  });

  it('plain data from a component, untouched', async () => {
    await mount(`<HostProbe onPress={(direction) => got = direction} />`);
    await fire('press');
    expect(shown()).toBe('n=0|up|');
  });

  it('an element a component hands over, as a record of what it holds', async () => {
    await mount(`<HostProbe onNode={(node) => got = node.tagName + ":" + node.id + ":" + typeof node.ownerDocument + ":" + typeof node.insertAdjacentHTML} />`);
    await fire('node');
    expect(shown()).toBe('n=0|BUTTON:node:undefined:undefined|');
  });
});
