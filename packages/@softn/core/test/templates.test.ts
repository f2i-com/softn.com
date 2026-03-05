/**
 * SoftN Templates Tests
 *
 * Tests for app template generators.
 */

import { describe, it, expect } from 'vitest';
import {
  generateCrudApp,
  generateTodoApp,
  generateNotesApp,
  generateContactsApp,
  generateSimpleList,
  generateKanbanBoard,
  templates,
} from '../src/templates';

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
      const source = generateCrudApp({
        name: 'Test',
        collection: 'items',
        fields: [{ name: 'name', type: 'text' }],
      });

      expect(source).toContain('async function save()');
      expect(source).toContain('function edit(item)');
      expect(source).toContain('async function remove(id)');
      expect(source).toContain('function cancel()');
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

      expect(source).toContain('my_tasks');
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
  });

  it('should generate textarea field', () => {
    const source = generateCrudApp({
      name: 'Test',
      collection: 'items',
      fields: [{ name: 'description', type: 'textarea' }],
    });

    expect(source).toContain('Textarea');
  });

  it('should generate checkbox field', () => {
    const source = generateCrudApp({
      name: 'Test',
      collection: 'items',
      fields: [{ name: 'active', type: 'boolean', label: 'Is Active' }],
    });

    expect(source).toContain('Checkbox');
    expect(source).toContain(':checked={active}');
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

    expect(source).toContain('Select');
    expect(source).toContain('value="open"');
    expect(source).toContain('value="closed"');
    expect(source).toContain('value="pending"');
  });

  it('should mark required fields', () => {
    const source = generateCrudApp({
      name: 'Test',
      collection: 'items',
      fields: [{ name: 'name', type: 'text', required: true }],
    });

    expect(source).toContain('required');
  });
});
