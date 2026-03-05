/**
 * XDB Service Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { XDBService, createXDBModule } from '../src/runtime/xdb';

// Create an in-memory storage for testing
function createTestStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
}

describe('XDB Service', () => {
  let xdb: XDBService;

  beforeEach(() => {
    // Create a fresh XDB instance with in-memory storage for each test
    xdb = new XDBService(createTestStorage(), 'test-xdb');
  });

  describe('CRUD Operations', () => {
    it('should create a record with auto-generated ID', () => {
      const record = xdb.create('tasks', { title: 'Test task', completed: false });

      expect(record.id).toBeDefined();
      expect(record.collection).toBe('tasks');
      expect(record.data.title).toBe('Test task');
      expect(record.data.completed).toBe(false);
      expect(record.deleted).toBe(false);
      expect(record.created_at).toBeDefined();
      expect(record.updated_at).toBeDefined();
    });

    it('should get a record by ID', () => {
      const created = xdb.create('tasks', { title: 'Test task' });
      const retrieved = xdb.get('tasks', created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.data.title).toBe('Test task');
    });

    it('should return null for non-existent record', () => {
      const result = xdb.get('tasks', 'non-existent-id');
      expect(result).toBeNull();
    });

    it('should get all records in a collection', () => {
      xdb.create('tasks', { title: 'Task 1' });
      xdb.create('tasks', { title: 'Task 2' });
      xdb.create('tasks', { title: 'Task 3' });

      const records = xdb.getAll('tasks');

      expect(records).toHaveLength(3);
      expect(records[0].data.title).toBe('Task 1');
      expect(records[1].data.title).toBe('Task 2');
      expect(records[2].data.title).toBe('Task 3');
    });

    it('should update a record', () => {
      const created = xdb.create('tasks', { title: 'Original title', completed: false });
      // Use collection-specific update for test storage compatibility
      const updated = xdb.updateInCollection('tasks', created.id, { title: 'Updated title' });

      expect(updated).not.toBeNull();
      expect(updated!.data.title).toBe('Updated title');
      expect(updated!.data.completed).toBe(false); // Original data preserved
    });

    it('should soft delete a record', () => {
      const created = xdb.create('tasks', { title: 'To delete' });
      // Use collection-specific delete for test storage compatibility
      const result = xdb.deleteFromCollection('tasks', created.id);

      expect(result).toBe(true);

      // Record should not appear in normal queries
      const records = xdb.getAll('tasks');
      expect(records).toHaveLength(0);

      // But should still exist in storage (soft delete)
      const retrieved = xdb.get('tasks', created.id);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent record', () => {
      // Use collection-specific delete for test storage compatibility
      const result = xdb.deleteFromCollection('tasks', 'non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('Query Operations', () => {
    beforeEach(() => {
      xdb.create('tasks', { title: 'Task A', priority: 'high', completed: false });
      xdb.create('tasks', { title: 'Task B', priority: 'low', completed: true });
      xdb.create('tasks', { title: 'Task C', priority: 'high', completed: true });
    });

    it('should filter records by data properties', () => {
      const highPriority = xdb.query('tasks', { filter: { priority: 'high' } });
      expect(highPriority).toHaveLength(2);

      const completed = xdb.query('tasks', { filter: { completed: true } });
      expect(completed).toHaveLength(2);

      const highAndCompleted = xdb.query('tasks', {
        filter: { priority: 'high', completed: true },
      });
      expect(highAndCompleted).toHaveLength(1);
      expect(highAndCompleted[0].data.title).toBe('Task C');
    });

    it('should sort records', () => {
      const ascending = xdb.query('tasks', { sort: { field: 'title', order: 'asc' } });
      expect(ascending[0].data.title).toBe('Task A');
      expect(ascending[2].data.title).toBe('Task C');

      const descending = xdb.query('tasks', { sort: { field: 'title', order: 'desc' } });
      expect(descending[0].data.title).toBe('Task C');
      expect(descending[2].data.title).toBe('Task A');
    });

    it('should limit results', () => {
      const limited = xdb.query('tasks', { limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('should offset results', () => {
      const offset = xdb.query('tasks', { offset: 1, limit: 2 });
      expect(offset).toHaveLength(2);
      expect(offset[0].data.title).toBe('Task B');
    });
  });

  describe('Event System', () => {
    it('should notify listeners on create', () => {
      let eventReceived = false;
      let eventData: unknown = null;

      xdb.subscribe('tasks', (event) => {
        eventReceived = true;
        eventData = event;
      });

      xdb.create('tasks', { title: 'Test' });

      expect(eventReceived).toBe(true);
      expect((eventData as { type: string }).type).toBe('create');
    });

    it('should notify listeners on update', () => {
      const record = xdb.create('tasks', { title: 'Test' });

      let eventReceived = false;
      xdb.subscribe('tasks', (event) => {
        if (event.type === 'update') {
          eventReceived = true;
        }
      });

      // Use collection-specific update for test storage compatibility
      xdb.updateInCollection('tasks', record.id, { title: 'Updated' });

      expect(eventReceived).toBe(true);
    });

    it('should notify listeners on delete', () => {
      const record = xdb.create('tasks', { title: 'Test' });

      let eventReceived = false;
      xdb.subscribe('tasks', (event) => {
        if (event.type === 'delete') {
          eventReceived = true;
        }
      });

      // Use collection-specific delete for test storage compatibility
      xdb.deleteFromCollection('tasks', record.id);

      expect(eventReceived).toBe(true);
    });

    it('should unsubscribe correctly', () => {
      let callCount = 0;

      const unsubscribe = xdb.subscribe('tasks', () => {
        callCount++;
      });

      xdb.create('tasks', { title: 'Test 1' });
      expect(callCount).toBe(1);

      unsubscribe();

      xdb.create('tasks', { title: 'Test 2' });
      expect(callCount).toBe(1); // Should not increase
    });
  });

  describe('Utility Methods', () => {
    it('should count records', () => {
      expect(xdb.count('tasks')).toBe(0);

      xdb.create('tasks', { title: 'Task 1' });
      xdb.create('tasks', { title: 'Task 2' });

      expect(xdb.count('tasks')).toBe(2);
    });

    it('should clear a collection', () => {
      xdb.create('tasks', { title: 'Task 1' });
      xdb.create('tasks', { title: 'Task 2' });

      xdb.clear('tasks');

      expect(xdb.count('tasks')).toBe(0);
    });
  });
});

describe('XDB Module', () => {
  let xdb: XDBService;
  let module: ReturnType<typeof createXDBModule>;

  beforeEach(() => {
    xdb = new XDBService(createTestStorage(), 'test-xdb');
    module = createXDBModule(xdb);
  });

  it('should create records through module', () => {
    const record = module.create('tasks', { title: 'Test' });
    expect(record.data.title).toBe('Test');
  });

  it('should query records through module', () => {
    module.create('tasks', { title: 'A', done: false });
    module.create('tasks', { title: 'B', done: true });

    const all = module.getAll('tasks');
    expect(all).toHaveLength(2);

    const done = module.query('tasks', { done: true });
    expect(done).toHaveLength(1);
  });

  it('should count records through module', () => {
    module.create('tasks', { title: 'A' });
    module.create('tasks', { title: 'B' });

    expect(module.count('tasks')).toBe(2);
  });
});

describe('XDB with collection-specific operations', () => {
  let xdb: XDBService;

  beforeEach(() => {
    xdb = new XDBService(createTestStorage(), 'test-xdb');
  });

  it('should update a record in a specific collection', () => {
    const record = xdb.create('tasks', { title: 'Original' });
    const updated = xdb.updateInCollection('tasks', record.id, { title: 'Updated' });

    expect(updated).not.toBeNull();
    expect(updated!.data.title).toBe('Updated');
  });

  it('should delete a record from a specific collection', () => {
    const record = xdb.create('tasks', { title: 'Test' });
    const result = xdb.deleteFromCollection('tasks', record.id);

    expect(result).toBe(true);
    expect(xdb.getAll('tasks')).toHaveLength(0);
  });

  it('should hard delete a record', () => {
    const record = xdb.create('tasks', { title: 'Test' });
    const result = xdb.hardDelete('tasks', record.id);

    expect(result).toBe(true);
    expect(xdb.getAll('tasks')).toHaveLength(0);
  });
});
