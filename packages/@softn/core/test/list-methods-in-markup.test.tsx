/**
 * `items.push(x)`, `list.sort()` and the other methods that change the list
 * they are called on, written in a page.
 *
 * The list in the app's state was changed where it lay. From a handler,
 * `@click={() => items.push(draft)}`, nothing was drawn until some other
 * change came along, the logic's own `items` never had the entry, and the
 * next thing the logic wrote back took it away again. While the page was
 * drawn, `#each (x in list.reverse())` turned the stored list round on every
 * drawing, and `{list.sort().join()}` put state in another order as a side
 * effect of showing it.
 *
 * Now such a method is made on a copy. In a handler the copy is written to
 * state at the list's place, as an assignment would write it. While the page
 * is drawn the copy is what the expression is worth, and state is as it was.
 * A list that is nobody's state is changed as JavaScript changes it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer, type SoftNRendererProps } from '../src/loader/SoftNRenderer';
import type { ComponentRegistry } from '../src/renderer';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import { click, drawPage, removeDrawnPages } from './helpers/drawn-page';
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

// ── In a handler ────────────────────────────────────────────────────────────

describe('a method that changes a state list, in a handler', () => {
  it('draws the page again with the entry, and leaves the list that was drawn alone', () => {
    const items = ['a', 'b'];
    const { writes, state, text, one } = drawPage('<button @click={() => items.push(draft)}>add</button><p>{items.join(",")}</p>', {
      items,
      draft: 'c',
    });
    click(one('button'));
    expect(text('p')).toBe('a,b,c');
    expect(writes).toEqual([['items', ['a', 'b', 'c']]]);
    expect(state().items).not.toBe(items);
    expect(items).toEqual(['a', 'b']);
  });

  it.each([
    ['push', 'items.push(9, 8)', [3, 1, 2, 5, 9, 8]],
    ['pop', 'items.pop()', [3, 1, 2]],
    ['shift', 'items.shift()', [1, 2, 5]],
    ['unshift', 'items.unshift(0)', [0, 3, 1, 2, 5]],
    ['splice', 'items.splice(1, 2, 7)', [3, 7, 5]],
    ['sort', 'items.sort()', [1, 2, 3, 5]],
    ['sort with a comparison', 'items.sort((a, b) => b - a)', [5, 3, 2, 1]],
    ['reverse', 'items.reverse()', [5, 2, 1, 3]],
    ['fill', 'items.fill(0, 1)', [3, 0, 0, 0]],
    ['copyWithin', 'items.copyWithin(0, 2)', [2, 5, 2, 5]],
  ])('writes what %s makes of the list, once', (_name, call, made) => {
    const items = [3, 1, 2, 5];
    const { writes, one } = drawPage(`<button @click={${call}}>go</button>`, { items });
    click(one('button'));
    expect(writes).toEqual([['items', made]]);
    expect(items).toEqual([3, 1, 2, 5]);
  });

  it.each([
    ['a call', '@click={items.push(draft)}'],
    ['an arrow', '@click={() => items.push(draft)}'],
    ['a block', '@click={() => { items.push(draft) }}'],
    ['a quoted handler', '@click="items.push(draft)"'],
    ['an on… prop', 'onClick={items.push(draft)}'],
  ])('writes it however the handler is written: %s', (_name, handler) => {
    const { writes, one } = drawPage(`<button ${handler}>add</button>`, { items: ['a'], draft: 'b' });
    click(one('button'));
    expect(writes).toEqual([['items', ['a', 'b']]]);
  });

  it('writes a list inside a record, and the list of a loop’s row, where each lives', () => {
    const inRecord = drawPage('<button @click={form.tags.push("x")}>add</button>', { form: { name: 'n', tags: ['a'] } });
    click(inRecord.one('button'));
    expect(inRecord.writes).toEqual([['form.tags', ['a', 'x']]]);
    expect(inRecord.state().form).toEqual({ name: 'n', tags: ['a', 'x'] });

    const inRow = drawPage('#each (todo in todos) key={todo.id}\n<button @click={todo.tags.push("x")}>add</button>\n#end', {
      todos: [{ id: 1, tags: [] }, { id: 2, tags: ['a'] }],
    });
    click(inRow.all('button')[1]);
    expect(inRow.writes).toEqual([['todos[1].tags', ['a', 'x']]]);

    const byIndex = drawPage('<button @click={rows[n - 1].push(0)}>add</button>', { rows: [[1], [2]], n: 2 });
    click(byIndex.one('button'));
    expect(byIndex.writes).toEqual([['rows[1]', [2, 0]]]);
  });

  it('answers what the method answers', () => {
    const { state, one } = drawPage(
      '<button @click={() => { length = items.push(9); last = items.pop(); gone = items.splice(0, 1); same = items.sort() }}>go</button>',
      { items: [3, 1, 2] }
    );
    click(one('button'));
    expect(state()).toMatchObject({ length: 4, last: 9, gone: [3], same: [1, 2], items: [1, 2] });
  });

  it('lets a later statement of a block see the change, and the logic with it', () => {
    const saved: unknown[] = [];
    const { writes, shared, state, one } = drawPage('<button @click={() => { items.push("b"); items.push("c"); save(items) }}>go</button>', { items: ['a'] }, {
      functions: { save: (list: unknown) => saved.push(JSON.parse(JSON.stringify(list))) },
    });
    click(one('button'));
    expect(state().items).toEqual(['a', 'b', 'c']);
    expect(saved).toEqual([['a', 'b', 'c']]);
    expect(writes).toEqual([['items', ['a', 'b']], ['items', ['a', 'b', 'c']]]);
    expect(shared[shared.length - 1]).toEqual({ items: ['a', 'b', 'c'] });
  });

  it('keeps every change of a handler called several times before the page is drawn again', () => {
    const many = (registry: ComponentRegistry) => {
      // A component that reports three things, one after another, in one event.
      registry.register('Many', ({ onEach }: { onEach?: (value: string) => void }) => (
        <button type="button" onClick={() => ['x', 'y', 'z'].forEach((value) => onEach?.(value))}>
          many
        </button>
      ));
    };
    const arrow = drawPage('<Many @each={(value) => files.push(value)} />', { files: ['a'] }, { register: many });
    click(arrow.one('button'));
    expect(arrow.state().files).toEqual(['a', 'x', 'y', 'z']);

    const block = drawPage('<Many @each={(value) => { files.push(value) }} />', { files: ['a'] }, { register: many });
    click(block.one('button'));
    expect(block.state().files).toEqual(['a', 'x', 'y', 'z']);
  });

  it('starts from the list as it is drawn, each time it is drawn', () => {
    // The very list that was changed before is put back, and changed again.
    const first = ['a'];
    const { state, one } = drawPage('<button id="add" @click={items.push("x")}>add</button><button id="reset" @click={items = first}>reset</button>', {
      items: first,
      first,
    });
    click(one('#add'));
    expect(state().items).toEqual(['a', 'x']);
    click(one('#reset'));
    expect(state().items).toBe(first);
    click(one('#add'));
    expect(state().items).toEqual(['a', 'x']);
    expect(first).toEqual(['a']);
  });
});

describe('a method that changes a list that is nobody’s state, in a handler', () => {
  it('changes it as JavaScript does', () => {
    const saved: unknown[] = [];
    const save = (value: unknown) => saved.push(JSON.parse(JSON.stringify(value)));
    const literal = drawPage('<button @click={() => save([3, 1, 2].sort())}>go</button>', {}, { functions: { save } });
    click(literal.one('button'));
    expect(saved).toEqual([[1, 2, 3]]);
    expect(literal.writes).toEqual([]);
  });

  it('says so, once, where the list is reached from a loop’s item that has no place in state', () => {
    // The row of a list worked out in the page: an assignment here is refused
    // and reported. The list is changed where it lies, as it was, and now says
    // that nothing is drawn for it.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const todos = [{ id: 1, tags: ['a'] }, { id: 2, tags: [] }];
    const { writes, all } = drawPage('#each (todo in todos.filter((t) => t.id > 0)) key={todo.id}\n<button @click={todo.tags.push("x")}>add</button>\n#end', {
      todos,
    });
    click(all('button')[0]);
    click(all('button')[0]);
    expect(writes).toEqual([]);
    expect(todos[0].tags).toEqual(['a', 'x', 'x']);
    const said = errors.mock.calls.map((call) => String(call[0])).filter((message) => message.includes('changed a list where it lies'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"todo.tags.push()" on line 2');
    expect(said[0]).toContain('"todo" is an item of a list that is worked out in the page');
  });

  it('changes the list a component handed over, where it lies', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handed = ['a'];
    const saved: unknown[] = [];
    const { writes, one } = drawPage('<Hands @rows={(rows) => { rows.push("b"); save(rows) }} />', {}, {
      functions: { save: (value: unknown) => saved.push(JSON.parse(JSON.stringify(value))) },
      register: (registry) => {
        registry.register('Hands', ({ onRows }: { onRows?: (rows: string[]) => void }) => (
          <button type="button" onClick={() => onRows?.(handed)}>
            hand
          </button>
        ));
      },
    });
    click(one('button'));
    expect(saved).toEqual([['a', 'b']]);
    expect(handed).toEqual(['a', 'b']);
    expect(writes).toEqual([]);
    // An arrow's parameter is whoever called the arrow's: nothing to say.
    expect(errors.mock.calls.filter((call) => String(call[0]).startsWith('[SoftN]'))).toEqual([]);
  });

  it('changes a copy of a state list made with slice or a spread, and not state', () => {
    const saved: unknown[] = [];
    const save = (...values: unknown[]) => saved.push(JSON.parse(JSON.stringify(values)));
    const items = [3, 1, 2];
    const { writes, one } = drawPage('<button @click={() => save(items.slice().sort(), [...items].reverse())}>go</button>', { items }, { functions: { save } });
    click(one('button'));
    expect(saved).toEqual([[[1, 2, 3], [2, 1, 3]]]);
    expect(writes).toEqual([]);
    expect(items).toEqual([3, 1, 2]);
  });
});

// ── While the page is drawn ─────────────────────────────────────────────────

describe('a method that changes a list, while the page is drawn', () => {
  it('shows a state list reversed, the same way at every drawing, and leaves state alone', () => {
    const list = ['a', 'b', 'c'];
    const { state, all, one, writes } = drawPage(
      '#each (x in list.reverse()) key={x}\n<i>{x}</i>\n#end\n<button @click={n = n + 1}>again</button><p>{n}</p>',
      { list, n: 0 }
    );
    const drawn = () => all('i').map((i) => i.textContent).join('');
    expect(drawn()).toBe('cba');
    click(one('button'));
    expect(drawn()).toBe('cba');
    click(one('button'));
    expect(drawn()).toBe('cba');
    expect(state().list).toBe(list);
    expect(list).toEqual(['a', 'b', 'c']);
    expect(writes.map(([path]) => path)).toEqual(['n', 'n']);
  });

  it('shows a state list sorted and leaves state in the order it was in', () => {
    const list = [3, 1, 2];
    const { state, text } = drawPage('<p>{list.sort().join(",")}</p><b>{list.join(",")}</b>', { list });
    expect(text('p')).toBe('1,2,3');
    expect(text('b')).toBe('3,1,2');
    expect(state().list).toBe(list);
    expect(list).toEqual([3, 1, 2]);
  });

  it.each([
    ['push', '{items.push(4)}', '4'],
    ['pop', '{items.pop()}', '3'],
    ['shift', '{items.shift()}', '1'],
    ['unshift', '{items.unshift(0)}', '4'],
    ['splice', '{items.splice(0, 2).join("")}', '12'],
    ['fill', '{items.fill(0).join("")}', '000'],
    ['copyWithin', '{items.copyWithin(0, 1).join("")}', '233'],
  ])('makes %s on a copy, says so once, and changes nothing', (_name, markup, shows) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const items = [1, 2, 3];
    const { writes, text, one } = drawPage(`<p>${markup}</p><button @click={n = n + 1}>again</button>`, { items, n: 0 });
    expect(text('p')).toBe(shows);
    click(one('button'));
    expect(text('p')).toBe(shows);
    expect(items).toEqual([1, 2, 3]);
    expect(writes.map(([path]) => path)).toEqual(['n']);
    const said = errors.mock.calls.map((call) => String(call[0])).filter((message) => message.includes('while the page is being drawn'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"items.');
    expect(said[0]).toContain('on line 1');
  });

  it('leaves alone the lists inside a state list that an arrow is handed', () => {
    const rows = [[3, 1], [2, 0]];
    const { text } = drawPage('<p>{rows.map((row) => row.sort().join("")).join("|")}</p>', { rows });
    expect(text('p')).toBe('13|02');
    expect(rows).toEqual([[3, 1], [2, 0]]);
  });

  it('leaves alone a collection’s records, a computed list and a prop', () => {
    const notes = [{ t: 'a' }, { t: 'b' }];
    const sorted = ['x', 'y'];
    const given = [2, 1];
    const { text } = drawPage('<p>{notes.reverse().map((note) => note.t).join("")}|{byName.reverse().join("")}|{given.sort().join("")}</p>', {}, {
      data: { notes },
      computed: { byName: sorted },
      props: { given },
    });
    expect(text('p')).toBe('ba|yx|12');
    expect(notes).toEqual([{ t: 'a' }, { t: 'b' }]);
    expect(sorted).toEqual(['x', 'y']);
    expect(given).toEqual([2, 1]);
  });

  it('changes a list markup made itself where it lies, as JavaScript does', () => {
    const { text } = drawPage(
      '<p>{[3, 1, 2].sort().join("")}|{[1, 2, 3].reduce((acc, n) => { acc.push(n * 2); return acc }, []).join("")}|{items.filter((n) => n > 1).reverse().join("")}|{items.slice().sort().join("")}</p>',
      { items: [3, 1, 2] }
    );
    expect(text('p')).toBe('123|246|23|123');
  });

  it('leaves state alone in an arrow a component calls as it draws', () => {
    const list = [3, 1, 2];
    const { writes, text } = drawPage('<Shows format={(given) => given.sort().join("")} rows={list} also={() => list.reverse().join("")} />', { list }, {
      register: (registry) => {
        registry.register('Shows', ({ format, rows, also }: { format?: (rows: number[]) => string; rows?: number[]; also?: () => string }) => (
          <p>
            {format?.(rows ?? [])}|{also?.()}
          </p>
        ));
      },
    });
    expect(text('p')).toBe('123|213');
    expect(list).toEqual([3, 1, 2]);
    expect(writes).toEqual([]);
  });
});

// ── A page and its logic, on each engine and thread ─────────────────────────

const shown = () => container?.querySelector('#out')?.textContent ?? '';

async function mountPage(source: string, props: Partial<SoftNRendererProps> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<SoftNRenderer source={source} appId="list-methods-in-markup" scriptExecutionMode="main" {...props} />);
  });
  for (let i = 0; i < 150 && !shown().startsWith('yes|'); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
  expect(shown()).toBe('yes|a,b|ba|');
}

async function press(id: string, expected: string): Promise<string> {
  await act(async () => {
    (container!.querySelector(`#${id}`) as HTMLElement).click();
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

const MARKUP = `<div>
<button id="push" @click={() => items.push("c")}>push</button>
<button id="count" @click={count()}>count</button>
<button id="add" @click={add("d")}>add</button>
<p id="out">{loaded}|{items.join(",")}|{items.reverse().join("")}|{seen}</p>
</div>`;

const LOGIC = `<logic>
let loaded = 'yes'
let items = ['a', 'b']
let seen = ''
function count() { seen = seen + items.length + ';' }
function add(value) { items = items.concat([value]) }
</logic>`;

/** Push from the page, ask the logic how many there are, then let the logic add one. */
async function pushCountAdd(): Promise<void> {
  // Drawn at once, with no other change to draw it; and state is not turned round by the reverse beside it.
  expect(await press('push', 'yes|a,b,c|cba|')).toBe('yes|a,b,c|cba|');
  // The logic has the entry.
  expect(await press('count', 'yes|a,b,c|cba|3;')).toBe('yes|a,b,c|cba|3;');
  // And what the logic writes next does not take it away.
  expect(await press('add', 'yes|a,b,c,d|dcba|3;')).toBe('yes|a,b,c,d|dcba|3;');
}

describe('a state list changed from the page, with the logic on the main thread', () => {
  it('is drawn, and the logic has it', async () => {
    await mountPage(`${LOGIC}\n${MARKUP}`);
    await pushCountAdd();
  });
});

describe('a state list changed from the page, with the logic in the worker', () => {
  it('is drawn, and the logic has it', async () => {
    await withInProcessWorker(async () => {
      await mountPage(`${LOGIC}\n${MARKUP}`, { scriptExecutionMode: 'worker', executionPreference: 'worker' });
      await pushCountAdd();
    });
  });
});

describe.skipIf(!logicEngineRunsPython())('a state list changed from the page, with the logic in Python', () => {
  const python = {
    files: {
      app: [
        'loaded = "yes"',
        'items = ["a", "b"]',
        'seen = ""',
        '',
        'def count():',
        '    global seen',
        '    seen = seen + str(len(items)) + ";"',
        '',
        'def add(value):',
        '    global items',
        '    items = items + [value]',
        '',
      ].join('\n'),
    },
    modules: ['app'],
  };

  it('is drawn, and the logic has it', async () => {
    await mountPage(`${MARKUP}\n<logic>\n</logic>`, { python });
    await pushCountAdd();
  });
});
