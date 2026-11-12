/**
 * A write through an index that is worked out.
 *
 *     #each (q in questions)
 *       <input :bind={answers[q.id]} />
 *     #end
 *
 * Typing wrote nothing and said nothing. The place a write goes to was read
 * from the expression, and only an index that was a bare name or a literal
 * was worked out; `q.id` and `count - 1` had no place. For `:bind` nothing
 * reported it, and `todos[count - 1].done = true` in a handler said so in
 * development only. A text key holding `]` or a quote was written into the
 * path as it stood, and the path was then split at the wrong place.
 *
 * Now any index is worked out, a text key is written so that it reads back
 * whole whatever it holds, and a write that still has no place (an index
 * that is nothing, or a promise) is reported, once, wherever it is written.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer, type SoftNRendererProps } from '../src/loader/SoftNRenderer';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import { click, drawPage, removeDrawnPages, typeInto } from './helpers/drawn-page';
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

/** What was said about a write that was not made. */
const notWritten = (errors: { mock: { calls: unknown[][] } }) =>
  errors.mock.calls.map((call) => String(call[0])).filter((message) => message.includes('was not written'));

// ── The renderer ────────────────────────────────────────────────────────────

describe('a control bound through an index that is worked out', () => {
  it('writes the answer of the question it is drawn for', () => {
    const { writes, state, all } = drawPage('#each (q in questions) key={q.id}\n<input :bind={answers[q.id]} />\n#end', {
      questions: [{ id: 'q1' }, { id: 'q2' }],
      answers: {},
    });
    typeInto(all('input')[1], 'yes');
    expect(writes).toEqual([['answers["q2"]', 'yes']]);
    expect(state().answers).toEqual({ q2: 'yes' });
    expect(all<HTMLInputElement>('input').map((input) => input.value)).toEqual(['', 'yes']);
  });

  it.each([
    ['arithmetic', '<input :bind={todos[count - 1].title} />', 'todos[1].title'],
    ['a field of a record', '<input :bind={values[selected.key]} />', 'values["b"]'],
    ['two indexes', '<input :bind={grid[row][col + 1]} />', 'grid[1][2]'],
    ['a template literal', '<input :bind={form[`field_${count}`]} />', 'form["field_2"]'],
    ['a call that answers at once', '<input :bind={values[selected.key.toUpperCase().toLowerCase()]} />', 'values["b"]'],
    ['a condition', '<input :bind={values[count > 1 ? "b" : "a"]} />', 'values["b"]'],
  ])('writes where %s leads', (_name, markup, path) => {
    const { writes, one } = drawPage(markup, {
      todos: [{ title: 'a' }, { title: 'b' }],
      count: 2,
      values: { a: '', b: '' },
      selected: { key: 'b' },
      grid: [[0, 0, 0], [0, 0, 0]],
      row: 1,
      col: 1,
      form: {},
    });
    typeInto(one('input'), 'new');
    expect(writes).toEqual([[path, 'new']]);
  });

  it('makes the rows of a list reached through such an index writable', () => {
    const { writes, all } = drawPage('#each (cell in grid[row + 1]) key={cell.id}\n<input :bind={cell.v} />\n#end', {
      grid: [[{ id: 'a', v: '' }], [{ id: 'b', v: '' }, { id: 'c', v: '' }]],
      row: 0,
    });
    typeInto(all('input')[1], 'x');
    expect(writes).toEqual([['grid[1][1].v', 'x']]);
  });
});

describe('an assignment through an index that is worked out', () => {
  it.each([
    ['an assignment', 'todos[count - 1].done = true', ['todos[1].done', true]],
    ['a compound assignment', 'totals[names[0]] += 5', ['totals["ada"]', 6]],
    ['an increment', 'todos[count - 1].n++', ['todos[1].n', 8]],
    ['an assignment in a block', '() => { todos[count - 2].done = true }', ['todos[0].done', true]],
  ])('writes %s where the index leads', (_name, handler, write) => {
    const { writes, one } = drawPage(`<button @click={${handler}}>go</button>`, {
      todos: [{ done: false, n: 1 }, { done: false, n: 7 }],
      count: 2,
      names: ['ada'],
      totals: { ada: 1 },
    });
    click(one('button'));
    expect(writes).toEqual([write]);
  });
});

describe('a text key that holds what a path is written with', () => {
  it.each([
    ['a closing bracket', 'it]em'],
    ['a double quote', 'say "hi"'],
    ['a single quote', "it's"],
    ['a quote and a bracket', '"]'],
    ['a backslash', 'C:\\temp\\x'],
    ['a backslash before a quote', 'a\\"b'],
    ['a dot', 'a.b'],
    ['brackets of its own', 'rows[0]'],
    ['spaces at its ends', ' padded '],
    ['nothing at all', ''],
  ])('is written whole: %s', (_name, key) => {
    const { state, one } = drawPage('<input :bind={answers[key]} /><p>{answers[key]}</p><button @click={answers[key] = "set"}>set</button>', {
      key,
      answers: { other: 1 },
    });
    typeInto(one('input'), 'typed');
    expect(state()).toEqual({ key, answers: { other: 1, [key]: 'typed' } });
    expect(one('p').textContent).toBe('typed');
    click(one('button'));
    expect(state()).toEqual({ key, answers: { other: 1, [key]: 'set' } });
  });

  it('is written whole as a literal, and as the key of a record a loop goes through', () => {
    const literal = drawPage('<input :bind={answers["a]b\\"c"]} />', { answers: {} });
    typeInto(literal.one('input'), 'v');
    expect(literal.state().answers).toEqual({ 'a]b"c': 'v' });

    const record = drawPage('#each (value, name in settings)\n<input :bind={value} />\n#end', { settings: { 'it"s]': 'old', plain: 'p' } });
    typeInto(record.all('input')[0], 'new');
    expect(record.state().settings).toEqual({ 'it"s]': 'new', plain: 'p' });
  });
});

describe('a write that has no place in state', () => {
  it('is reported, once, for a control whose index is nothing', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writes, one } = drawPage('<p>\n<input :bind={answers[current.id]} />\n</p>', { answers: {}, current: {} });
    typeInto(one('input'), 'a');
    typeInto(one('input'), 'ab');
    expect(writes).toEqual([]);
    const said = notWritten(errors);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"answers[current.id]" on line 2 was not written');
    expect(said[0]).toContain('came to nothing (undefined)');
  });

  it('is not written to a key called after the index when the index is a name that is nothing', () => {
    // It went to `answers["missing"]`: a key named after the variable.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writes, one } = drawPage('<input :bind={answers[missing]} />', { answers: {} });
    typeInto(one('input'), 'a');
    expect(writes).toEqual([]);
    expect(notWritten(errors)).toHaveLength(1);
    expect(notWritten(errors)[0]).toContain('"answers[missing]" on line 1 was not written');
  });

  it('is reported for an assignment and for an increment in a handler', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writes, all } = drawPage('<button @click={todos[picked.at].done = true}>a</button><button @click={todos[picked.at].n++}>b</button>', {
      todos: [{ done: false, n: 0 }],
      picked: {},
    });
    click(all('button')[0]);
    click(all('button')[0]);
    click(all('button')[1]);
    expect(writes).toEqual([]);
    const said = notWritten(errors);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('"todos[picked.at].done" on line 1 was not written');
    expect(said[1]).toContain('"todos[picked.at].n" on line 1 was not written');
  });

  it('is reported when the index is a logic call’s answer, which is not there yet', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writes, one } = drawPage('<button @click={todos[pick()].done = true}>a</button>', { todos: [{ done: false }] }, {
      functions: { pick: () => 0 },
      handlers: { pick: () => Promise.resolve(0) },
    });
    click(one('button'));
    expect(writes).toEqual([]);
    expect(notWritten(errors)).toHaveLength(1);
    expect(notWritten(errors)[0]).toContain('still on its way');
  });

  it('is reported for a key no page may write, and nothing is written', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writes, one } = drawPage('<input :bind={answers[key].polluted} />', { answers: {}, key: '__proto__' });
    typeInto(one('input'), 'x');
    expect(writes).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(notWritten(errors)).toHaveLength(1);
    expect(notWritten(errors)[0]).toContain('a key no page may write');
  });

  it('is reported when the index cannot be worked out, and the page stands', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writes, one } = drawPage('<input :bind={answers[JSON.parse(raw).id]} />', { answers: {}, raw: '{bad' });
    typeInto(one('input'), 'x');
    expect(writes).toEqual([]);
    expect(notWritten(errors)).toHaveLength(1);
    expect(notWritten(errors)[0]).toContain('could not be worked out');
  });

  it('does not take the page down when a loop’s list is reached through an index that throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { text } = drawPage('#each (x in lists[JSON.parse(raw).k])\n<i>{x}</i>\n#empty\n<p>none</p>\n#end', { lists: {}, raw: '{bad' });
    expect(text('p')).toBe('none');
  });

  it('is reported for a binding that is no path at all', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writes, one } = drawPage('<input :bind={first + last} />', { first: 'a', last: 'b' }, { anyDiagnostics: true });
    typeInto(one('input'), 'x');
    expect(writes).toEqual([]);
    expect(notWritten(errors)).toHaveLength(1);
    expect(notWritten(errors)[0]).toContain('only a name or a property path');
  });
});

// ── A page and its logic, on each engine and thread ─────────────────────────

const shown = () => container?.querySelector('#out')?.textContent ?? '';

async function mountPage(source: string, props: Partial<SoftNRendererProps> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<SoftNRenderer source={source} appId="computed-index-writes" scriptExecutionMode="main" {...props} />);
  });
  for (let i = 0; i < 150 && !shown().startsWith('yes|'); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
  expect(shown()).toBe('yes|||open|');
}

async function settle(what: () => void, expected: string): Promise<string> {
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

const typeIn = (at: number, text: string) => () => {
  const input = container!.querySelectorAll('input')[at] as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const pressButton = (id: string) => () => (container!.querySelector(`#${id}`) as HTMLElement).click();

const MARKUP = `<div>
#each (q in questions) key={q.id}
<input :bind={answers[q.id]} />
#end
<button id="last" @click={todos[count - 1].done = true}>last</button>
<button id="show" @click={show()}>show</button>
<p id="out">{loaded}|{answers.q1}|{answers["q]2"]}|{todos[1].done ? "done" : "open"}|{seen}</p>
</div>`;

const LOGIC = `<logic>
let loaded = 'yes'
let questions = [{ id: 'q1' }, { id: 'q]2' }]
let answers = {}
let count = 2
let todos = [{ done: false }, { done: false }]
let seen = ''
function show() { seen = answers['q1'] + ',' + answers['q]2'] + '/' + todos.map((todo) => (todo.done ? 1 : 0)).join('') }
</logic>`;

/** Answer both questions, tick the last todo, then ask the logic what it has. */
async function answerAndTick(): Promise<void> {
  expect(await settle(typeIn(0, 'x'), 'yes|x||open|')).toBe('yes|x||open|');
  expect(await settle(typeIn(1, 'y'), 'yes|x|y|open|')).toBe('yes|x|y|open|');
  expect(await settle(pressButton('last'), 'yes|x|y|done|')).toBe('yes|x|y|done|');
  expect(await settle(pressButton('show'), 'yes|x|y|done|x,y/01')).toBe('yes|x|y|done|x,y/01');
}

describe('writes through a worked-out index, with the logic on the main thread', () => {
  it('reach state and the logic', async () => {
    await mountPage(`${LOGIC}\n${MARKUP}`);
    await answerAndTick();
  });
});

describe('writes through a worked-out index, with the logic in the worker', () => {
  it('reach state and the logic', async () => {
    await withInProcessWorker(async () => {
      await mountPage(`${LOGIC}\n${MARKUP}`, { scriptExecutionMode: 'worker', executionPreference: 'worker' });
      await answerAndTick();
    });
  });
});

describe.skipIf(!logicEngineRunsPython())('writes through a worked-out index, with the logic in Python', () => {
  const python = {
    files: {
      app: [
        'loaded = "yes"',
        'questions = [{"id": "q1"}, {"id": "q]2"}]',
        'answers = {}',
        'count = 2',
        'todos = [{"done": False}, {"done": False}]',
        'seen = ""',
        '',
        'def show():',
        '    global seen',
        '    ticks = "".join(["1" if todo["done"] else "0" for todo in todos])',
        '    seen = str(answers.get("q1")) + "," + str(answers.get("q]2")) + "/" + ticks',
        '',
      ].join('\n'),
    },
    modules: ['app'],
  };

  it('reach state and the logic', async () => {
    await mountPage(`${MARKUP}\n<logic>\n</logic>`, { python });
    await answerAndTick();
  });
});
