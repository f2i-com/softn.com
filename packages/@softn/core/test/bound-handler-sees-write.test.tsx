/**
 * A handler written beside `:bind` sees the value just bound.
 *
 *     <select :bind={category} @change={load(category)}>
 *
 * Choosing "b" called `load("a")`. The binding writes state, and the page's
 * state is what React drew last, so the handler beside it worked its
 * expression out against the value from before the change; the comment in
 * the renderer said "binding first so the handler sees the new value".
 * `<input :bind={q} @input={() => load(q)} />` was a keystroke behind for a
 * second reason as well: React calls `onInput` before the `onChange` the
 * binding writes from, so the binding had not written at all.
 *
 * Now what the binding wrote is laid over the state the handlers of that
 * element read, the logic is told at once, a loop's item is read again from
 * where it lives, and a field's binding writes on the `input` event when a
 * handler is written for it. The binding still writes once.
 *
 * The first half holds the renderer to it with a state made here, where each
 * write can be counted. The second is the page as an app has it: logic on
 * each engine and thread.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer, type SoftNRendererProps } from '../src/loader/SoftNRenderer';
import type { ComponentRegistry } from '../src/renderer';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import { choose, click, drawPage, removeDrawnPages, typeInto } from './helpers/drawn-page';
import { withInProcessWorker } from './helpers/in-process-worker';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement | undefined;

afterEach(async () => {
  removeDrawnPages();
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── The renderer, with a state made here ────────────────────────────────────

const OPTIONS = '<option value="a">A</option><option value="b">B</option>';

/** A page whose handlers call `load` and `save`; `calls` is what each was handed. */
function page(source: string, state: Record<string, unknown>, register?: (registry: ComponentRegistry) => void) {
  const calls: unknown[][] = [];
  const note = (...args: unknown[]) => {
    // A copy: what it was handed, as it was when it was handed it.
    calls.push(JSON.parse(JSON.stringify(args)));
  };
  const drawn = drawPage(source, state, { functions: { load: note, save: note }, register });
  return { ...drawn, calls };
}

describe('a handler beside :bind on a native field', () => {
  it.each([
    ['a call', '@change={load(category)}'],
    ['an arrow', '@change={() => load(category)}'],
    ['an arrow with a block', '@change={() => { load(category) }}'],
    ['a quoted handler', '@change="load(category)"'],
    ['an HTML handler attribute', 'onchange="load(category)"'],
    ['an on… prop', 'onChange={load(category)}'],
    ['an on… prop holding an arrow', 'onChange={() => load(category)}'],
  ])('is handed the value just chosen, written as %s', (_name, handler) => {
    const { calls, writes, one } = page(`<select :bind={category} ${handler}>${OPTIONS}</select>`, { category: 'a' });
    choose(one<HTMLSelectElement>('select'), 'b');
    expect(calls).toEqual([['b']]);
    expect(writes).toEqual([['category', 'b']]);
  });

  it.each([
    ['a call', '@input={load(q)}'],
    ['an arrow', '@input={() => load(q)}'],
    ['a quoted handler', 'oninput="load(q)"'],
    ['an on… prop', 'onInput={load(q)}'],
  ])('is not a keystroke behind on @input, written as %s', (_name, handler) => {
    const { calls, writes, one } = page(`<input :bind={q} ${handler} />`, { q: '' });
    typeInto(one('input'), 'h');
    typeInto(one('input'), 'hi');
    expect(calls).toEqual([['h'], ['hi']]);
    // Once a keystroke: the `input` event carries both React's onInput and onChange.
    expect(writes).toEqual([['q', 'h'], ['q', 'hi']]);
  });

  it('writes once when the field has a handler for input and one for change', () => {
    const { calls, writes, one } = page('<textarea :bind={q} @input={load("input", q)} @change={save("change", q)}></textarea>', { q: '' });
    typeInto(one('textarea'), 'x');
    expect(writes).toEqual([['q', 'x']]);
    expect(calls).toEqual([['input', 'x'], ['change', 'x']]);
  });

  it('is handed a number field’s number', () => {
    const { calls, writes, one } = page('<input type="number" :bind={qty} @input={() => load(qty + 1)} />', { qty: 1 });
    typeInto(one('input'), '5');
    expect(calls).toEqual([[6]]);
    expect(writes).toEqual([['qty', 5]]);
  });

  it('is handed a checkbox’s yes or no', () => {
    const { calls, writes, one } = page('<input type="checkbox" :bind={done} @change={load(done)} />', { done: false });
    click(one('input'));
    expect(calls).toEqual([[true]]);
    expect(writes).toEqual([['done', true]]);
  });

  it('is handed the radio chosen', () => {
    const { calls, all } = page(
      '<input type="radio" name="size" value="s" :bind={size} @change={load(size)} /><input type="radio" name="size" value="l" :bind={size} @change={load(size)} />',
      { size: 's' }
    );
    click(all('input')[1]);
    expect(calls).toEqual([['l']]);
  });

  it('reads the bound value in a block, and what the block writes from it', () => {
    const { calls, state, one } = page(
      `<select :bind={category} @change={() => { label = category + "!"; load(label) }}>${OPTIONS}</select>`,
      { category: 'a', label: '' }
    );
    choose(one<HTMLSelectElement>('select'), 'b');
    expect(calls).toEqual([['b!']]);
    expect(state()).toMatchObject({ category: 'b', label: 'b!' });
  });

  it('keeps what the handler itself writes to the bound variable', () => {
    // The binding writes first and the handler after it, so the handler’s is the last word.
    const { state, one } = page('<input :bind={q} @input={() => q = q.toUpperCase()} />', { q: '' });
    typeInto(one('input'), 'abc');
    expect(state().q).toBe('ABC');
  });

  it('is still handed the value as its argument, by name or by an arrow', () => {
    const byName = page(`<select :bind={category} @change={load}>${OPTIONS}</select>`, { category: 'a' });
    choose(byName.one<HTMLSelectElement>('select'), 'b');
    expect(byName.calls).toEqual([['b']]);

    const byArrow = page('<input :bind={q} @input={(value) => load(value, q)} />', { q: '' });
    typeInto(byArrow.one('input'), 'x');
    expect(byArrow.calls).toEqual([['x', 'x']]);
  });

  it('tells the logic at once, for a function that reads the variable itself', () => {
    const { shared, one } = page(`<select :bind={category} @change={load()}>${OPTIONS}</select>`, { category: 'a' });
    choose(one<HTMLSelectElement>('select'), 'b');
    expect(shared).toContainEqual({ category: 'b' });
  });

  it('reads a field of a record bound by its path', () => {
    const { calls, one } = page('<input :bind={form.name} @input={load(form.name, form)} />', { form: { name: '', age: 3 } });
    typeInto(one('input'), 'Ada');
    expect(calls).toEqual([['Ada', { name: 'Ada', age: 3 }]]);
  });
});

describe('a handler beside :bind inside a loop', () => {
  const todos = () => [
    { id: 'a', done: false },
    { id: 'b', done: false },
  ];

  it.each([
    ['a call', '@change={save(todo)}'],
    ['an arrow', '@change={() => save(todo)}'],
    ['a quoted handler', '@change="save(todo)"'],
  ])('is handed the row as the binding left it, written as %s', (_name, handler) => {
    const { calls, writes, all } = page(`#each (todo in todos)\n<input type="checkbox" :bind={todo.done} ${handler} />\n#end`, {
      todos: todos(),
    });
    click(all('input')[1]);
    expect(calls).toEqual([[{ id: 'b', done: true }]]);
    expect(writes).toEqual([['todos[1].done', true]]);
  });

  it('reads the names a row was taken apart into', () => {
    const { calls, all } = page('#each ({ id, done }, i in todos)\n<input type="checkbox" :bind={done} @change={save(id, done, i)} />\n#end', {
      todos: todos(),
    });
    click(all('input')[0]);
    expect(calls).toEqual([['a', true, 0]]);
  });

  it('reads the row through the loop around it', () => {
    const { calls, all } = page(
      '#each (group in groups)\n#each (todo in group.todos)\n<input type="checkbox" :bind={todo.done} @change={save(group.name, group.todos.filter((t) => t.done).length)} />\n#end\n#end',
      { groups: [{ name: 'Home', todos: todos() }] }
    );
    click(all('input')[1]);
    expect(calls).toEqual([['Home', 1]]);
  });

  it('leaves the other rows’ handlers reading their own rows', () => {
    const { calls, all } = page('#each (todo in todos)\n<input type="checkbox" :bind={todo.done} @change={save(todo)} />\n#end', {
      todos: todos(),
    });
    click(all('input')[0]);
    click(all('input')[1]);
    expect(calls).toEqual([[{ id: 'a', done: true }], [{ id: 'b', done: true }]]);
  });
});

describe('a handler beside :bind on a component', () => {
  const components = (registry: ComponentRegistry) => {
    // A control that hands its callback the value, as Select and Slider do.
    registry.register('Pick', ({ value, onChange }: { value?: unknown; onChange?: (v: unknown) => void }) => (
      <button type="button" data-value={String(value)} onClick={() => onChange?.('picked')}>
        pick
      </button>
    ));
    // One that passes on its field’s events, as Input does.
    registry.register('Field', ({ value, onChange, onInput }: { value?: string; onChange?: React.ChangeEventHandler; onInput?: React.FormEventHandler }) => (
      <input value={value ?? ''} onChange={onChange} onInput={onInput} />
    ));
    // The components whose bound state is not `value` (BOUND_STATE), by their names.
    registry.register('Tabs', ({ activeKey, onChange }: { activeKey?: unknown; onChange?: (key: string) => void }) => (
      <button type="button" data-active={String(activeKey)} onClick={() => onChange?.('second')}>
        tab
      </button>
    ));
    registry.register('Modal', ({ open, onClose }: { open?: boolean; onClose?: () => void }) => (
      <button type="button" data-open={String(open)} onClick={() => onClose?.()}>
        close
      </button>
    ));
    registry.register('SmartGrid', ({ onSelect }: { onSelect?: (row: unknown) => void }) => (
      <button type="button" onClick={() => onSelect?.({ id: 7 })}>
        row
      </button>
    ));
  };

  it('is handed the value the component reported', () => {
    const { calls, writes, one } = page('<Pick :bind={choice} @change={load(choice)} />', { choice: 'none' }, components);
    click(one('button'));
    expect(calls).toEqual([['picked']]);
    expect(writes).toEqual([['choice', 'picked']]);
  });

  it('is handed it in an on… prop as well', () => {
    const { calls, one } = page('<Pick :bind={choice} onChange={() => load(choice)} />', { choice: 'none' }, components);
    click(one('button'));
    expect(calls).toEqual([['picked']]);
  });

  it('is not a keystroke behind on a component that passes its field’s events on', () => {
    const { calls, writes, one } = page('<Field :bind={q} @input={() => load(q)} />', { q: '' }, components);
    typeInto(one('input'), 'h');
    typeInto(one('input'), 'hi');
    expect(calls).toEqual([['h'], ['hi']]);
    expect(writes).toEqual([['q', 'h'], ['q', 'hi']]);
  });

  it('is handed the tab chosen, and a dialog’s closing', () => {
    const tabs = page('<Tabs :bind={tab} @change={load(tab)} />', { tab: 'first' }, components);
    click(tabs.one('button'));
    expect(tabs.calls).toEqual([['second']]);
    expect(tabs.writes).toEqual([['tab', 'second']]);

    const modal = page('<Modal :bind={open} @close={load(open)} />', { open: true }, components);
    click(modal.one('button'));
    expect(modal.calls).toEqual([[false]]);
    expect(modal.writes).toEqual([['open', false]]);
  });

  it('is handed the row a grid’s selectTo wrote', () => {
    const { calls, writes, one } = page('<SmartGrid selectTo="picked" @select={load(picked)} />', { picked: null }, components);
    click(one('button'));
    expect(calls).toEqual([[{ id: 7 }]]);
    expect(writes).toEqual([['picked', { id: 7 }]]);
  });
});

// ── A page and its logic, on each engine and thread ─────────────────────────

const shown = () => container?.querySelector('#out')?.textContent ?? '';

async function mountPage(source: string, props: Partial<SoftNRendererProps> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<SoftNRenderer source={source} appId="bound-handler-sees-write" scriptExecutionMode="main" {...props} />);
  });
  // Until the logic has loaded: before it has, `loaded` is not on the page.
  for (let i = 0; i < 150 && !shown().startsWith('yes|'); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
  expect(shown()).toBe('yes|a|||');
}

/** Do `what`, and say what the page shows once the logic has gone quiet. */
async function after(what: () => void, expected: string): Promise<string> {
  await act(async () => {
    what();
    await sleep(20);
  });
  for (let i = 0; i < 50 && shown() !== expected; i++) {
    await act(async () => {
      await sleep(20);
    });
  }
  await act(async () => {
    await sleep(60);
  });
  return shown();
}

const chooseB = () => {
  const select = container!.querySelector('select') as HTMLSelectElement;
  for (const option of Array.from(select.options)) option.selected = option.value === 'b';
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

const typeText = (text: string) => () => {
  const input = container!.querySelector('input') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const MARKUP = (onChange: string, onInput: string) => `<div>
<select :bind={category} @change={${onChange}}>${OPTIONS}</select>
<input :bind={q} @input={${onInput}} />
<p id="out">{loaded}|{category}|{q}|{seen}|{own}</p>
</div>`;

const LOGIC = `<logic>
let loaded = 'yes'
let category = 'a'
let q = ''
let seen = ''
let own = ''
function load(value) { seen = seen + value + ';' }
function readOwn() { own = own + category + '/' + q + ';' }
</logic>`;

describe('a handler beside :bind, with the logic on the main thread', () => {
  it('hands the logic the value just bound', async () => {
    await mountPage(`${LOGIC}\n${MARKUP('load(category)', '() => load(q)')}`);
    expect(await after(chooseB, 'yes|b||b;|')).toBe('yes|b||b;|');
    expect(await after(typeText('h'), 'yes|b|h|b;h;|')).toBe('yes|b|h|b;h;|');
    expect(await after(typeText('hi'), 'yes|b|hi|b;h;hi;|')).toBe('yes|b|hi|b;h;hi;|');
  });

  it('lets a logic function read the bound variable itself', async () => {
    await mountPage(`${LOGIC}\n${MARKUP('readOwn()', 'readOwn()')}`);
    expect(await after(chooseB, 'yes|b|||b/;')).toBe('yes|b|||b/;');
    expect(await after(typeText('h'), 'yes|b|h||b/;b/h;')).toBe('yes|b|h||b/;b/h;');
  });
});

describe('a handler beside :bind, with the logic in the worker', () => {
  const inWorker = { scriptExecutionMode: 'worker', executionPreference: 'worker' } as const;

  it('hands the logic the value just bound', async () => {
    await withInProcessWorker(async () => {
      await mountPage(`${LOGIC}\n${MARKUP('load(category)', '() => load(q)')}`, inWorker);
      expect(await after(chooseB, 'yes|b||b;|')).toBe('yes|b||b;|');
      expect(await after(typeText('h'), 'yes|b|h|b;h;|')).toBe('yes|b|h|b;h;|');
    });
  });

  it('lets a logic function read the bound variable itself', async () => {
    await withInProcessWorker(async () => {
      await mountPage(`${LOGIC}\n${MARKUP('readOwn()', 'readOwn()')}`, inWorker);
      expect(await after(chooseB, 'yes|b|||b/;')).toBe('yes|b|||b/;');
      expect(await after(typeText('h'), 'yes|b|h||b/;b/h;')).toBe('yes|b|h||b/;b/h;');
    });
  });
});

describe.skipIf(!logicEngineRunsPython())('a handler beside :bind, with the logic in Python', () => {
  const python = {
    files: {
      app: [
        'loaded = "yes"',
        'category = "a"',
        'q = ""',
        'seen = ""',
        'own = ""',
        '',
        'def load(value):',
        '    global seen',
        '    seen = seen + str(value) + ";"',
        '',
        'def read_own():',
        '    global own',
        '    own = own + category + "/" + q + ";"',
        '',
      ].join('\n'),
    },
    modules: ['app'],
  };
  // The empty <logic> block a Python composition leaves in the markup.
  const pythonPage = (onChange: string, onInput: string) => `${MARKUP(onChange, onInput)}\n<logic>\n</logic>`;

  it('hands the logic the value just bound', async () => {
    await mountPage(pythonPage('load(category)', '() => load(q)'), { python });
    expect(await after(chooseB, 'yes|b||b;|')).toBe('yes|b||b;|');
    expect(await after(typeText('h'), 'yes|b|h|b;h;|')).toBe('yes|b|h|b;h;|');
  });

  it('lets a logic function read the bound variable itself', async () => {
    await mountPage(pythonPage('read_own()', 'read_own()'), { python });
    expect(await after(chooseB, 'yes|b|||b/;')).toBe('yes|b|||b/;');
    expect(await after(typeText('h'), 'yes|b|h||b/;b/h;')).toBe('yes|b|h||b/;b/h;');
  });
});
