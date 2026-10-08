/**
 * `@submit.prevent`, `@keydown.enter`, `@click.self`: modifiers on an event.
 *
 * A handler is never given the live DOM event — a script receives plain
 * data — so there was no way to say "and do not submit the form" or "only
 * for Enter" except an arrow in the template that inspected the event
 * itself. These tests dispatch real events at mounted elements, because
 * what a modifier does is done to the browser's event.
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNRenderContext, SoftNProps } from '../src/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

interface Mounted {
  calls: unknown[][];
  writes: Array<[string, unknown]>;
  find: <T extends Element>(selector: string) => T;
}

function mount(source: string, state: Record<string, unknown> = {}): Mounted {
  const doc = parse(source);
  expect(doc.diagnostics ?? []).toEqual([]);
  const calls: unknown[][] = [];
  const writes: Array<[string, unknown]> = [];
  const context: SoftNRenderContext = {
    state,
    setState: (path, value) => {
      writes.push([path, value]);
    },
    data: {},
    props: {},
    functions: {
      note: (...args: unknown[]) => {
        calls.push(args);
      },
    },
    asyncFunctions: {},
    computed: {},
  };
  const registry = new ComponentRegistry();
  // A component that hands its callback plain data, as DPad does.
  registry.register('Pad', ({ onPress }: SoftNProps) =>
    React.createElement(
      'button',
      { id: 'pad', onClick: () => (onPress as (direction: string) => void)?.('up') },
      'pad'
    )
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(renderDocument(doc, context, registry) as React.ReactElement);
  });
  return {
    calls,
    writes,
    find: <T extends Element>(selector: string) => {
      const found = container!.querySelector<T>(selector);
      if (!found) throw new Error(`nothing matches ${selector}`);
      return found;
    },
  };
}

function fire(target: Element, event: Event): Event {
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const click = () => new MouseEvent('click', { bubbles: true, cancelable: true });
const key = (name: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });

describe('prevent', () => {
  it('cancels the default action and runs the handler', () => {
    const { calls, find } = mount('<form @submit.prevent={() => note("saved")}><button>Go</button></form>');
    const event = fire(find('form'), new Event('submit', { bubbles: true, cancelable: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(calls).toEqual([['saved']]);
  });

  it('is what the same event does not do without it', () => {
    const { calls, find } = mount('<form @submit={() => note("saved")}><button>Go</button></form>');
    const event = fire(find('form'), new Event('submit', { bubbles: true, cancelable: true }));
    expect(event.defaultPrevented).toBe(false);
    expect(calls).toEqual([['saved']]);
  });
});

describe('stop', () => {
  it('keeps the event from the handlers above it', () => {
    const { calls, find } = mount(
      '<div @click={() => note("outer")}><button @click.stop={() => note("inner")}>x</button></div>'
    );
    fire(find('button'), click());
    expect(calls).toEqual([['inner']]);
  });

  it('is what lets a click through without it', () => {
    const { calls, find } = mount(
      '<div @click={() => note("outer")}><button @click={() => note("inner")}>x</button></div>'
    );
    fire(find('button'), click());
    expect(calls).toEqual([['inner'], ['outer']]);
  });
});

describe('self', () => {
  const backdrop =
    '<div id="backdrop" @click.self={() => note("close")}><p id="panel">Panel</p></div>';

  it('runs for a click on the element itself', () => {
    const { calls, find } = mount(backdrop);
    fire(find('#backdrop'), click());
    expect(calls).toEqual([['close']]);
  });

  it('does not run for a click that bubbled up from inside it', () => {
    const { calls, find } = mount(backdrop);
    fire(find('#panel'), click());
    expect(calls).toEqual([]);
  });
});

describe('key modifiers', () => {
  it('run the handler for that key only', () => {
    const { calls, find } = mount('<input @keydown.enter={() => note("add")} />');
    fire(find('input'), key('a'));
    fire(find('input'), key('Escape'));
    expect(calls).toEqual([]);
    fire(find('input'), key('Enter'));
    expect(calls).toEqual([['add']]);
  });

  it('name each key the way the page shows it', () => {
    const keys: Array<[string, string]> = [
      ['escape', 'Escape'], ['esc', 'Escape'], ['space', ' '], ['tab', 'Tab'],
      ['up', 'ArrowUp'], ['down', 'ArrowDown'], ['left', 'ArrowLeft'], ['right', 'ArrowRight'],
      ['backspace', 'Backspace'], ['delete', 'Delete'],
    ];
    for (const [modifier, pressed] of keys) {
      const { calls, find } = mount(`<input @keydown.${modifier}={() => note("${modifier}")} />`);
      fire(find('input'), key('x'));
      fire(find('input'), key(pressed));
      expect(calls, modifier).toEqual([[modifier]]);
      act(() => root!.unmount());
      container!.remove();
      root = null;
      container = null;
    }
  });

  it('take either of two keys written together', () => {
    const { calls, find } = mount('<input @keydown.up.down={() => note("move")} />');
    fire(find('input'), key('ArrowUp'));
    fire(find('input'), key('ArrowDown'));
    fire(find('input'), key('ArrowLeft'));
    expect(calls).toHaveLength(2);
  });

  it('require a held key when one is named', () => {
    const { calls, find } = mount('<input @keydown.ctrl.enter={() => note("send")} />');
    fire(find('input'), key('Enter'));
    expect(calls).toEqual([]);
    fire(find('input'), key('Enter', { ctrlKey: true }));
    expect(calls).toEqual([['send']]);
  });

  it('leave an event they did not match alone', () => {
    const { find } = mount('<input @keydown.enter.prevent={() => note("add")} />');
    expect(fire(find('input'), key('a')).defaultPrevented).toBe(false);
    expect(fire(find('input'), key('Enter')).defaultPrevented).toBe(true);
  });
});

describe('with the other things an event does', () => {
  it('still hands @change the value rather than the event', () => {
    const { calls, find } = mount('<input @change.stop={(value) => note(value)} />');
    const input = find<HTMLInputElement>('input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'typed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(calls).toEqual([['typed']]);
  });

  it('never filters what :bind does on the same event', () => {
    // The binding writes state on every change; the authored handler is the
    // part that carries the condition.
    const { calls, writes, find } = mount('<input :bind={query} @change.ctrl={() => note("ctrl")} />', {
      query: '',
    });
    const input = find<HTMLInputElement>('input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'abc');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(writes).toEqual([['query', 'abc']]);
    expect(calls).toEqual([]);
  });

  it('runs a handler given by name', () => {
    const { calls, find } = mount('<form @submit.prevent={note}><button>Go</button></form>');
    const event = fire(find('form'), new Event('submit', { bubbles: true, cancelable: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('on a component that hands its callback data, not an event', () => {
  it('prevent and stop have nothing to act on and the handler runs', () => {
    const { calls, find } = mount('<Pad @press.prevent.stop={(direction) => note(direction)} />');
    fire(find('#pad'), click());
    expect(calls).toEqual([['up']]);
  });

  it('a filter has nothing to test and does not pass', () => {
    const { calls, find } = mount('<Pad @press.enter={(direction) => note(direction)} />');
    fire(find('#pad'), click());
    expect(calls).toEqual([]);
  });
});
