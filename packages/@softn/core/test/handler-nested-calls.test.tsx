/**
 * A logic call written where a handler needs its value is waited for.
 *
 * `@click={save(currentDraft())}` called `save` with nothing. In a handler a
 * logic function is the version that tells the page what it changed, which
 * answers a promise; the expression went straight on, so `save` was handed
 * the promise, and a promise crosses into the logic as `null` (vm-args.ts).
 * `total() + 1` was the text "[object Promise]1", `ready() ? a() : b()` always
 * took the first branch, and `n = total()` wrote the promise into state. Two
 * apps shipped buttons that did nothing this way.
 *
 * Now a value that is still on its way is waited for where it is used: as an
 * argument, an operand, a condition, what a member is read from, an element
 * of a list or a record, the right side of an assignment. What a person wrote
 * first happens first, a handler with nothing to wait for runs at once as it
 * always did, and when the inner call fails the outer one is not made.
 *
 * The first half holds the evaluator to that with function tables made here,
 * where every call and answer can be seen. The second half is the defect as
 * the apps met it: a page, a button, and logic on each engine and thread.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer, type SoftNRendererProps } from '../src/loader/SoftNRenderer';
import { parse } from '../src/parser';
import { ComponentRegistry, renderDocument } from '../src/renderer';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import type { SoftNProps, SoftNRenderContext } from '../src/types';
import { withInProcessWorker } from './helpers/in-process-worker';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The evaluator, with functions made here ─────────────────────────────────

type Fn = (...args: unknown[]) => unknown;

const said = (value: unknown) => (value instanceof Promise ? 'a promise' : JSON.stringify(value));

/**
 * The handler a page gives a component for `source`, and what happened when
 * it ran. The functions answer the way the logic's do in a handler: a promise,
 * a little later. `calls` has a line for each call and each answer, in order.
 */
function handlerFor(source: string, options: { state?: Record<string, unknown>; asProp?: boolean } = {}) {
  const calls: string[] = [];
  const writes: Array<[string, unknown]> = [];
  const answers = (name: string, value: unknown, after = 2): Fn => (...args) => {
    calls.push(`${name}(${args.map(said).join(', ')})`);
    return new Promise((resolve) =>
      setTimeout(() => {
        calls.push(`${name} answered`);
        resolve(value);
      }, after)
    );
  };
  const asyncFunctions: Record<string, Fn> = {
    currentDraft: answers('currentDraft', { title: 'Hello' }),
    // The first takes longer than the second: asked together, they would answer out of order.
    first: answers('first', 'a', 25),
    second: answers('second', 'b', 1),
    total: answers('total', 41),
    user: answers('user', { name: 'Ada', tags: ['x', 'y'] }),
    ready: answers('ready', false),
    save: answers('save', 'saved'),
    join: answers('join', 'joined'),
    close: answers('close', undefined),
    slow: answers('slow', 'late', 120),
    refuses: () => {
      calls.push('refuses()');
      const refused = Promise.reject(new Error('nope'));
      // Heard here, so that a run without the fix fails on what it asserts
      // and not on a rejection nobody heard.
      refused.catch(() => {});
      return refused;
    },
    // A host's function that answers at once.
    plain: (...args) => {
      calls.push(`plain(${args.map(said).join(', ')})`);
      return args[0];
    },
  };
  const context: SoftNRenderContext = {
    state: options.state ?? {},
    setState: (path, value) => {
      writes.push([path, value]);
    },
    data: {},
    props: {},
    computed: {},
    // While the page is drawn nothing here is called; a handler gets the others.
    functions: {},
    asyncFunctions,
  };
  let given: SoftNProps = {};
  const registry = new ComponentRegistry();
  registry.register('Probe', (props: SoftNProps) => {
    given = props;
    return null;
  });
  const doc = parse(options.asProp ? `<Probe onGo={${source}} />` : `<Probe @go={${source}} />`);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  renderToStaticMarkup(renderDocument(doc, context, registry) as React.ReactElement);
  expect(typeof given.onGo, source).toBe('function');
  return { calls, writes, handler: given.onGo as Fn };
}

describe('a call inside a handler’s expression', () => {
  it('is waited for, and the outer call is made with what it answered', async () => {
    const { calls, handler } = handlerFor('save(currentDraft())');
    await expect(handler()).resolves.toBe('saved');
    expect(calls).toEqual(['currentDraft()', 'currentDraft answered', 'save({"title":"Hello"})', 'save answered']);
  });

  it('is waited for in an on… prop as in an @event', async () => {
    const { calls, handler } = handlerFor('save(currentDraft())', { asProp: true });
    await handler();
    expect(calls).toContain('save({"title":"Hello"})');
  });

  it('is asked in the order written: each argument answers before the next is asked', async () => {
    const { calls, handler } = handlerFor('join(first(), second())');
    await expect(handler()).resolves.toBe('joined');
    expect(calls).toEqual(['first()', 'first answered', 'second()', 'second answered', 'join("a", "b")', 'join answered']);
  });

  it('goes as deep as it is written', async () => {
    const { calls, handler } = handlerFor('save(join(first(), plain(second())))');
    await handler();
    expect(calls.filter((line) => !line.endsWith('answered'))).toEqual(['first()', 'second()', 'plain("b")', 'join("a", "b")', 'save("joined")']);
  });

  it.each([
    ['a sum', 'save(total() + 1)', 'save(42)'],
    ['a sum on the right', 'save(1 + total())', 'save(42)'],
    ['a text', 'save("Hi " + first())', 'save("Hi a")'],
    ['a template literal', 'save(`${first()} and ${second()}`)', 'save("a and b")'],
    ['a comparison', 'save(total() > 40)', 'save(true)'],
    ['a not', 'save(!ready())', 'save(true)'],
    ['a typeof', 'save(typeof total())', 'save("number")'],
    ['a record', 'save({ draft: currentDraft(), n: total() })', 'save({"draft":{"title":"Hello"},"n":41})'],
    ['a record with a worked-out key', 'save({ [first()]: second() })', 'save({"a":"b"})'],
    ['a record it is spread into', 'save({ ...currentDraft(), done: true })', 'save({"title":"Hello","done":true})'],
    ['a list', 'save([first(), second(), 3])', 'save(["a","b",3])'],
    ['a list it is spread into', 'save([0, ...user().tags])', 'save([0,"x","y"])'],
    ['arguments it is spread into', 'join(...user().tags)', 'join("x", "y")'],
    ['a member', 'save(user().name)', 'save("Ada")'],
    ['an index', 'save(user().tags[1])', 'save("y")'],
    ['an index that is itself a call', 'save(user().tags[total() - 40])', 'save("y")'],
    ['a method of what it answers', 'save(first().toUpperCase())', 'save("A")'],
    ['what is constructed', 'save(new Date(total()).getTime())', 'save(41)'],
    ['an arrow’s body', '() => save(currentDraft())', 'save({"title":"Hello"})'],
  ])('is waited for in %s', async (_where, source, call) => {
    const { calls, handler } = handlerFor(source);
    await handler();
    expect(calls).toContain(call);
  });

  it('decides a condition by what it answered, and only the branch taken is called', async () => {
    const chosen = handlerFor('ready() ? save("yes") : save("no")');
    await expect(chosen.handler()).resolves.toBe('saved');
    expect(chosen.calls).toEqual(['ready()', 'ready answered', 'save("no")', 'save answered']);

    const and = handlerFor('ready() && save("ran")');
    await expect(and.handler()).resolves.toBe(false);
    expect(and.calls).toEqual(['ready()', 'ready answered']);

    const or = handlerFor('ready() || save("fallback")');
    await expect(or.handler()).resolves.toBe('saved');
    expect(or.calls).toEqual(['ready()', 'ready answered', 'save("fallback")', 'save answered']);

    // `false` is an answer, so `??` has nothing to fall back for.
    const nullish = handlerFor('ready() ?? save("nothing")');
    await expect(nullish.handler()).resolves.toBe(false);
    expect(nullish.calls).toEqual(['ready()', 'ready answered']);
  });

  it('writes what the call answered into state, not the promise', async () => {
    const plain = handlerFor('x = total()');
    await plain.handler();
    expect(plain.writes).toEqual([['x', 41]]);

    const added = handlerFor('x += total()', { state: { x: 1 } });
    await added.handler();
    expect(added.writes).toEqual([['x', 42]]);
  });

  it('runs a block’s statements in the order written', async () => {
    const { calls, handler } = handlerFor('() => { save(currentDraft()); close() }');
    await handler();
    expect(calls.filter((line) => !line.endsWith('answered'))).toEqual(['currentDraft()', 'save({"title":"Hello"})', 'close()']);
  });

  it('lets a later statement read what an earlier one wrote from a call', async () => {
    const { calls, writes, handler } = handlerFor('() => { n = total() + 1; save(n) }', { state: { n: 0 } });
    await handler();
    expect(writes).toEqual([['n', 42]]);
    expect(calls).toContain('save(42)');
  });

  it('goes on to the next statement once the outer call is made, without waiting for its answer, as before', async () => {
    const { calls, handler } = handlerFor('() => { slow(first()); close() }');
    await handler();
    await sleep(160);
    const made = calls.indexOf('slow("a")');
    expect(made).toBeGreaterThan(-1);
    expect(calls.indexOf('close()')).toBe(made + 1);
    expect(calls.indexOf('slow answered')).toBeGreaterThan(calls.indexOf('close()'));
  });

  it('does not make the outer call when the inner one fails, and fails as the inner one did', async () => {
    const { calls, handler } = handlerFor('save(refuses())');
    await expect(handler()).rejects.toThrow('nope');
    expect(calls).toEqual(['refuses()']);

    const block = handlerFor('() => { save(refuses()); close() }');
    await expect(block.handler()).rejects.toThrow('nope');
    expect(block.calls).toEqual(['refuses()']);
  });

  it('waits for a promise it was handed under a name as well', async () => {
    const { calls, handler } = handlerFor('(pending) => save(pending)');
    await handler(Promise.resolve(7));
    expect(calls).toContain('save(7)');
  });
});

describe('a handler with nothing to wait for', () => {
  it('answers at once, with a value and not a promise', () => {
    expect(handlerFor('() => count + 1', { state: { count: 1 } }).handler()).toBe(2);
    expect(handlerFor('plain(count + 1)', { state: { count: 1 } }).handler()).toBe(2);
    expect(handlerFor('() => [1, 2, 3].filter((n) => n > 1).map((n) => plain(n))').handler()).toEqual([2, 3]);
  });

  it('is still inside the event: what the event offers is called before the handler returns', () => {
    // The shape a real app copies with: the text worked out in the expression,
    // `setData` and `preventDefault()` both made arguments of a call so that
    // one expression does both while the clipboard event is still at hand.
    const { calls, handler } = handlerFor(
      '(e) => e.from === e.to ? e.preventDefault() : plain(e.clipboardData.setData("text/plain", text.slice(e.from, e.to)), e.preventDefault())',
      { state: { text: 'abcdef' } }
    );
    const done: string[] = [];
    const event = {
      from: 1,
      to: 4,
      preventDefault: () => done.push('preventDefault'),
      clipboardData: { setData: (type: string, text: string) => done.push(`setData ${type} ${text}`) },
    };
    handler(event);
    expect(done).toEqual(['setData text/plain bcd', 'preventDefault']);
    expect(calls).toHaveLength(1);
  });

  it('answers at once for a call that answers at once, wherever it is written', () => {
    expect(handlerFor('plain({ a: plain(1), b: [plain(2), ...plain([3])], c: `${plain(4)}` }).b.length + plain(1)').handler()).toBe(3);
  });

  it('writes state before it returns', () => {
    const { writes, handler } = handlerFor('() => { count = count + 1; twice = count * 2 }', { state: { count: 1 } });
    expect(handler()).toBeUndefined();
    expect(writes).toEqual([['count', 2], ['twice', 4]]);
  });

  it('makes its one call before it returns, and hands back that call’s own promise', async () => {
    const { calls, handler } = handlerFor('save(1)');
    const returned = handler();
    expect(calls).toEqual(['save(1)']);
    await expect(returned).resolves.toBe('saved');
  });

  it('makes every call of a block before it returns, none waiting for the one before', () => {
    const { calls, handler } = handlerFor('() => { slow(1); void slow(2); close() }');
    expect(handler()).toBeUndefined();
    expect(calls).toEqual(['slow(1)', 'slow(2)', 'close()']);
  });

  it('leaves a .then or a .catch written out to the promise it was written on', async () => {
    const { calls, handler } = handlerFor('currentDraft().then((draft) => save(draft.title))');
    await handler();
    expect(calls.filter((line) => !line.endsWith('answered'))).toEqual(['currentDraft()', 'save("Hello")']);

    const caught = handlerFor('refuses().catch((error) => save(error.message))');
    await caught.handler();
    expect(caught.calls.filter((line) => !line.endsWith('answered'))).toEqual(['refuses()', 'save("nope")']);
  });
});

describe('while the page is drawn', () => {
  it('nothing waits: an expression is worth what it was, and is not a promise', () => {
    const pending = Promise.resolve('late');
    let given: SoftNProps = {};
    const registry = new ComponentRegistry();
    registry.register('Probe', (props: SoftNProps) => {
      given = props;
      return null;
    });
    const context: SoftNRenderContext = {
      state: {},
      setState: () => {},
      data: {},
      props: {},
      computed: {},
      functions: { later: () => pending, wrap: (value: unknown) => ({ value }) },
      asyncFunctions: {},
    };
    renderToStaticMarkup(renderDocument(parse('<Probe held={wrap(later())} sum={1 + 2} />'), context, registry) as React.ReactElement);
    expect(given.held).toEqual({ value: pending });
    expect(given.sum).toBe(3);
  });
});

// ── A page and its logic, on each engine and thread ─────────────────────────

let root: Root | null = null;
let container: HTMLElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const LOGIC = `<logic>
let loaded = 'yes'
let log = ''
let got = ''
let n = 0
function note(what) { log = log + what + ';' }
function show(value) { got = value === undefined ? 'undefined' : JSON.stringify(value) }
function currentDraft() { note('draft'); return { title: 'Hello', words: 2 } }
function total() { note('total'); return 41 }
function first() { note('first'); return 'a' }
function second() { note('second'); return 'b' }
function user() { note('user'); return { name: 'Ada', tags: ['x', 'y'] } }
function ready() { note('ready'); return false }
function wrap(value) { note('wrap'); return { value: value } }
function save(value) { note('save'); show(value) }
function join(a, b) { note('join'); show([a, b]) }
function close() { note('close') }
function broken() { note('broken'); throw new Error('boom inner') }
</logic>`;

const page = (handler: string) => `${LOGIC}
<div><button id="b" @click={${handler}}>x</button><p id="out">{loaded}|{log}|{got}|{n}</p></div>`;

const shown = () => container.querySelector('#out')?.textContent ?? '';

const mount = (handler: string, props: Partial<SoftNRendererProps> = {}) => mountPage(page(handler), props);

async function mountPage(source: string, props: Partial<SoftNRendererProps> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} appId="handler-nested-calls" scriptExecutionMode="main" {...props} />);
  });
  // Until the logic has loaded: before it has, `loaded` is not on the page.
  for (let i = 0; i < 150 && !shown().startsWith('yes|'); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
  expect(shown()).toBe('yes|||0');
}

/** Press the button, and say what the page shows once the logic has gone quiet. */
async function press(expected: string): Promise<string> {
  await act(async () => {
    (container.querySelector('#b') as HTMLElement).click();
    await sleep(20);
  });
  for (let i = 0; i < 50 && shown() !== expected; i++) {
    await act(async () => {
      await sleep(20);
    });
  }
  // And a little longer, for a call that should not have been made.
  await act(async () => {
    await sleep(80);
  });
  return shown();
}

const DRAFT = '{"title":"Hello","words":2}';

/** Each handler, and what the page shows after it: the calls in order, what the last was handed, and `n`. */
const CASES: Array<[name: string, handler: string, shows: string]> = [
  ['an argument', 'save(currentDraft())', `yes|draft;save;|${DRAFT}|0`],
  ['two arguments, in the order written', 'join(first(), second())', 'yes|first;second;join;|["a","b"]|0'],
  ['a call inside a call inside a call', 'save(wrap(wrap(first())))', 'yes|first;wrap;wrap;save;|{"value":{"value":"a"}}|0'],
  ['a sum', 'save(total() + 1)', 'yes|total;save;|42|0'],
  ['a text', 'save("Hi " + first())', 'yes|first;save;|"Hi a"|0'],
  ['a template literal', 'save(`${first()} and ${second()}`)', 'yes|first;second;save;|"a and b"|0'],
  ['a record', 'save({ draft: currentDraft(), n: total() })', `yes|draft;total;save;|{"draft":${DRAFT},"n":41}|0`],
  ['a record it is spread into', 'save({ ...currentDraft(), done: true })', 'yes|draft;save;|{"title":"Hello","words":2,"done":true}|0'],
  ['a list', 'save([first(), second(), 3])', 'yes|first;second;save;|["a","b",3]|0'],
  ['a member', 'save(user().name)', 'yes|user;save;|"Ada"|0'],
  ['an index', 'save(user().tags[1])', 'yes|user;save;|"y"|0'],
  ['a method of what it answers', 'save(first().toUpperCase())', 'yes|first;save;|"A"|0'],
  ['a not', 'save(!ready())', 'yes|ready;save;|true|0'],
  ['a condition', 'ready() ? save("yes") : save("no")', 'yes|ready;save;|"no"|0'],
  ['an and that stops', 'ready() && save("ran")', 'yes|ready;||0'],
  ['an or that goes on', 'ready() || save("fallback")', 'yes|ready;save;|"fallback"|0'],
  ['an arrow', '() => save(currentDraft())', `yes|draft;save;|${DRAFT}|0`],
  ['a block of statements', '() => { save(currentDraft()); close() }', `yes|draft;save;close;|${DRAFT}|0`],
  ['an assignment', 'n = total()', 'yes|total;||41'],
  ['an assignment a later statement reads', '() => { n = total() + 1; save(n) }', 'yes|total;save;|42|42'],
];

describe('a logic call inside a handler’s expression, with the logic on the main thread', () => {
  it.each(CASES)('is waited for in %s', async (_name, handler, shows) => {
    await mount(handler);
    expect(await press(shows)).toBe(shows);
  });

  it.each([
    ['an HTML handler attribute', '<button id="b" onclick="save(currentDraft())">x</button>'],
    ['an on… prop written in braces', '<button id="b" onClick={save(currentDraft())}>x</button>'],
    ['an event with a modifier', '<form @submit.prevent={save(currentDraft())}><button id="b" type="submit">x</button></form>'],
  ])('is waited for in %s', async (_name, button) => {
    await mountPage(`${LOGIC}\n<div>${button}<p id="out">{loaded}|{log}|{got}|{n}</p></div>`);
    expect(await press(`yes|draft;save;|${DRAFT}|0`)).toBe(`yes|draft;save;|${DRAFT}|0`);
  });

  it('does not make the outer call when the inner one throws, and says what threw as for any handler', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await mount('save(broken())');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await press('yes|broken;||0')).toBe('yes|broken;||0');
      expect(errors.mock.calls.some((call) => call[0] === '[SoftN] Error executing function broken:')).toBe(true);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('stops a block at the statement whose inner call threw', async () => {
    await mount('() => { save(broken()); close() }');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await press('yes|broken;||0')).toBe('yes|broken;||0');
  });

  it('still runs the statement after a call that threw by itself, as before', async () => {
    await mount('() => { broken(); close() }');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await press('yes|broken;close;||0')).toBe('yes|broken;close;||0');
  });
});

// ── The worker, with the real worker script run in this realm ───────────────

describe('a logic call inside a handler’s expression, with the logic in the worker', () => {
  const inWorker = { scriptExecutionMode: 'worker', executionPreference: 'worker' } as const;

  it.each(CASES.filter(([name]) => ['an argument', 'two arguments, in the order written', 'a record', 'a member', 'a condition', 'a block of statements', 'an assignment'].includes(name)))(
    'is waited for in %s',
    async (_name, handler, shows) => {
      await withInProcessWorker(async () => {
        await mount(handler, inWorker);
        expect(await press(shows)).toBe(shows);
      });
    }
  );

  it('does not make the outer call when the inner one throws', async () => {
    await withInProcessWorker(async () => {
      await mount('save(broken())', inWorker);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await press('yes|broken;||0')).toBe('yes|broken;||0');
      expect(errors.mock.calls.some((call) => call[0] === '[SoftN] Error executing function broken:')).toBe(true);
    });
  });
});

// ── Python logic: the same handlers, the same wait ──────────────────────────

describe.skipIf(!logicEngineRunsPython())('a logic call inside a handler’s expression, with the logic in Python', () => {
  const python = {
    files: {
      app: [
        'loaded = "yes"',
        'log = ""',
        'got = ""',
        'n = 0',
        '',
        'def note(what):',
        '    global log',
        '    log = log + what + ";"',
        '',
        'def current_draft():',
        '    note("draft")',
        '    return {"title": "Hello", "words": 2}',
        '',
        'def total():',
        '    note("total")',
        '    return 41',
        '',
        'def save(value):',
        '    global got',
        '    note("save")',
        '    got = "nothing" if value is None else str(value["title"] if isinstance(value, dict) else value)',
        '',
        'def broken():',
        '    note("broken")',
        '    raise ValueError("boom inner")',
        '',
      ].join('\n'),
    },
    modules: ['app'],
  };
  // The empty <logic> block a Python composition leaves in the markup.
  const pythonPage = (handler: string) => `<div><button id="b" @click={${handler}}>x</button><p id="out">{loaded}|{log}|{got}|{n}</p></div>
<logic>
</logic>`;

  it.each([
    ['an argument', 'save(current_draft())', 'yes|draft;save;|Hello|0'],
    ['a sum', 'save(total() + 1)', 'yes|total;save;|42|0'],
    ['a member', 'save(current_draft().words)', 'yes|draft;save;|2|0'],
    ['an assignment', 'n = total()', 'yes|total;||41'],
  ])('is waited for in %s', async (_name, handler, shows) => {
    await mountPage(pythonPage(handler), { python });
    expect(await press(shows)).toBe(shows);
  });

  it('does not make the outer call when the inner one raises', async () => {
    await mountPage(pythonPage('save(broken())'), { python });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = await press('yes|broken;||0');
    expect(after).not.toContain('save;');
    expect(after.endsWith('||0')).toBe(true);
    expect(errors.mock.calls.some((call) => call[0] === '[SoftN] Error executing function broken:')).toBe(true);
  });
});
