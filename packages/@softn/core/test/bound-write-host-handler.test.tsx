/**
 * Who is told of a `:bind` write in place of the write.
 *
 * A host that keeps a page's state itself gives a function for it:
 * `on<Name>Change(path, value)`, or `onUpdate(path, value)` for every name.
 * The renderer looked for those among all the functions a page can call,
 * and an app's own logic functions are among them. So
 *
 *     <input :bind={query} @change={onQueryChange} />
 *     function onQueryChange(value) { … }
 *
 * never wrote `query`: the app's function was called with the path where
 * the write should have been made, and the field stayed empty. A logic
 * function called `onUpdate` did that to every binding on the page.
 *
 * Only a function the host gave is the host's. The first half holds the
 * renderer to that; the second is a page with the logic on each engine.
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

// ── The renderer ────────────────────────────────────────────────────────────

describe('a function of the app’s own named like a host’s change handler', () => {
  it('is not told of the write in place of it: on<Name>Change', () => {
    const calls: unknown[][] = [];
    const onQueryChange = (...args: unknown[]) => calls.push(args);
    // As SoftNRenderer hands them over: the app's and the host's in one table,
    // and the host's own said apart.
    const { writes, state, one } = drawPage('<input :bind={query} @change={onQueryChange} />', { query: '' }, {
      functions: { onQueryChange },
      hostFunctions: {},
    });
    typeInto(one('input'), 'abc');
    expect(writes).toEqual([['query', 'abc']]);
    expect(state().query).toBe('abc');
    expect(one<HTMLInputElement>('input').value).toBe('abc');
    // Called once, as the handler it was written as, with the value.
    expect(calls).toEqual([['abc']]);
  });

  it('is not told of every write on the page: onUpdate', () => {
    const calls: unknown[][] = [];
    const { writes, state, one } = drawPage(
      '<input :bind={name} /><input type="checkbox" :bind={done} /><button @click={onUpdate()}>go</button>',
      { name: '', done: false },
      { functions: { onUpdate: (...args: unknown[]) => calls.push(args) }, hostFunctions: {} }
    );
    typeInto(one('input:not([type])'), 'Ada');
    click(one('input[type=checkbox]'));
    expect(writes).toEqual([['name', 'Ada'], ['done', true]]);
    expect(state()).toEqual({ name: 'Ada', done: true });
    expect(calls).toEqual([]);
    click(one('button'));
    expect(calls).toEqual([[]]);
  });

  it('is not told of a write to a prop either: the prop is read-only, and said to be', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: unknown[][] = [];
    const { writes, one } = drawPage('<input :bind={title} />', {}, {
      props: { title: 'Given' },
      functions: { onTitleChange: (...args: unknown[]) => calls.push(args) },
      hostFunctions: {},
    });
    typeInto(one('input'), 'Mine');
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
    expect(warned.mock.calls.some((call) => String(call[0]).includes('Cannot update prop "title"'))).toBe(true);
  });
});

describe('a function the host gave to be told of a write', () => {
  it('is told, with the path and the value, and state is left to it', () => {
    const told: unknown[][] = [];
    const onQueryChange = (...args: unknown[]) => told.push(args);
    const { writes, one } = drawPage('<input :bind={query} />', { query: '' }, {
      functions: { onQueryChange },
      hostFunctions: { onQueryChange },
    });
    typeInto(one('input'), 'abc');
    expect(told).toEqual([['query', 'abc']]);
    expect(writes).toEqual([]);
  });

  it('is told of every write when it is onUpdate', () => {
    const told: unknown[][] = [];
    const onUpdate = (...args: unknown[]) => told.push(args);
    const { writes, one } = drawPage('<input :bind={form.name} /><input type="checkbox" :bind={done} />', { form: { name: '' }, done: false }, {
      functions: { onUpdate },
      hostFunctions: { onUpdate },
    });
    typeInto(one('input:not([type])'), 'Ada');
    click(one('input[type=checkbox]'));
    expect(told).toEqual([['form.name', 'Ada'], ['done', true]]);
    expect(writes).toEqual([]);
  });

  it('is told of a write to a prop it handed down', () => {
    const told: unknown[][] = [];
    const onItemsChange = (...args: unknown[]) => told.push(args);
    const { writes, all } = drawPage('#each (item in items) key={item.label}\n<input :bind={item.label} />\n#end', {}, {
      props: { items: [{ label: 'One' }, { label: 'Two' }] },
      functions: { onItemsChange },
      hostFunctions: { onItemsChange },
    });
    typeInto(all('input')[1], 'Deux');
    expect(told).toEqual([['items[1].label', 'Deux']]);
    expect(writes).toEqual([]);
  });

  it('is every function of a context made by hand, which holds no logic of an app', () => {
    // No `hostFunctions`: a host that draws a document itself gave them all.
    const told: unknown[][] = [];
    const { writes, one } = drawPage('<input :bind={query} />', { query: '' }, {
      functions: { onQueryChange: (...args: unknown[]) => told.push(args) },
    });
    typeInto(one('input'), 'abc');
    expect(told).toEqual([['query', 'abc']]);
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
    root.render(<SoftNRenderer source={source} appId="bound-write-host-handler" scriptExecutionMode="main" {...props} />);
  });
  for (let i = 0; i < 150 && !shown().startsWith('yes|'); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
  expect(shown()).toBe('yes|||');
}

async function typeAndWait(selector: string, text: string, expected: string): Promise<string> {
  await act(async () => {
    const input = container!.querySelector(selector) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
<input id="q" :bind={query} @change={onQueryChange} />
<input id="n" :bind={name} />
<p id="out">{loaded}|{query}|{name}|{heard}</p>
</div>`;

const LOGIC = `<logic>
let loaded = 'yes'
let query = ''
let name = ''
let heard = ''
function onQueryChange(value) { heard = heard + 'change:' + value + ';' }
function onUpdate(path, value) { heard = heard + 'update:' + path + ';' }
</logic>`;

describe('an app whose logic has an onQueryChange and an onUpdate, on the main thread', () => {
  it('keeps what is typed, and calls its handler as a handler', async () => {
    await mountPage(`${LOGIC}\n${MARKUP}`);
    expect(await typeAndWait('#q', 'abc', 'yes|abc||change:abc;')).toBe('yes|abc||change:abc;');
    expect((container!.querySelector('#q') as HTMLInputElement).value).toBe('abc');
    expect(await typeAndWait('#n', 'Ada', 'yes|abc|Ada|change:abc;')).toBe('yes|abc|Ada|change:abc;');
  });

  it('still hands the write to a function the host gave', async () => {
    const told: unknown[][] = [];
    // The runtime also asks a host's function, with nothing, what it is worth
    // to the logic (external-values.ts); what it is told of a write has a path.
    await mountPage(`${LOGIC}\n${MARKUP}`, { functions: { onNameChange: (...args: unknown[]) => void (args.length > 0 && told.push(args)) } });
    expect(await typeAndWait('#n', 'Ada', 'yes|||')).toBe('yes|||');
    expect(told).toEqual([['name', 'Ada']]);
  });
});

describe('an app whose logic has an onQueryChange and an onUpdate, in the worker', () => {
  it('keeps what is typed, and calls its handler as a handler', async () => {
    await withInProcessWorker(async () => {
      await mountPage(`${LOGIC}\n${MARKUP}`, { scriptExecutionMode: 'worker', executionPreference: 'worker' });
      expect(await typeAndWait('#q', 'abc', 'yes|abc||change:abc;')).toBe('yes|abc||change:abc;');
      expect(await typeAndWait('#n', 'Ada', 'yes|abc|Ada|change:abc;')).toBe('yes|abc|Ada|change:abc;');
    });
  });
});

describe.skipIf(!logicEngineRunsPython())('an app whose Python logic has an onQueryChange and an onUpdate', () => {
  const python = {
    files: {
      app: [
        'loaded = "yes"',
        'query = ""',
        'name = ""',
        'heard = ""',
        '',
        'def onQueryChange(value):',
        '    global heard',
        '    heard = heard + "change:" + str(value) + ";"',
        '',
        'def onUpdate(path, value):',
        '    global heard',
        '    heard = heard + "update:" + str(path) + ";"',
        '',
      ].join('\n'),
    },
    modules: ['app'],
  };

  it('keeps what is typed, and calls its handler as a handler', async () => {
    await mountPage(`${MARKUP}\n<logic>\n</logic>`, { python });
    expect(await typeAndWait('#q', 'abc', 'yes|abc||change:abc;')).toBe('yes|abc||change:abc;');
    expect(await typeAndWait('#n', 'Ada', 'yes|abc|Ada|change:abc;')).toBe('yes|abc|Ada|change:abc;');
  });
});
