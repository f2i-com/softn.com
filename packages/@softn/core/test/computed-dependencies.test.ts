/**
 * A `$:` value read from logic: by another `$:` value, and by a function.
 *
 * `$: double = n * 2` declares a value that is worked out from state. A page
 * read it live — the renderer re-evaluated the expression at every draw —
 * but logic did not. To the engine the line was one assignment, run once as
 * the script loaded, so inside logic the name held its first value for good:
 *
 *   $: double = n * 2
 *   $: quad = double * 2          // 4, whatever n became
 *   function label() { return "x" + double }   // "x2", whatever n became
 *
 * Nothing failed. A list filtered from a list that was itself `$:` stayed
 * empty, and a function that looped over one looped over nothing. And written
 * the other way round — `quad` above `double` — the script did not load at
 * all: "ReferenceError: double is not defined".
 *
 * What these hold is what the declaration says: the value is the expression,
 * as the state stands, wherever it is read. It is brought up to date before a
 * function runs and before a page is drawn, each value after the ones it
 * reads, whatever order they are written in.
 *
 * Against the real engine: the defect was in what the engine was handed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createScriptRuntime,
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { LogicBlock } from '../src/parser/ast';

type Loaded = Awaited<ReturnType<ReturnType<typeof createScriptRuntime>['loadScript']>>;

const open: Array<() => void> = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.();
  vi.restoreAllMocks();
});

/** Load logic into a runtime of its own, the way a page's logic block is loaded. */
async function load(code: string): Promise<{
  /** The state a page would read, kept in step as the renderer keeps it. */
  state: Record<string, unknown>;
  /** A `$:` value, as a page reads it. */
  value: (name: string) => unknown;
  /** A function called from a page's markup, for its answer. */
  ask: (name: string, ...args: unknown[]) => unknown;
  /** A function called as a handler. */
  call: (name: string, ...args: unknown[]) => Promise<unknown>;
  /** State written from the page's side — a bound input — as the renderer tells the runtime of it. */
  write: (changes: Record<string, unknown>) => void;
  names: { state: string[]; computed: string[] };
}> {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(context);
  open.push(() => runtime.cleanup());
  const block: LogicBlock = { type: 'LogicBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
  const loaded: Loaded = await runtime.loadScript(block);
  Object.assign(state, loaded.state);
  return {
    state,
    value: (name) => loaded.computed[name](),
    ask: (name, ...args) => loaded.syncFunctions[name](...args),
    call: (name, ...args) => loaded.functions[name](...args),
    write: (changes) => runtime.updateContext(changes),
    names: { state: Object.keys(loaded.state), computed: Object.keys(loaded.computed) },
  };
}

describe('a $: value built on another', () => {
  it('follows the state under both', async () => {
    const app = await load(`
      let n = 1
      $: double = n * 2
      $: quad = double * 2
      function bump() { n = n + 1 }
    `);
    expect([app.value('double'), app.value('quad')]).toEqual([2, 4]);
    await app.call('bump');
    expect([app.value('double'), app.value('quad')]).toEqual([4, 8]);
    await app.call('bump');
    expect([app.value('double'), app.value('quad')]).toEqual([6, 12]);
  });

  it('follows through a chain of three', async () => {
    const app = await load(`
      let n = 1
      $: double = n * 2
      $: quad = double * 2
      $: label = "quad is " + quad
      function set(value) { n = value }
    `);
    expect(app.value('label')).toBe('quad is 4');
    await app.call('set', 10);
    expect([app.value('double'), app.value('quad'), app.value('label')]).toEqual([20, 40, 'quad is 40']);
  });

  it('follows whatever order they are written in', async () => {
    // Written this way round the script used not to load: the line for
    // `label` ran, as an assignment, before `quad` had ever been assigned.
    const app = await load(`
      let n = 1
      $: label = "quad is " + quad
      $: quad = double * 2
      $: double = n * 2
      function bump() { n = n + 1 }
    `);
    expect([app.value('double'), app.value('quad'), app.value('label')]).toEqual([2, 4, 'quad is 4']);
    await app.call('bump');
    expect([app.value('double'), app.value('quad'), app.value('label')]).toEqual([4, 8, 'quad is 8']);
  });

  it('follows a list, and a list filtered from that list', async () => {
    // The shape a to-do list is written in: the records, the ones still to
    // do worked out from the records, and the ones shown worked out from
    // those. `shown` was the empty list `active` first was, for good.
    const app = await load(`
      let todos = []
      let filter = "all"
      $: active = todos.filter(t => !t.done)
      $: done = todos.filter(t => t.done)
      $: shown = filter === "active" ? active : filter === "done" ? done : todos
      $: summary = active.length + " of " + todos.length + " to do"
      function add(title) { todos = [...todos, { title: title, done: false }] }
      function finish(title) { todos = todos.map(t => t.title === title ? { title: t.title, done: true } : t) }
      function show(which) { filter = which }
    `);
    const titles = (name: string) => (app.value(name) as Array<{ title: string }>).map((t) => t.title);
    expect(titles('shown')).toEqual([]);
    await app.call('add', 'write');
    await app.call('add', 'test');
    await app.call('finish', 'write');
    expect(titles('shown')).toEqual(['write', 'test']);
    expect(app.value('summary')).toBe('1 of 2 to do');
    await app.call('show', 'active');
    expect(titles('shown')).toEqual(['test']);
    await app.call('show', 'done');
    expect(titles('shown')).toEqual(['write']);
    await app.call('finish', 'test');
    expect(titles('shown')).toEqual(['write', 'test']);
    expect(app.value('summary')).toBe('0 of 2 to do');
  });

  it('follows state a page wrote, not only state a function wrote', async () => {
    // A bound input writes state from the page's side; nothing in logic runs.
    const app = await load(`
      let name = ""
      $: trimmed = name.trim()
      $: greeting = trimmed === "" ? "Hi" : "Hi " + trimmed
      function shout() { return greeting.toUpperCase() }
    `);
    expect(app.value('greeting')).toBe('Hi');
    app.write({ name: '  Ada ' });
    expect(app.value('greeting')).toBe('Hi Ada');
    expect(app.ask('shout')).toBe('HI ADA');
    app.write({ name: 'Grace' });
    expect(app.ask('shout')).toBe('HI GRACE');
    expect(app.value('greeting')).toBe('Hi Grace');
  });
});

describe('a function that reads a $: value', () => {
  it('reads the value as it is now, asked from a page', async () => {
    const app = await load(`
      let n = 1
      $: double = n * 2
      function readDouble() { return double }
      function bump() { n = n + 1 }
    `);
    expect(app.ask('readDouble')).toBe(2);
    await app.call('bump');
    expect(app.ask('readDouble')).toBe(4);
    await app.call('bump');
    expect(app.ask('readDouble')).toBe(6);
  });

  it('reads the value as it is now, called as a handler', async () => {
    // What a "clear completed" does: loop over a list that is a `$:` value.
    // It looped over the empty list the value first was, and cleared nothing.
    const app = await load(`
      let todos = [{ id: 1, done: true }, { id: 2, done: false }, { id: 3, done: true }]
      let cleared = []
      $: done = todos.filter(t => t.done)
      function finish(id) { todos = todos.map(t => t.id === id ? { id: t.id, done: true } : t) }
      function clearDone() {
        for (const todo of done) cleared = [...cleared, todo.id]
        todos = todos.filter(t => !t.done)
      }
    `);
    await app.call('finish', 2);
    await app.call('clearDone');
    expect(app.state.cleared).toEqual([1, 2, 3]);
    expect(app.state.todos).toEqual([]);
    expect(app.value('done')).toEqual([]);
  });

  it('and a $: value that calls such a function follows too', async () => {
    // Nothing in `viaFunction`'s own words says it reads `double`.
    const app = await load(`
      let n = 1
      $: viaFunction = twice() + 1
      $: double = n * 2
      function twice() { return double * 2 }
      function bump() { n = n + 1 }
    `);
    expect(app.value('viaFunction')).toBe(5);
    await app.call('bump');
    expect(app.value('viaFunction')).toBe(9);
    expect(app.ask('twice')).toBe(8);
  });

  it('is given the value from before it ran, for a change it makes itself', async () => {
    // The values are brought up to date before a function is called, not
    // while it runs: a function that changes `n` and then reads `double`
    // reads what `double` was when it was called. A value it needs after its
    // own change is one it works out, or reads on the next call.
    const app = await load(`
      let n = 1
      let seen = 0
      $: double = n * 2
      function bumpAndLook() { n = n + 1; seen = double }
      function look() { seen = double }
    `);
    await app.call('bumpAndLook');
    expect(app.state.seen).toBe(2);
    await app.call('look');
    expect(app.state.seen).toBe(4);
  });
});

describe('what a $: declaration is to the rest of the script', () => {
  it('has its first value where the script reads it while loading, as it did', async () => {
    const app = await load(`
      let n = 1
      $: double = n * 2
      let first = "double began as " + double
    `);
    expect(app.state.first).toBe('double began as 2');
  });

  it('is read whatever ends its line, and over several lines inside brackets', async () => {
    // The script is compiled with each `$:` expression handed to a function
    // generated for it, so where an expression ends is where the rest of the
    // script begins again: at a semicolon, at a comment, at the line's end.
    const app = await load(`
      let n = 1
      $: double = n * 2; // twice n
      $: list = [
        n,
        double, // and a comment inside
      ]
      $: label = \`\${double}!\` // a note; with a semicolon in it
      let after = double + 1; let last = list.length
      function bump() { n = n + 1 }
    `);
    expect(app.state.after).toBe(3);
    expect(app.state.last).toBe(2);
    expect([app.value('double'), app.value('list'), app.value('label')]).toEqual([2, [1, 2], '2!']);
    await app.call('bump');
    expect([app.value('double'), app.value('list'), app.value('label')]).toEqual([4, [2, 4], '4!']);
  });

  it('written inside a function is that function’s assignment, as it was', async () => {
    // Only a declaration at the top of the script is a computed value kept
    // up to date. Inside a function `$:` is a label on an ordinary
    // assignment, to a local the generated code could not reach.
    const app = await load(`
      let n = 1
      let seen = 0
      function look() {
        let local = n + 10
        $: doubled = local * 2
        seen = doubled
      }
    `);
    await app.call('look');
    expect(app.state.seen).toBe(22);
  });

  it('is a computed value and not state, even where the script also declares the name', async () => {
    // `let double = 0` beside `$: double = …` made `double` state as well,
    // and a page reads state before it reads a computed value: it was shown
    // the first value and never another.
    const app = await load(`
      let n = 1
      let double = 0
      $: double = n * 2
      function bump() { n = n + 1 }
    `);
    expect(app.names.computed).toEqual(['double']);
    expect(app.names.state).toEqual(['n']);
    await app.call('bump');
    expect(app.value('double')).toBe(4);
    expect('double' in app.state).toBe(false);
  });

  it('that cannot be worked out is undefined, says why, and does not take the others with it', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await load(`
      let n = 1
      let settings = null
      $: theme = settings.theme
      $: double = n * 2
      function bump() { n = n + 1 }
      function open() { settings = { theme: "dark" } }
    `);
    expect(app.value('theme')).toBeUndefined();
    expect(app.value('double')).toBe(2);
    await app.call('bump');
    expect(app.value('double')).toBe(4);
    expect(said.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toMatch(
      /\[SoftN\] Error evaluating computed "theme"/
    );
    // And it is worked out once it can be.
    await app.call('open');
    expect(app.value('theme')).toBe('dark');
  });
});

describe('$: values that read each other in a circle', () => {
  it('are said to, by name, and the script still runs', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await load(`
      let n = 1
      $: a = b + 1
      $: b = a + n
      $: double = n * 2
      function bump() { n = n + 1 }
    `);
    const messages = said.mock.calls.map((call) => call.map(String).join(' '));
    expect(messages.filter((message) => message.includes('circle'))).toEqual([
      '[SoftN] These $: values read each other in a circle: a → b → a. None of them can be worked out before the others, so each is worked out once, in the order written, from what the others were.',
    ]);
    // Nothing waits on them: the values outside the circle are right, and a
    // call returns.
    expect(app.value('double')).toBe(2);
    await app.call('bump');
    expect(app.value('double')).toBe(4);
    expect(typeof app.value('a')).toBe('number');
  });
});
