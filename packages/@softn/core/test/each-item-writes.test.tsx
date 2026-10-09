/**
 * A write to the thing a loop is on.
 *
 * `#each (todo in todos)` names each item of the list, and the first thing
 * written inside it is a control bound to a field of that item:
 *
 *     #each (todo in todos)
 *       <input type="checkbox" :bind={todo.done} />
 *     #end
 *
 * The write was made at the path as spelled, `todo.done`: a key called
 * "todo" in the app's state, which is no part of the list. The row never
 * changed, the box sprang back, and a stray `todo` gathered in state. An
 * assignment in a handler (`todo.done = !todo.done`) and `todo.count++` went
 * the same way. Only `todos[i].done`, with the index written out, reached
 * the row.
 *
 * A loop variable now knows where it came from when its list is a path into
 * state, and a write to it is a write there. Where the list is worked out
 * (`todos.filter(…)`) or is not state (a collection's records) there is no
 * such place, and nothing is written, where a stray key used to be.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

interface Mounted {
  writes: Array<[string, unknown]>;
  all: (selector: string) => HTMLElement[];
}

function mount(
  source: string,
  state: Record<string, unknown>,
  extra: { data?: Record<string, unknown>; props?: Record<string, unknown>; functions?: Record<string, (...args: unknown[]) => unknown> } = {}
): Mounted {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const writes: Array<[string, unknown]> = [];
  const registry = new ComponentRegistry();
  // A control that hands its callback the value, as Select and Slider do.
  registry.register('Pick', ({ value, onChange }: { value?: unknown; onChange?: (v: unknown) => void }) => (
    <button type="button" data-value={String(value)} onClick={() => onChange?.('picked')}>
      pick
    </button>
  ));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      renderDocument(
        doc,
        {
          state,
          setState: (path: string, value: unknown) => writes.push([path, value]),
          data: extra.data ?? {},
          props: extra.props ?? {},
          functions: extra.functions ?? {},
          asyncFunctions: {},
          computed: {},
        } as never,
        registry
      ) as React.ReactElement
    );
  });
  return { writes, all: (selector) => Array.from(container!.querySelectorAll<HTMLElement>(selector)) };
}

function type(input: HTMLElement, text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const todos = () => [
  { id: 'a', title: 'First', done: false, count: 1 },
  { id: 'b', title: 'Second', done: false, count: 4 },
];

describe('a control bound to a field of the loop item', () => {
  it('writes the row it is on', () => {
    const { writes, all } = mount('#each (todo in todos)\n<input :bind={todo.title} />\n#end', { todos: todos() });
    type(all('input')[1], 'Changed');
    expect(writes).toContainEqual(['todos[1].title', 'Changed']);
    // And not a key of state named after the loop variable.
    expect(writes.map(([path]) => path).filter((path) => path.startsWith('todo.'))).toEqual([]);
  });

  it('writes a checkbox as a boolean, on its row', () => {
    const { writes, all } = mount('#each (todo in todos)\n<input type="checkbox" :bind={todo.done} />\n#end', {
      todos: todos(),
    });
    click(all('input')[0]);
    expect(writes).toEqual([['todos[0].done', true]]);
  });

  it('writes what a component hands its callback', () => {
    const { writes, all } = mount('#each (todo in todos)\n<Pick :bind={todo.title} />\n#end', { todos: todos() });
    click(all('button')[1]);
    expect(writes).toEqual([['todos[1].title', 'picked']]);
  });

  it('follows the list through an outer loop', () => {
    const { writes, all } = mount(
      '#each (group in groups)\n#each (todo in group.items)\n<input :bind={todo.title} />\n#end\n#end',
      { groups: [{ items: todos() }, { items: todos() }] }
    );
    type(all('input')[3], 'Deep');
    expect(writes).toContainEqual(['groups[1].items[1].title', 'Deep']);
  });

  it('writes an item that is itself the value', () => {
    const { writes, all } = mount('#each (name in names)\n<input :bind={name} />\n#end', { names: ['Ada', 'Grace'] });
    expect((all('input')[1] as HTMLInputElement).value).toBe('Grace');
    type(all('input')[1], 'Hedy');
    expect(writes).toContainEqual(['names[1]', 'Hedy']);
  });

  it('does the same for each= on a tag', () => {
    const { writes, all } = mount('<input each={todos} as="todo" :bind={todo.title} />', { todos: todos() });
    type(all('input')[1], 'Inline');
    expect(writes).toContainEqual(['todos[1].title', 'Inline']);
  });

  it('still writes by index, as it did', () => {
    const { writes, all } = mount('#each (todo, i in todos)\n<input :bind={todos[i].title} />\n#end', { todos: todos() });
    type(all('input')[1], 'ByIndex');
    expect(writes).toContainEqual(['todos[1].title', 'ByIndex']);
  });
});

describe('a handler that changes the loop item', () => {
  it('assigns to the row', () => {
    const { writes, all } = mount(
      '#each (todo in todos)\n<button @click={() => todo.done = !todo.done}>toggle</button>\n#end',
      { todos: todos() }
    );
    click(all('button')[1]);
    expect(writes).toEqual([['todos[1].done', true]]);
  });

  it('counts on the row', () => {
    const { writes, all } = mount('#each (todo in todos)\n<button @click={() => todo.count++}>more</button>\n#end', {
      todos: todos(),
    });
    click(all('button')[1]);
    expect(writes).toEqual([['todos[1].count', 5]]);
  });

  it('adds to the row', () => {
    const { writes, all } = mount(
      '#each (todo in todos)\n<button @click={() => todo.count += 10}>ten</button>\n#end',
      { todos: todos() }
    );
    click(all('button')[0]);
    expect(writes).toEqual([['todos[0].count', 11]]);
  });

  it('replaces the item', () => {
    const { writes, all } = mount('#each (name in names)\n<button @click={() => name = "x"}>x</button>\n#end', {
      names: ['Ada', 'Grace'],
    });
    click(all('button')[1]);
    expect(writes).toEqual([['names[1]', 'x']]);
  });

  it('writes state that is not the loop’s as before', () => {
    const { writes, all } = mount(
      '#each (todo in todos)\n<button @click={() => selected = todo.id}>choose</button>\n#end',
      { todos: todos(), selected: null }
    );
    click(all('button')[1]);
    expect(writes).toEqual([['selected', 'b']]);
  });
});

describe('a loop item with no place in state', () => {
  it('is not written when the list is worked out', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { writes, all } = mount(
      '#each (todo in todos.filter(t => !t.done))\n<input :bind={todo.title} />\n<button @click={() => todo.done = true}>done</button>\n#end',
      { todos: todos() }
    );
    type(all('input')[1], 'Nowhere');
    click(all('button')[1]);
    // Nothing, where a key called "todo" used to be written.
    expect(writes).toEqual([]);
  });

  it('is not written when the list is a collection’s records, which are not state', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { writes, all } = mount(
      '#each (note in notes)\n<input :bind={note.title} />\n#end',
      {},
      { data: { notes: todos() } }
    );
    type(all('input')[0], 'Nowhere');
    // A write at `notes[0].title` would make a state variable called notes
    // and hide the collection behind it.
    expect(writes).toEqual([]);
  });

  it('is not written when it is the index', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writes, all } = mount('#each (todo, i in todos)\n<button @click={() => i = 5}>x</button>\n#end', {
      todos: todos(),
    });
    click(all('button')[0]);
    expect(writes).toEqual([]);
  });

  it('is not written when it is an arrow’s parameter', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writes, all } = mount('<button @click={() => todos.forEach(t => t.done = true)}>all</button>', {
      todos: todos(),
    });
    click(all('button')[0]);
    expect(writes).toEqual([]);
  });

  it('says so, once, naming what was written to', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { all } = mount('#each (todo in todos.slice(0, 1))\n<input :bind={todo.title} />\n#end', { todos: todos() });
    type(all('input')[0], 'a');
    type(all('input')[0], 'ab');
    const said = errors.mock.calls.map((call) => String(call[0])).filter((message) => message.includes('todo.title'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"todo.title" on line 2 was not written');
    expect(said[0]).toContain('"todo" is a name the page itself bound');
  });
});

describe('a loop over a list a parent handed down', () => {
  it('reports the row to the parent’s handler', () => {
    const changed: unknown[][] = [];
    const { writes, all } = mount(
      '#each (item in items)\n<input :bind={item.label} />\n#end',
      {},
      { props: { items: [{ label: 'One' }, { label: 'Two' }] }, functions: { onItemsChange: (...args) => changed.push(args) } }
    );
    type(all('input')[1], 'Deux');
    expect(changed).toContainEqual(['items[1].label', 'Deux']);
    expect(writes).toEqual([]);
  });
});

describe('what a loop variable is worth', () => {
  it('hides a state variable of the same name inside the loop, and only there', () => {
    const { all } = mount('<p>{item}</p>\n#each (item in items)\n<i>{item}</i>\n#end\n<b>{item}</b>', {
      item: 'outer',
      items: ['one', 'two'],
    });
    expect(all('p')[0].textContent).toBe('outer');
    expect(all('i').map((i) => i.textContent)).toEqual(['one', 'two']);
    expect(all('b')[0].textContent).toBe('outer');
  });

  it('is the inner loop’s where two loops use one name', () => {
    const { all } = mount('#each (x in outer)\n#each (x in inner)\n<i>{x}</i>\n#end\n<b>{x}</b>\n#end', {
      outer: ['A'],
      inner: [1, 2],
    });
    expect(all('i').map((i) => i.textContent)).toEqual(['1', '2']);
    expect(all('b')[0].textContent).toBe('A');
  });

  it('is seen by an arrow written inside the loop, and the arrow’s own parameter hides it', () => {
    const { all } = mount(
      '#each (row in rows)\n<i>{row.cells.map(c => c * row.by).join(",")}</i>\n<b>{row.cells.map(row => row + 1).join(",")}</b>\n#end',
      { rows: [{ by: 2, cells: [1, 2] }] }
    );
    expect(all('i')[0].textContent).toBe('2,4');
    expect(all('b')[0].textContent).toBe('2,3');
  });

  it('is what a handler made in that pass sees later', () => {
    const seen: unknown[] = [];
    const { all } = mount(
      '#each (row, i in rows)\n<button @click={() => note(row, i)}>go</button>\n#end',
      { rows: ['a', 'b', 'c'] },
      { functions: { note: (...args) => seen.push(args) } }
    );
    click(all('button')[2]);
    click(all('button')[0]);
    expect(seen).toEqual([['c', 2], ['a', 0]]);
  });

  it('does not reach the app’s state object', () => {
    const state = { rows: ['a'] };
    mount('#each (row, i in rows)\n<i>{row}</i>\n#end', state);
    expect(Object.keys(state)).toEqual(['rows']);
  });
});
