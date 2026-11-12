/**
 * SoftN Templates Tests
 *
 * What the app template generators write: every page they can write is read
 * without a word, and is written as the language is written today.
 * templates-apps.test.tsx runs the apps, on the real engine, and uses them.
 */

import React from 'react';
import { afterEach, describe, it, expect } from 'vitest';
import {
  generateCrudApp,
  generateTodoApp,
  generateNotesApp,
  generateContactsApp,
  generateSimpleList,
  generateKanbanBoard,
  templates,
  type TemplateConfig,
} from '../src/templates';
import { parse } from '../src/parser';
import type { ComponentRegistry } from '../src/renderer';
import { drawPage, removeDrawnPages, typeInto } from './helpers/drawn-page';

afterEach(removeDrawnPages);

/** An app with a field of every kind. */
const EVERY_FIELD: TemplateConfig = {
  name: 'Test',
  collection: 'items',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'amount', type: 'number' },
    { name: 'notes', type: 'textarea' },
    { name: 'done', type: 'boolean' },
    { name: 'due', type: 'date' },
    { name: 'status', type: 'select', options: ['open', 'closed'] },
  ],
};

/** Names with what markup, an expression, a comment and a string would each read as their own. */
const AWKWARD: TemplateConfig = {
  name: 'R&D <Lab> {x} -- "notes"',
  collection: 'r-and-d',
  fields: [
    { name: 'first name', type: 'text', label: 'First "name" & <more>', placeholder: 'Say "hi" & <wave>' },
    { name: 'kind', type: 'select', label: 'Kind {of}', options: ['a "quoted" one', 'x < y', '}'], defaultValue: '</logic>' },
    { name: 'in-use', type: 'boolean', label: 'In use' },
  ],
  features: { search: true, sort: true, filter: true, pagination: true },
};

/** Every page the generators write, in each shape their options give it. */
const EVERY_TEMPLATE: Array<[string, () => string]> = [
  ['crud', () => generateCrudApp({ name: 'Test', collection: 'items', fields: [{ name: 'name', type: 'text' }] })],
  ['crud with every kind of field', () => generateCrudApp(EVERY_FIELD)],
  ['crud with every kind of field and search', () => generateCrudApp({ ...EVERY_FIELD, features: { search: true } })],
  ['crud with every feature', () => generateCrudApp({ ...EVERY_FIELD, features: { search: true, sort: 'amount', filter: true, pagination: true, export: true } })],
  ['crud with sort alone', () => generateCrudApp({ ...EVERY_FIELD, features: { sort: true } })],
  ['crud with filter alone', () => generateCrudApp({ ...EVERY_FIELD, features: { filter: true } })],
  ['crud with pagination alone', () => generateCrudApp({ ...EVERY_FIELD, features: { pagination: true } })],
  ['crud with no fields', () => generateCrudApp({ name: 'Empty', collection: 'nothing', fields: [], features: { search: true, sort: true, filter: true, pagination: true } })],
  ['crud with awkward names', () => generateCrudApp(AWKWARD)],
  ['todo', () => generateTodoApp()],
  ['notes', () => generateNotesApp()],
  ['contacts', () => generateContactsApp()],
  ['simpleList', () => generateSimpleList({ name: 'Shopping List', collection: 'shopping', itemField: 'item' })],
  ['simpleList with awkward names', () => generateSimpleList({ name: 'To buy & <to> {do} --', collection: 'to-buy', itemField: 'what to buy' })],
  ['simpleList whose field is called completed', () => generateSimpleList({ name: 'Done', collection: 'done', itemField: 'completed' })],
  ['kanban', () => generateKanbanBoard({ name: 'Board', collection: 'tasks', columns: ['Todo', 'Done'] })],
  ['kanban with awkward names', () => generateKanbanBoard({ name: 'Q&A <board> {1} --', collection: 'q-and-a', columns: ['To "do"', 'x < y', '</logic>'] })],
  ['kanban with no columns', () => generateKanbanBoard({ name: 'Board', collection: 'tasks', columns: [] })],
];

/** A page's markup: what is left without its logic and its rules. */
const markupOf = (source: string) => source.replace(/<logic>[\s\S]*?<\/logic>/, '').replace(/<style>[\s\S]*?<\/style>/, '');
const logicOf = (source: string) => /<logic>([\s\S]*?)<\/logic>/.exec(source)?.[1] ?? '';

describe('Template Generators', () => {
  describe('generateCrudApp', () => {
    it('should generate a SoftN document with required sections', () => {
      const source = generateCrudApp({
        name: 'Tasks',
        collection: 'tasks',
        fields: [{ name: 'title', type: 'text', label: 'Title', required: true }],
      });

      // Check the source contains required sections
      expect(source).toContain('<data>');
      expect(source).toContain('</data>');
      expect(source).toContain('<logic>');
      expect(source).toContain('</logic>');
      expect(source).toContain('<style>');
      expect(source).toContain('</style>');
    });

    it('should include data block with collection', () => {
      const source = generateCrudApp({
        name: 'Test',
        collection: 'items',
        fields: [{ name: 'name', type: 'text' }],
      });

      expect(source).toContain('<data>');
      expect(source).toContain('collection name="items"');
    });

    it('should include CRUD functions in logic block', () => {
      const logic = logicOf(
        generateCrudApp({
          name: 'Test',
          collection: 'items',
          fields: [{ name: 'name', type: 'text' }],
        })
      );

      expect(logic).toContain('function save()');
      expect(logic).toContain('function edit(id)');
      expect(logic).toContain('function remove(id)');
      expect(logic).toContain('function confirmRemove()');
      expect(logic).toContain('function cancel()');
      // The records are db's: read at the start and after each change.
      expect(logic).toContain('function _init()');
      expect(logic).toContain('records = db.query("items")');
      expect(logic).toContain('db.create("items", data)');
      expect(logic).toContain('db.update(editingId, data)');
      expect(logic).toContain('db.delete(removingId)');
    });

    it('should include search feature when enabled', () => {
      const source = generateCrudApp({
        name: 'Test',
        collection: 'items',
        fields: [{ name: 'name', type: 'text' }],
        features: { search: true },
      });

      expect(source).toContain('searchQuery');
      expect(source).toContain('Search...');
      expect(generateCrudApp({ name: 'Test', collection: 'items', fields: [{ name: 'name', type: 'text' }] })).not.toContain('searchQuery');
    });

    /**
     * The search field was `:value={searchQuery}` with
     * `@input={(e) => state.searchQuery = e.target.value}`. A handler in
     * braces on `@input` is handed the text typed, not the event, so
     * `e.target.value` was nothing: every keystroke wrote nothing, to a place
     * that is not the variable, and the field kept none of what was typed.
     * It is `:bind` now, with a handler beside it that has the logic work the
     * list out again, once the logic has been told what was typed.
     */
    it('keeps what is typed into the search field in searchQuery, and has the list worked out again', () => {
      const source = generateCrudApp({
        name: 'Test',
        collection: 'items',
        fields: [{ name: 'name', type: 'text' }],
        features: { search: true },
      });
      expect(source).toContain(':bind={searchQuery}');
      expect(source).not.toContain('target.value');

      // Each component the list names, as the plain element it stands for; the question a Delete asks is not drawn.
      const plain = (tag: string) =>
        function Plain(props: Record<string, unknown>) {
          return React.createElement(tag, props);
        };
      const register = (registry: ComponentRegistry): void => {
        registry.register('Input', plain('input') as never);
        registry.register('Button', plain('button') as never);
        registry.register('Card', plain('div') as never);
        registry.register('Confirm', (() => null) as never);
      };
      const relisted: unknown[][] = [];
      const page = drawPage(
        source,
        {
          form: { name: '' },
          editingId: null,
          showForm: false,
          formError: '',
          removingId: null,
          confirmingRemove: false,
          records: [],
          filteredItems: [],
          searchQuery: '',
        },
        {
          register,
          functions: {
            relist: (...args: unknown[]) => {
              relisted.push(args);
            },
          },
        }
      );
      const field = page.one<HTMLInputElement>('input[placeholder="Search..."]');
      typeInto(field, 'milk');
      expect(page.writes).toEqual([['searchQuery', 'milk']]);
      expect(page.state().searchQuery).toBe('milk');
      expect(field.value).toBe('milk');
      expect(page.shared).toContainEqual({ searchQuery: 'milk' });
      expect(relisted).toEqual([[]]);
    });

    describe('features', () => {
      const withFeatures = (features: TemplateConfig['features']) => generateCrudApp({ ...EVERY_FIELD, features });
      const plainApp = generateCrudApp(EVERY_FIELD);

      it('sort: the list is in order of the field named, or of the first field', () => {
        expect(logicOf(withFeatures({ sort: 'amount' }))).toContain('let sortBy = "amount"');
        expect(logicOf(withFeatures({ sort: true }))).toContain('let sortBy = "title"');
        // A name that is no field's is the first field's.
        expect(logicOf(withFeatures({ sort: 'nothing' }))).toContain('let sortBy = "title"');
        expect(markupOf(withFeatures({ sort: true }))).toContain('@click={() => sortOn("amount")}');
        expect(plainApp).not.toContain('sortBy');
        expect(withFeatures({ sort: false })).toBe(plainApp);
      });

      it('filter: a choice for each select and yes/no field', () => {
        const source = withFeatures({ filter: true });
        expect(logicOf(source)).toContain('let filters = { done: "", status: "" }');
        expect(markupOf(source)).toContain(':bind={filters.status}');
        expect(markupOf(source)).toContain(':bind={filters.done}');
        expect(plainApp).not.toContain('filters');
        // With no such field there is nothing to choose by.
        const none = generateCrudApp({ name: 'Test', collection: 'items', fields: [{ name: 'name', type: 'text' }], features: { filter: true } });
        expect(none).toBe(generateCrudApp({ name: 'Test', collection: 'items', fields: [{ name: 'name', type: 'text' }] }));
      });

      it('pagination: a page of ten at a time', () => {
        const source = withFeatures({ pagination: true });
        expect(logicOf(source)).toContain('function showPage(number)');
        expect(logicOf(source)).toContain('list.slice((page - 1) * 10, page * 10)');
        expect(markupOf(source)).toContain('Page {page} of {pageCount}');
        expect(plainApp).not.toContain('pageCount');
      });

      it('export: nothing is generated, as its option says', () => {
        expect(withFeatures({ export: true })).toBe(plainApp);
      });
    });
  });

  describe('every template', () => {
    it.each(EVERY_TEMPLATE)('is read without a warning: %s', (_name, make) => {
      const said = (parse(make()).diagnostics ?? []).map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`);
      expect(said).toEqual([]);
    });

    /**
     * What the templates once wrote, none of which is the language: a field
     * that only shows its value, a variable reached through `state.`, the
     * records through `xdb.`, a question asked with `confirm()`, which logic
     * cannot wait on, and the list's filter as code in the markup, where it
     * was drawn as words.
     */
    it.each(EVERY_TEMPLATE)('is written as the language is today: %s', (_name, make) => {
      const source = make();
      expect(source).not.toMatch(/:value=|:checked=/);
      expect(source).not.toMatch(/\bstate\./);
      expect(source).not.toMatch(/\bxdb\./);
      expect(source).not.toMatch(/\bconfirm\(/);
      expect(source).not.toMatch(/@submit=\{\(e\)/);
      expect(source).not.toContain('target.value');
      // The logic is in the logic block, and only there.
      expect(markupOf(source)).not.toMatch(/\b(const|let|function)\s/);
      expect(logicOf(source)).toMatch(/function _init\(\)/);
      // A form sends itself to the logic and never away.
      for (const form of markupOf(source).match(/<form[^>]*>/g) ?? []) expect(form).toContain('@submit.prevent=');
      // A list is drawn with #each, each row told from the others by its id.
      expect(markupOf(source)).toMatch(/#each \(.+\) key=\{/);
    });

    it('keeps a name as it was given, where markup, an expression, a comment or a string would read it as their own', () => {
      const doc = parse(generateCrudApp(AWKWARD));
      expect(doc.diagnostics ?? []).toEqual([]);
      const source = generateCrudApp(AWKWARD);
      expect(logicOf(source)).toContain('"first name": ""');
      expect(logicOf(source)).toContain('kind: "<\\/logic>"');
      expect(markupOf(source)).toContain(':bind={form["first name"]}');
      expect(markupOf(source)).toContain(':bind={form["in-use"]}');
      expect(markupOf(source)).toContain('{item.data["first name"]}');
      expect(markupOf(source)).toContain('placeholder="Say &quot;hi&quot; &amp; &lt;wave>"');
      // One logic block, ended where the template ends it.
      expect(source.match(/<\/logic>/g)).toHaveLength(1);
    });
  });

  describe('generateTodoApp', () => {
    it('should generate a todo app template', () => {
      const source = generateTodoApp();

      expect(source).toContain('Todo App');
      expect(source).toContain('todos');
      expect(source).toContain('<data>');
      expect(source).toContain('<logic>');
    });

    it('should accept custom collection name', () => {
      const source = generateTodoApp('my_tasks');

      expect(source).toContain('collection name="my_tasks"');
      expect(source).toContain('db.query("my_tasks")');
    });
  });

  describe('generateNotesApp', () => {
    it('should generate a notes app template', () => {
      const source = generateNotesApp();

      expect(source).toContain('Notes');
      expect(source).toContain('<data>');
      expect(source).toContain('<logic>');
    });
  });

  describe('generateContactsApp', () => {
    it('should generate a contacts app template', () => {
      const source = generateContactsApp();

      expect(source).toContain('Contacts');
      expect(source).toContain('name');
      expect(source).toContain('email');
      expect(source).toContain('phone');
    });
  });

  describe('generateSimpleList', () => {
    it('should generate a simple list template', () => {
      const source = generateSimpleList({
        name: 'Shopping List',
        collection: 'shopping',
        itemField: 'item',
      });

      expect(source).toContain('Shopping List');
      expect(source).toContain('shopping');
      expect(source).toContain('<data>');
      expect(markupOf(source)).toContain(':bind={newItem}');
      expect(logicOf(source)).toContain('db.create("shopping", { item: words, completed: false })');
    });

    it('keeps the tick apart from the words where the words are called completed', () => {
      const source = generateSimpleList({ name: 'Done', collection: 'done', itemField: 'completed' });
      expect(logicOf(source)).toContain('db.create("done", { completed: words, done: false })');
    });
  });

  describe('generateKanbanBoard', () => {
    it('should generate a kanban board template', () => {
      const source = generateKanbanBoard({
        name: 'Project Board',
        collection: 'tasks',
        columns: ['Todo', 'In Progress', 'Done'],
      });

      expect(source).toContain('Project Board');
      expect(source).toContain('Todo');
      expect(source).toContain('In Progress');
      expect(source).toContain('Done');
      expect(source).toContain('<data>');
      expect(logicOf(source)).toContain('let columns = ["Todo","In Progress","Done"]');
      expect(logicOf(source)).toContain('let newColumn = "Todo"');
    });

    it('should include drag and drop handlers', () => {
      const source = generateKanbanBoard({
        name: 'Board',
        collection: 'items',
        columns: ['A', 'B'],
      });

      expect(source).toContain('onDragStart');
      expect(source).toContain('onDrop');
      expect(source).toContain('draggedId');
      // And buttons that move a task, for where nothing can be dragged.
      expect(markupOf(source)).toContain('@click={() => shiftTask(task.id, 1)}');
    });
  });

  describe('templates object', () => {
    it('should export all template generators', () => {
      expect(templates.crud).toBe(generateCrudApp);
      expect(templates.todo).toBe(generateTodoApp);
      expect(templates.notes).toBe(generateNotesApp);
      expect(templates.contacts).toBe(generateContactsApp);
      expect(templates.simpleList).toBe(generateSimpleList);
      expect(templates.kanban).toBe(generateKanbanBoard);
    });
  });
});

describe('Form Field Generation', () => {
  it('should generate text input field', () => {
    const source = generateCrudApp({
      name: 'Test',
      collection: 'items',
      fields: [{ name: 'title', type: 'text', placeholder: 'Enter title' }],
    });

    expect(source).toContain('type="text"');
    expect(source).toContain('placeholder="Enter title"');
    expect(source).toContain(':bind={form.title}');
  });

  it('should generate textarea field', () => {
    const source = generateCrudApp({
      name: 'Test',
      collection: 'items',
      fields: [{ name: 'description', type: 'textarea' }],
    });

    // The component is TextArea: a tag with a capital is a component's, and none is called Textarea.
    expect(source).toContain('<TextArea');
    expect(source).toContain(':bind={form.description}');
  });

  it('should generate checkbox field', () => {
    const source = generateCrudApp({
      name: 'Test',
      collection: 'items',
      fields: [{ name: 'active', type: 'boolean', label: 'Is Active' }],
    });

    expect(source).toContain('Checkbox');
    expect(source).toContain(':bind={form.active}');
    expect(source).toContain('label="Is Active"');
    // A yes or no is shown in words: drawn as it is, true and false show nothing.
    expect(source).toContain('{item.data.active ? "Yes" : "No"}');
  });

  it('should generate number and date fields', () => {
    const source = generateCrudApp({
      name: 'Test',
      collection: 'items',
      fields: [
        { name: 'amount', type: 'number' },
        { name: 'due', type: 'date' },
      ],
    });

    expect(source).toContain('type="number"');
    expect(source).toContain(':bind={form.amount}');
    expect(source).toContain('type="date"');
    expect(source).toContain(':bind={form.due}');
    expect(logicOf(source)).toContain('let form = { amount: 0, due: "" }');
  });

  it('should generate select field with options', () => {
    const source = generateCrudApp({
      name: 'Test',
      collection: 'items',
      fields: [
        {
          name: 'status',
          type: 'select',
          options: ['open', 'closed', 'pending'],
        },
      ],
    });

    // Select takes its options as a list: it draws no <option> written inside it.
    expect(source).toContain('<Select');
    expect(source).toContain('options={["open","closed","pending"]}');
    expect(source).toContain(':bind={form.status}');
    expect(source).not.toContain('<option');
  });

  it('should mark required fields', () => {
    const source = generateCrudApp({
      name: 'Test',
      collection: 'items',
      fields: [{ name: 'name', type: 'text', required: true }],
    });

    expect(source).toContain(':bind={form.name} required');
    // And the logic holds a save that lacks one, for a field a browser does not check.
    expect(logicOf(source)).toContain('if (data.name === "") { formError = "name is required."; return }');
  });

  it('should start a field as its default says', () => {
    const logic = logicOf(generateTodoApp());
    expect(logic).toContain('let form = { title: "", completed: false, priority: "medium" }');
  });
});
