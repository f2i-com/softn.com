/**
 * The apps the templates generate, run: each is drawn by the loader a host
 * uses, with its records in a store and its logic on the real engine, and is
 * used the way a person uses it. A record is added, edited, deleted and
 * searched for, through the fields and buttons the page draws, with the
 * components the page names as `@softn/components` has them.
 *
 * templates.test.ts holds what the generators write. This holds what they
 * wrote to working: the templates once wrote `:value={x}` on every field, so
 * nothing typed was kept; `state.showForm` for a variable; their filter as
 * code in the markup, which was drawn as words; `xdb.create`, where the
 * logic's records are `db`'s; and `confirm()`, which logic cannot wait on.
 *
 * The logic the templates write is JavaScript, so it runs on the page's
 * thread and in the worker; there is no Python of theirs to run. Under
 * vitest.host-js.config.ts the same tests run on the host-JavaScript engine,
 * which is the page's thread both times.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoftNWithXDB } from '../src/loader/xdb-bindings';
import type { SoftNRendererProps } from '../src/loader/SoftNRenderer';
import { parse } from '../src/parser';
import { registerComponent, type SoftNComponent } from '../src/renderer/registry';
import { logicEngineThreads } from '../src/runtime/vm-adapter';
import { getXDB } from '../src/runtime/xdb';
import {
  generateContactsApp,
  generateCrudApp,
  generateKanbanBoard,
  generateNotesApp,
  generateSimpleList,
  generateTodoApp,
} from '../src/templates';
import { InProcessWorker, withInProcessWorker } from './helpers/in-process-worker';
import { Confirm } from '../../components/src/feedback/Confirm';
import { Button } from '../../components/src/form/Button';
import { Checkbox } from '../../components/src/form/Checkbox';
import { Input } from '../../components/src/form/Input';
import { Select } from '../../components/src/form/Select';
import { TextArea } from '../../components/src/form/TextArea';
import { Card } from '../../components/src/layout/Card';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  for (const [name, component] of Object.entries({ Button, Card, Checkbox, Confirm, Input, Select, TextArea })) {
    registerComponent(name, component as unknown as SoftNComponent);
  }
  // jsdom lays nothing out and has no scrolling: an open Select brings its highlighted option into view.
  Element.prototype.scrollIntoView ??= () => {};
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A test is a whole visit to an app, and a step that never happens waits four
// seconds (`until`) before it says so: longer than a test is given by default.
vi.setConfig({ testTimeout: 30_000 });

/** Where the logic runs: the page's thread, or the worker (the real worker script, run in this realm). */
const THREADS: Array<[string, Partial<SoftNRendererProps>]> = [
  ['on the page’s thread', { scriptExecutionMode: 'main' }],
  ['in the worker', { scriptExecutionMode: 'worker', executionPreference: 'worker' }],
];

let root: Root | null = null;
let container: HTMLElement;
let opened = 0;
/** What the app or the loader said was wrong while a test ran. */
let complaints: string[] = [];

beforeEach(() => {
  localStorage.clear();
  complaints = [];
  for (const level of ['error', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation((...said: unknown[]) => {
      complaints.push(`${level}: ${said.map(String).join(' ').slice(0, 300)}`);
    });
  }
});

/** Take the app down, and let what was on its way to the worker, or back from it, arrive. */
async function close(): Promise<void> {
  if (root) {
    const current = root;
    root = null;
    await act(async () => current.unmount());
  }
  container?.remove();
  await act(async () => {
    await sleep(50);
  });
}

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
});

/**
 * Run `body` with the logic where `thread` says, and hold the run to having
 * said nothing was wrong, and to the worker having been what ran the logic
 * where the engine has one. The app is closed before the worker is put away:
 * a message still on its way would be answered to the page's own
 * `postMessage` once `withInProcessWorker` has put that back.
 */
async function onThread(thread: Partial<SoftNRendererProps>, body: () => Promise<void>): Promise<void> {
  const posted = vi.spyOn(InProcessWorker.prototype, 'postMessage');
  const visit = async () => {
    await body();
    await close();
  };
  if (thread.scriptExecutionMode === 'worker') {
    await withInProcessWorker(visit);
    if (logicEngineThreads() === 'any') {
      expect(posted.mock.calls.length, 'the logic ran in the worker').toBeGreaterThan(0);
    } else {
      // An engine that has the page's thread alone says once that it is not using the worker asked for.
      expect(posted).not.toHaveBeenCalled();
      expect(complaints).toEqual([expect.stringContaining('runs on the main thread only')]);
      return;
    }
  } else {
    await visit();
    expect(posted, 'the logic ran on the page’s thread').not.toHaveBeenCalled();
  }
  expect(complaints).toEqual([]);
}

/** What the page shows, for a failure to say. */
function shown(): string {
  const copy = document.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('style, svg').forEach((element) => element.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

/** Until `seen()` holds, the page is given time; `what` is said when it never does. */
async function until(seen: () => boolean, what: string): Promise<void> {
  const patience = Date.now() + 4000;
  while (!seen() && Date.now() < patience) {
    await act(async () => {
      await sleep(20);
    });
  }
  expect(seen(), `${what}\n${shown()}\n${complaints.join('\n')}`).toBe(true);
}

/**
 * Draw an app as a host does, in a store of its own that `seed` may fill
 * first, and wait for `ready`. Answers the app's id.
 */
async function open(
  source: string,
  thread: Partial<SoftNRendererProps>,
  ready: () => boolean,
  seed?: (appId: string) => void
): Promise<string> {
  expect(parse(source).diagnostics ?? []).toEqual([]);
  const appId = `templates-apps-${++opened}`;
  seed?.(appId);
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNWithXDB source={source} appId={appId} {...thread} />);
  });
  await until(ready, 'the app and its logic loaded');
  return appId;
}

/** The records a collection of the app holds, as its store has them. */
const stored = (appId: string, collection: string) => getXDB(appId).getAll(collection).map((record) => record.data);

async function press(element: Element | null | undefined): Promise<void> {
  expect(element, `nothing to press\n${shown()}`).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
    await sleep(30);
  });
}

/** Type into a field as a person does: the browser's `input` event. */
async function type(field: Element | null | undefined, value: string): Promise<void> {
  expect(field, `nothing to type into\n${shown()}`).toBeTruthy();
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(30);
  });
}

/** Choose the option that shows `option` from the Select whose closed field is `trigger`. */
async function choose(trigger: Element | null | undefined, option: string): Promise<void> {
  await press(trigger);
  await press([...container.querySelectorAll('[role="option"]')].find((element) => element.textContent?.trim() === option));
}

/** The button that shows `label` or is named it, the first on the page or in `within`. */
const button = (label: string, within: ParentNode = container) =>
  [...within.querySelectorAll('button')].find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label);

/** The form's fields, in the order of the template's fields: each the `.form-group` that holds one. */
const groups = () => [...container.querySelectorAll<HTMLElement>('.form-group')];
const fieldOf = (at: number) => groups()[at]?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type="hidden"]), textarea');
const selectOf = (at: number) => groups()[at]?.querySelector<HTMLElement>('[role="combobox"]');

/** The list: the text of each row's cells, without the last, which holds its buttons. */
const tableRows = () => [...container.querySelectorAll('tbody tr')];
const rows = () => tableRows().map((row) => [...row.querySelectorAll('td')].slice(0, -1).map((cell) => cell.textContent?.trim() ?? ''));
const firstCells = () => rows().map((cells) => cells[0]);
const rowOf = (first: string) => tableRows().find((row) => row.querySelector('td')?.textContent?.trim() === first);

/** The question a Delete asks, while it is asked. */
const question = () => document.body.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');

/** Press Delete on the row that starts `first`, and answer the question with the button that shows `answer`. */
async function deleteRow(first: string, answer: 'Delete' | 'Cancel'): Promise<void> {
  await press(button('Delete', rowOf(first)!));
  await until(() => Boolean(question()), 'the question is asked');
  expect(question()!.textContent).toContain('Delete this item?');
  await press(button(answer, question()!));
  await until(() => !question(), 'the question closed');
}

const crudIsReady = () => Boolean(button('Add New')) && (container.textContent ?? '').includes('No items yet');

describe.each(THREADS)('a generated CRUD app, with its logic %s', (_where, thread) => {
  it('todo: adds a record, edits it, finds it by a search, and deletes it once the person agrees', async () => {
    await onThread(thread, async () => {
      const appId = await open(generateTodoApp(), thread, crudIsReady);

      // Add: what is typed, ticked and chosen is what is stored.
      await press(button('Add New'));
      await until(() => groups().length === 3, 'the form opened');
      await type(fieldOf(0), 'Buy milk');
      await press(fieldOf(1));
      await choose(selectOf(2), 'high');
      await press(button('Create'));
      await until(() => rows().length === 1, 'the record is listed');
      expect(rows()).toEqual([['Buy milk', 'Yes', 'high']]);
      expect(stored(appId, 'todos')).toEqual([{ title: 'Buy milk', completed: true, priority: 'high' }]);
      expect(groups(), 'the form closed').toHaveLength(0);

      // A second, with what a new record starts as: not completed, medium.
      await press(button('Add New'));
      await until(() => groups().length === 3, 'the form opened again');
      expect(fieldOf(0)!.value).toBe('');
      expect((fieldOf(1) as HTMLInputElement).checked).toBe(false);
      expect(selectOf(2)!.textContent).toBe('medium');
      await type(fieldOf(0), 'Walk the dog');
      await press(button('Create'));
      await until(() => rows().length === 2, 'the second record is listed');
      expect(rows()).toEqual([
        ['Buy milk', 'Yes', 'high'],
        ['Walk the dog', 'No', 'medium'],
      ]);

      // Edit: the form holds the record, and Update changes it where it is.
      await press(button('Edit', rowOf('Buy milk')!));
      await until(() => Boolean(button('Update')), 'the form opened on the record');
      expect(fieldOf(0)!.value).toBe('Buy milk');
      expect((fieldOf(1) as HTMLInputElement).checked).toBe(true);
      expect(selectOf(2)!.textContent).toBe('high');
      await type(fieldOf(0), 'Buy oat milk');
      await press(fieldOf(1));
      await press(button('Update'));
      await until(() => Boolean(rowOf('Buy oat milk')), 'the change is listed');
      expect(rows()).toEqual([
        ['Buy oat milk', 'No', 'high'],
        ['Walk the dog', 'No', 'medium'],
      ]);
      expect(stored(appId, 'todos')).toEqual([
        { title: 'Buy oat milk', completed: false, priority: 'high' },
        { title: 'Walk the dog', completed: false, priority: 'medium' },
      ]);

      // Search: the list is the records that match, as each letter is typed.
      const search = container.querySelector<HTMLInputElement>('input[placeholder="Search..."]');
      await type(search, 'DOG');
      await until(() => rows().length === 1, 'the list is narrowed');
      expect(rows()).toEqual([['Walk the dog', 'No', 'medium']]);
      expect(search!.value).toBe('DOG');
      await type(search, 'nothing like it');
      await until(() => rows().length === 0, 'nothing matches');
      expect(container.textContent).toContain('No items match.');
      await type(search, '');
      await until(() => rows().length === 2, 'the list is whole again');

      // Delete: asked first, and the record stays when the answer is no.
      await deleteRow('Walk the dog', 'Cancel');
      expect(rows()).toHaveLength(2);
      await deleteRow('Walk the dog', 'Delete');
      await until(() => rows().length === 1, 'the record is gone');
      expect(rows()).toEqual([['Buy oat milk', 'No', 'high']]);
      expect(stored(appId, 'todos')).toEqual([{ title: 'Buy oat milk', completed: false, priority: 'high' }]);

      // None of the logic is drawn as words, as the filter once was.
      expect(container.textContent).not.toMatch(/const |function |filter\(|=>/);
    });
  });

  it.each([
    ['notes', () => generateNotesApp(), 'notes', 'title', 1, 'content'],
    ['contacts', () => generateContactsApp(), 'contacts', 'name', 1, 'email'],
  ] as const)('%s: a record is added, edited, searched for by a later field and deleted', async (_name, make, collection, first, laterAt, later) => {
    await onThread(thread, async () => {
      const appId = await open(make(), thread, crudIsReady);

      for (const [value, more] of [
        ['First', 'alpha'],
        ['Second', 'beta'],
      ]) {
        await press(button('Add New'));
        await until(() => groups().length > 0, 'the form opened');
        await type(fieldOf(0), value);
        await type(fieldOf(laterAt), more);
        await press(button('Create'));
        await until(() => Boolean(rowOf(value)), `${value} is listed`);
      }
      expect(stored(appId, collection).map((data) => [data[first], data[later]])).toEqual([
        ['First', 'alpha'],
        ['Second', 'beta'],
      ]);

      await press(button('Edit', rowOf('First')!));
      await until(() => Boolean(button('Update')), 'the form opened on the record');
      expect(fieldOf(laterAt)!.value).toBe('alpha');
      await type(fieldOf(laterAt), 'gamma');
      await press(button('Update'));
      await until(() => rows()[0]?.[laterAt] === 'gamma', 'the change is listed');

      await type(container.querySelector('input[placeholder="Search..."]'), 'bet');
      await until(() => rows().length === 1, 'the list is narrowed');
      expect(firstCells()).toEqual(['Second']);
      await type(container.querySelector('input[placeholder="Search..."]'), '');
      await until(() => rows().length === 2, 'the list is whole again');

      await deleteRow('Second', 'Delete');
      await until(() => rows().length === 1, 'the record is gone');
      expect(stored(appId, collection).map((data) => [data[first], data[later]])).toEqual([['First', 'gamma']]);
    });
  });

  it('every kind of field is kept as what it is, and a field that is required holds the save', async () => {
    await onThread(thread, async () => {
      const source = generateCrudApp({
        name: 'Orders',
        collection: 'orders',
        fields: [
          { name: 'title', type: 'text', label: 'Title', required: true },
          { name: 'amount', type: 'number', label: 'Amount' },
          { name: 'notes', type: 'textarea', label: 'Notes' },
          { name: 'paid', type: 'boolean', label: 'Paid' },
          { name: 'due', type: 'date', label: 'Due' },
          { name: 'status', type: 'select', label: 'Status', options: ['open', 'closed'], required: true },
        ],
      });
      const appId = await open(source, thread, crudIsReady);
      await press(button('Add New'));
      await until(() => groups().length === 6, 'the form opened');

      // Nothing typed: the record is not saved, and the form stays.
      await press(button('Create'));
      await act(async () => {
        await sleep(150);
      });
      expect(stored(appId, 'orders')).toEqual([]);
      expect(groups()).toHaveLength(6);

      // A title and no status: the select is not a field a browser checks, so the logic says so.
      await type(fieldOf(0), '  Chairs  ');
      await press(button('Create'));
      await until(() => Boolean(container.querySelector('.form-error')), 'what is missing is said');
      expect(container.querySelector('.form-error')!.textContent).toBe('Status is required.');
      expect(stored(appId, 'orders')).toEqual([]);

      await type(fieldOf(1), '40');
      await type(fieldOf(2), 'Oak, four');
      await press(fieldOf(3));
      await type(fieldOf(4), '2026-12-01');
      await choose(selectOf(5), 'open');
      await press(button('Create'));
      await until(() => rows().length === 1, 'the record is listed');
      expect(rows()).toEqual([['Chairs', '40', 'Oak, four', 'Yes', '2026-12-01', 'open']]);
      expect(stored(appId, 'orders')).toEqual([{ title: 'Chairs', amount: 40, notes: 'Oak, four', paid: true, due: '2026-12-01', status: 'open' }]);

      // Edited, each field starts as the record has it.
      await press(button('Edit', rowOf('Chairs')!));
      await until(() => Boolean(button('Update')), 'the form opened on the record');
      expect([fieldOf(0)!.value, fieldOf(1)!.value, fieldOf(2)!.value, (fieldOf(3) as HTMLInputElement).checked, fieldOf(4)!.value, selectOf(5)!.textContent]).toEqual([
        'Chairs',
        '40',
        'Oak, four',
        true,
        '2026-12-01',
        'open',
      ]);
      await type(fieldOf(1), '45.5');
      await choose(selectOf(5), 'closed');
      await press(button('Update'));
      await until(() => rows()[0]?.[1] === '45.5', 'the change is listed');
      expect(stored(appId, 'orders')).toEqual([{ title: 'Chairs', amount: 45.5, notes: 'Oak, four', paid: true, due: '2026-12-01', status: 'closed' }]);

      // Cancel leaves the record as it is and empties the form for the next one.
      await press(button('Edit', rowOf('Chairs')!));
      await until(() => Boolean(button('Update')), 'the form opened on the record again');
      await type(fieldOf(0), 'Tables');
      await press(button('Cancel', container.querySelector('.form-actions')!));
      await until(() => groups().length === 0, 'the form closed');
      expect(firstCells()).toEqual(['Chairs']);
      await press(button('Add New'));
      await until(() => groups().length === 6, 'the form opened for a new record');
      expect(fieldOf(0)!.value).toBe('');
      expect(button('Create')).toBeTruthy();
    });
  });

  it('search, the filters, the order and the pages each narrow or order the list', async () => {
    await onThread(thread, async () => {
      const source = generateCrudApp({
        name: 'Orders',
        collection: 'orders',
        fields: [
          { name: 'title', type: 'text', label: 'Title' },
          { name: 'amount', type: 'number', label: 'Amount' },
          { name: 'paid', type: 'boolean', label: 'Paid' },
          { name: 'status', type: 'select', label: 'Status', options: ['open', 'closed'] },
        ],
        features: { search: true, sort: 'amount', filter: true, pagination: true },
      });
      const two = (n: number) => String(n).padStart(2, '0');
      await open(
        source,
        thread,
        () => rows().length === 10,
        (appId) => {
          // Twelve orders, in no order: 1 to 6 open, the even ones paid.
          for (const n of [7, 3, 12, 1, 9, 5, 11, 2, 8, 4, 10, 6]) {
            getXDB(appId).create('orders', { title: `Order ${two(n)}`, amount: n, paid: n % 2 === 0, status: n <= 6 ? 'open' : 'closed' });
          }
        }
      );
      const amounts = () => rows().map((cells) => Number(cells[1]));
      const heading = (label: string) => [...container.querySelectorAll('th button')].find((element) => element.textContent?.startsWith(label));
      const sortOf = (label: string) => heading(label)!.closest('th')!.getAttribute('aria-sort');
      const pageSays = () => container.querySelector('.pages span')?.textContent?.replace(/\s+/g, ' ').trim();
      const filter = (label: string) => container.querySelector<HTMLElement>(`[role="combobox"][aria-label="Show by ${label}"]`);
      const clear = (label: string) => filter(label)!.querySelector('button[aria-label="Clear selection"]');

      // In order of the field named, a page of ten at a time.
      expect(amounts()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(pageSays()).toBe('Page 1 of 2');
      expect(sortOf('Amount')).toBe('ascending');
      expect(sortOf('Title')).toBe('none');
      expect((button('Previous') as HTMLButtonElement).disabled).toBe(true);
      await press(button('Next'));
      await until(() => rows().length === 2, 'the second page is shown');
      expect(amounts()).toEqual([11, 12]);
      expect(pageSays()).toBe('Page 2 of 2');
      expect((button('Next') as HTMLButtonElement).disabled).toBe(true);

      // A heading pressed again turns the order round; another heading orders by its field.
      await press(heading('Amount'));
      await until(() => amounts()[0] === 2, 'the order is turned round');
      expect(amounts()).toEqual([2, 1]);
      expect(sortOf('Amount')).toBe('descending');
      await press(button('Previous'));
      await until(() => rows().length === 10, 'the first page is shown');
      expect(amounts()).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
      await press(heading('Title'));
      await until(() => firstCells()[0] === 'Order 01', 'the list is in order of the title');
      expect(firstCells()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `Order ${two(n)}`));
      expect(sortOf('Title')).toBe('ascending');
      expect(sortOf('Amount')).toBe('none');

      // A filter shows the records with the value chosen; with one page of them, the pages go.
      await choose(filter('Status'), 'closed');
      await until(() => rows().length === 6, 'the closed orders are shown');
      expect(amounts()).toEqual([7, 8, 9, 10, 11, 12]);
      expect(container.querySelector('.pages')).toBeNull();
      await choose(filter('Paid'), 'Yes');
      await until(() => rows().length === 3, 'the closed, paid orders are shown');
      expect(amounts()).toEqual([8, 10, 12]);

      // The search narrows what the filters left.
      await type(container.querySelector('input[placeholder="Search..."]'), 'order 1');
      await until(() => rows().length === 2, 'the search narrowed the list');
      expect(amounts()).toEqual([10, 12]);
      await type(container.querySelector('input[placeholder="Search..."]'), '');
      await until(() => rows().length === 3, 'the search is emptied');

      // A filter emptied shows every value again.
      await press(clear('Status'));
      await until(() => rows().length === 6, 'every paid order is shown');
      expect(amounts()).toEqual([2, 4, 6, 8, 10, 12]);
      await choose(filter('Paid'), 'No');
      await until(() => amounts()[0] === 1, 'the unpaid orders are shown');
      expect(amounts()).toEqual([1, 3, 5, 7, 9, 11]);
      await press(clear('Paid'));
      await until(() => rows().length === 10, 'every order is shown, a page of them');
      expect(pageSays()).toBe('Page 1 of 2');
    });
  });
});

describe('generated apps whose names are not plain words', () => {
  const thread = THREADS[0][1];

  it('a CRUD app shows each name as it was given, and keeps its records under the fields’ own names', async () => {
    await onThread(thread, async () => {
      const source = generateCrudApp({
        name: 'R&D <Lab> {x} -- "notes"',
        collection: 'r-and-d',
        fields: [
          { name: 'first name', type: 'text', label: 'First "name" & <more>', placeholder: 'Say "hi" & <wave>' },
          { name: 'kind', type: 'select', label: 'Kind {of}', options: ['a "quoted" one', 'x < y', '}'], defaultValue: '</logic>' },
          { name: 'in-use', type: 'boolean', label: 'In use' },
        ],
        features: { search: true, sort: true, filter: true, pagination: true },
      });
      const appId = await open(source, thread, crudIsReady);
      expect(container.querySelector('h1')!.textContent).toBe('R&D <Lab> {x} -- "notes"');

      await press(button('Add New'));
      await until(() => groups().length === 3, 'the form opened');
      expect(groups()[0].querySelector('label')!.textContent).toBe('First "name" & <more>');
      expect(fieldOf(0)!.getAttribute('placeholder')).toBe('Say "hi" & <wave>');
      expect(groups()[1].querySelector('label')!.textContent).toBe('Kind {of}');
      // A default that is no option is shown as it is.
      expect(selectOf(1)!.textContent).toBe('</logic>');
      await type(fieldOf(0), 'Ada');
      await choose(selectOf(1), 'x < y');
      await press(fieldOf(2));
      await press(button('Create'));
      await until(() => rows().length === 1, 'the record is listed');
      expect(rows()).toEqual([['Ada', 'x < y', 'Yes']]);
      expect(stored(appId, 'r-and-d')).toEqual([{ 'first name': 'Ada', kind: 'x < y', 'in-use': true }]);
      expect([...container.querySelectorAll('th')].map((heading) => heading.textContent?.replace(/ [▲▼]$/, ''))).toEqual([
        'First "name" & <more>',
        'Kind {of}',
        'In use',
        'Actions',
      ]);

      // The filters and the search read the fields by the same names.
      await choose(container.querySelector('[role="combobox"][aria-label="Show by Kind {of}"]'), '}');
      await until(() => rows().length === 0, 'no record is of that kind');
      await choose(container.querySelector('[role="combobox"][aria-label="Show by Kind {of}"]'), 'x < y');
      await until(() => rows().length === 1, 'the record is of this kind');
      await type(container.querySelector('input[placeholder="Search..."]'), 'ad');
      await until(() => rows().length === 1, 'the search finds it');
      await type(container.querySelector('input[placeholder="Search..."]'), 'zz');
      await until(() => rows().length === 0, 'the search does not find it');
    });
  });

  it('a simple list and a kanban board do too', async () => {
    await onThread(thread, async () => {
      const count = () => container.querySelector('.count')?.textContent?.replace(/\s+/g, ' ').trim();
      const listId = await open(
        generateSimpleList({ name: 'To buy & <to> {do} --', collection: 'to-buy', itemField: 'what to buy' }),
        thread,
        () => count() === '0 items'
      );
      expect(container.querySelector('h2')!.textContent).toBe('To buy & <to> {do} --');
      await type(container.querySelector('input[placeholder="Add new item..."]'), 'Milk & <eggs>');
      await press(button('Add'));
      await until(() => count() === '1 item', 'the item is listed');
      expect(container.querySelector('li.item')!.textContent).toContain('Milk & <eggs>');
      expect(stored(listId, 'to-buy')).toEqual([{ 'what to buy': 'Milk & <eggs>', completed: false }]);
      await close();

      const columns = () => [...container.querySelectorAll<HTMLElement>('.kanban-column')];
      const boardId = await open(
        generateKanbanBoard({ name: 'Q&A <board> {1} --', collection: 'q-and-a', columns: ['To "do"', 'x < y', '</logic>'] }),
        thread,
        () => columns().length === 3
      );
      expect(container.querySelector('h1')!.textContent).toBe('Q&A <board> {1} --');
      expect(columns().map((column) => column.querySelector('.column-title')!.textContent!.replace(/\s*\(\d+\)\s*$/, '').trim())).toEqual(['To "do"', 'x < y', '</logic>']);
      await type(container.querySelector('input[placeholder="New task..."]'), 'Ask');
      await choose(container.querySelector('[role="combobox"][aria-label="Column"]'), '</logic>');
      await press(button('Add'));
      await until(() => columns()[2].querySelectorAll('.task-card').length === 1, 'the task is in the column chosen');
      expect(stored(boardId, 'q-and-a').map((data) => [data.title, data.status])).toEqual([['Ask', '</logic>']]);
    });
  });
});

describe.each(THREADS)('a generated simple list, with its logic %s', (_where, thread) => {
  it('adds what is typed, ticks an item off and back, and removes one', async () => {
    await onThread(thread, async () => {
      const source = generateSimpleList({ name: 'Shopping List', collection: 'shopping', itemField: 'item' });
      const count = () => container.querySelector('.count')?.textContent?.replace(/\s+/g, ' ').trim();
      // The count is the logic's: it reads "0 items" once the logic has loaded and read the records.
      const appId = await open(source, thread, () => count() === '0 items' && Boolean(button('Add')));
      const field = () => container.querySelector<HTMLInputElement>('input[placeholder="Add new item..."]');
      const items = () => [...container.querySelectorAll<HTMLElement>('li.item')];
      const itemOf = (words: string) => items().find((item) => item.textContent?.includes(words));
      const tick = (words: string) => itemOf(words)!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(container.textContent).toContain('No items yet');

      await type(field(), 'Milk');
      await press(button('Add'));
      await until(() => items().length === 1, 'the item is listed');
      expect(itemOf('Milk')).toBeTruthy();
      expect(field()!.value, 'the field is emptied for the next').toBe('');
      expect(count()).toBe('1 item');
      expect(container.textContent).not.toContain('No items yet');

      // Spaces alone are not an item.
      await type(field(), '   ');
      await press(button('Add'));
      await act(async () => {
        await sleep(150);
      });
      expect(items()).toHaveLength(1);

      await type(field(), 'Eggs');
      await press(button('Add'));
      await until(() => items().length === 2, 'the second item is listed');
      expect(count()).toBe('2 items');
      expect(stored(appId, 'shopping')).toEqual([
        { item: 'Milk', completed: false },
        { item: 'Eggs', completed: false },
      ]);

      await press(tick('Milk'));
      await until(() => tick('Milk').checked, 'the item is ticked off');
      expect(itemOf('Milk')!.classList.contains('done')).toBe(true);
      expect(tick('Eggs').checked).toBe(false);
      expect(stored(appId, 'shopping')[0]).toEqual({ item: 'Milk', completed: true });
      await press(tick('Milk'));
      await until(() => !tick('Milk').checked, 'the item is brought back');
      expect(itemOf('Milk')!.classList.contains('done')).toBe(false);

      await press(button('Remove', itemOf('Milk')!));
      await until(() => items().length === 1, 'the item is removed');
      expect(count()).toBe('1 item');
      expect(stored(appId, 'shopping')).toEqual([{ item: 'Eggs', completed: false }]);
    });
  });
});

describe.each(THREADS)('a generated kanban board, with its logic %s', (_where, thread) => {
  it('adds a task to the column chosen, moves it by its buttons and by dragging, and deletes it', async () => {
    await onThread(thread, async () => {
      const source = generateKanbanBoard({ name: 'Board', collection: 'tasks', columns: ['Todo', 'Doing', 'Done'] });
      const columns = () => [...container.querySelectorAll<HTMLElement>('.kanban-column')];
      const appId = await open(source, thread, () => columns().length === 3 && Boolean(button('Add')));
      const column = (name: string) => columns().find((element) => element.querySelector('.column-title')?.textContent?.trim().startsWith(name))!;
      const cards = (name: string) => [...column(name).querySelectorAll('.task-title')].map((title) => title.textContent);
      const card = (title: string) => [...container.querySelectorAll<HTMLElement>('.task-card')].find((element) => element.querySelector('.task-title')?.textContent === title)!;
      const counts = () => columns().map((element) => element.querySelector('.count')!.textContent);
      const field = () => container.querySelector<HTMLInputElement>('input[placeholder="New task..."]');
      const statuses = () => Object.fromEntries(stored(appId, 'tasks').map((data) => [data.title, data.status]));
      const fire = (element: Element, type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        act(() => {
          element.dispatchEvent(event);
        });
        return event;
      };
      expect(columns().map((element) => element.querySelector('.empty-column')?.textContent)).toEqual(['Drop tasks here', 'Drop tasks here', 'Drop tasks here']);

      // A task goes to the first column unless another is chosen.
      await type(field(), 'Write tests');
      await press(button('Add'));
      await until(() => cards('Todo').length === 1, 'the task is in the first column');
      expect(field()!.value).toBe('');
      await type(field(), 'Ship');
      await choose(container.querySelector('[role="combobox"][aria-label="Column"]'), 'Done');
      await press(button('Add'));
      await until(() => cards('Done').length === 1, 'the task is in the column chosen');
      expect([cards('Todo'), cards('Doing'), cards('Done')]).toEqual([['Write tests'], [], ['Ship']]);
      expect(counts()).toEqual(['(1)', '(0)', '(1)']);
      expect(statuses()).toEqual({ 'Write tests': 'Todo', Ship: 'Done' });

      // By its buttons: on a column, and no further back than the first or on than the last.
      expect((button('Move back', card('Write tests')) as HTMLButtonElement).disabled).toBe(true);
      expect((button('Move on', card('Ship')) as HTMLButtonElement).disabled).toBe(true);
      await press(button('Move on', card('Write tests')));
      await until(() => cards('Doing').length === 1, 'the task moved on a column');
      expect(statuses()).toEqual({ 'Write tests': 'Doing', Ship: 'Done' });
      await press(button('Move back', card('Ship')));
      await until(() => cards('Doing').length === 2, 'the other task moved back a column');
      expect(cards('Doing')).toEqual(['Write tests', 'Ship']);

      // By dragging: a column lets a task be dropped on it, and takes the one dragged.
      expect(card('Write tests').getAttribute('draggable')).toBe('true');
      fire(card('Write tests'), 'dragstart');
      expect(fire(column('Done'), 'dragover').defaultPrevented, 'the column allows a drop').toBe(true);
      fire(column('Done'), 'drop');
      await until(() => cards('Done').length === 1, 'the task dragged is in the column it was dropped on');
      expect([cards('Todo'), cards('Doing'), cards('Done')]).toEqual([[], ['Ship'], ['Write tests']]);
      expect(statuses()).toEqual({ 'Write tests': 'Done', Ship: 'Doing' });
      // A drop with nothing dragged moves nothing.
      fire(column('Todo'), 'drop');
      await act(async () => {
        await sleep(150);
      });
      expect(cards('Todo')).toEqual([]);

      await press(button('Delete', card('Ship')));
      await until(() => cards('Doing').length === 0, 'the task is deleted');
      expect(statuses()).toEqual({ 'Write tests': 'Done' });
      expect(counts()).toEqual(['(0)', '(0)', '(1)']);
    });
  });
});
