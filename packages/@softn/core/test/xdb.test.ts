/**
 * XDB Service Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { XDBService, XDBStorageError, createXDBModule, createEphemeralXDBScope } from '../src/runtime/xdb';
import { createDBNamespace } from '../src/runtime/script-runtime';

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

    it('keeps a caller-chosen id when it is free, and generates one when it is not', () => {
      const chosen = xdb.create('tasks', { title: 'chosen' }, { id: 'given-id' });
      expect(chosen.id).toBe('given-id');
      expect(xdb.get('tasks', 'given-id')?.data.title).toBe('chosen');
      const clash = xdb.create('tasks', { title: 'clash' }, { id: 'given-id' });
      expect(clash.id).not.toBe('given-id');
      expect(xdb.get('tasks', 'given-id')?.data.title).toBe('chosen');
      // A tombstoned id is not reused either.
      xdb.delete('given-id');
      expect(xdb.create('tasks', { title: 'later' }, { id: 'given-id' }).id).not.toBe('given-id');
      expect(xdb.create('tasks', { title: 'blank' }, { id: '' }).id).not.toBe('');
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

/**
 * `delete(id)` of a record that is deleted already. It found the tombstone,
 * stamped it again, announced the delete again (to the page and to server
 * sync) and answered true, where `deleteFromCollection` answers false.
 */
describe('deleting a record twice', () => {
  it('answers false the second time and announces nothing', () => {
    const xdb = new XDBService(createTestStorage(), 'test-xdb');
    const record = xdb.create('tasks', { title: 'once' });
    expect(xdb.delete(record.id)).toBe(true);
    const stamp = xdb.getAllRaw('tasks')[0].updated_at;
    const events: string[] = [];
    xdb.subscribe('tasks', (event) => events.push(event.type));
    xdb.onMutation((event) => events.push(`mutation:${event.type}`));

    expect(xdb.delete(record.id)).toBe(false);
    expect(events).toEqual([]);
    expect(xdb.getAllRaw('tasks')[0].updated_at).toBe(stamp);
  });
});

/**
 * A store opened again on a storage that has getItem, setItem and removeItem
 * and nothing else, which is all XDBStorage asks for. It knew only the
 * collections the page had touched since it opened, so a record could not be
 * found by id, updated, deleted or exported, and a server pull named none of
 * them. The store keeps a list of its collections on such a storage.
 */
describe('a store reopened on a storage that cannot list its keys', () => {
  it('finds its records by id, exports them and names their collections', () => {
    const storage = createTestStorage();
    const first = new XDBService(storage, 'test-xdb');
    const record = first.create('notes', { n: 1 });
    first.create('tags', { n: 2 });

    const again = new XDBService(storage, 'test-xdb');
    expect(again.getCollections().sort()).toEqual(['notes', 'tags']);
    expect(again.update(record.id, { n: 3 })?.data).toEqual({ n: 3 });
    expect(Object.keys(again.export().collections).sort()).toEqual(['notes', 'tags']);
    expect(again.delete(record.id)).toBe(true);

    // A cleared collection is no longer listed.
    again.clear('tags');
    expect(new XDBService(storage, 'test-xdb').getCollections()).toEqual(['notes']);
  });

  it('names the collections a listing storage holds, not only those this page touched', () => {
    const store = new Map<string, string>();
    const storage = {
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    new XDBService(storage as unknown as Storage, 'test-xdb').create('notes', { n: 1 });
    expect(new XDBService(storage as unknown as Storage, 'test-xdb').getCollections()).toEqual(['notes']);
    // Nothing else is written beside the records on such a storage.
    expect([...store.keys()]).toEqual(['test-xdb:notes']);
  });
});

/**
 * A collection name with a colon. The colon separates an app's prefix from
 * its collections in a storage key, so the default store's "A:notes" was app
 * A's "notes": a create there wrote into app A's records, and a lookup by id
 * passed it over. Such a name is refused, as an import already refused it.
 */
describe('a collection name with a colon', () => {
  it('is refused, and the default store can neither write nor read another app\'s records with it', () => {
    const storage = window.localStorage;
    storage.clear();
    const shared = new XDBService(storage, 'xdb');
    const app = new XDBService(storage, 'xdb:A', 'A');
    app.create('notes', { mine: true }, { id: 'a1' });

    expect(() => shared.create('A:notes', { injected: true })).toThrow(/not a valid collection name/);
    expect(() => shared.writeRecord('A:notes', { id: 'x', collection: 'A:notes', data: {}, created_at: '', updated_at: '', deleted: false })).toThrow(/not a valid collection name/);
    expect(() => shared.clear('A:notes')).toThrow(/not a valid collection name/);
    expect(shared.query('A:notes')).toEqual([]);
    expect(() => shared.create('', {})).toThrow(/not a valid collection name/);
    expect(app.query('notes').map((r) => r.id)).toEqual(['a1']);
    storage.clear();
  });
});

/**
 * What a record holds is what JSON makes of it, from the start. `create`
 * returned the caller's own object, so a `Date` came back as a Date from
 * `create` and as a string from `get`, and went to peers as `{}`. A value
 * JSON cannot hold was refused by the write as a full disk, and the store
 * then reported itself degraded.
 */
describe('record data JSON cannot hold, or holds differently', () => {
  it('is returned and announced as it is read back', () => {
    const xdb = new XDBService(createTestStorage(), 'test-xdb');
    const announced: unknown[] = [];
    xdb.subscribe('events', (event) => announced.push(event.record?.data.when));
    const when = new Date('2026-03-04T05:06:07.000Z');
    const record = xdb.create('events', { when, gone: undefined });
    expect(record.data).toEqual({ when: '2026-03-04T05:06:07.000Z' });
    expect(xdb.update(record.id, { when })?.data.when).toBe('2026-03-04T05:06:07.000Z');
    expect(announced).toEqual(['2026-03-04T05:06:07.000Z', '2026-03-04T05:06:07.000Z']);
    expect(xdb.get('events', record.id)?.data.when).toBe('2026-03-04T05:06:07.000Z');
  });

  it('is refused as what it is, and the store stays ready', () => {
    const xdb = new XDBService(createTestStorage(), 'test-xdb');
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const deepest = deep;
    for (let i = 0; i < 20_000; i++) {
      const next = {};
      deep.n = next;
      deep = next;
    }
    for (const data of [cyclic, { big: BigInt(1) }, deepest]) {
      let error: unknown;
      try {
        xdb.create('notes', data);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(XDBStorageError);
      expect((error as XDBStorageError).kind).toBe('invalid-data');
    }
    const kept = xdb.create('notes', { fine: true });
    expect(() => xdb.update(kept.id, { big: BigInt(2) })).toThrow(XDBStorageError);
    expect(xdb.query('notes').map((r) => r.data)).toEqual([{ fine: true }]);
    expect(xdb.getStorageStatus()).toMatchObject({ state: 'ready', issues: [] });
  });
});

/**
 * A filter or sort on a field every object inherits. `data.constructor` read
 * Object's constructor for a record without the field, so sorting on it put
 * those records first, and a filter on it matched records that had no such
 * field. And an imported row whose `data` is not an object (an export file
 * is user JSON) made every filtered or sorted query of its collection throw.
 */
describe('reading a field of a record', () => {
  for (const field of ['constructor', 'toString', 'valueOf']) {
    it(`sorts records without "${field}" last, as for any missing field`, () => {
      const xdb = new XDBService(createTestStorage(), 'test-xdb');
      xdb.create('notes', { [field]: 'b' }, { id: 'has-b' });
      xdb.create('notes', {}, { id: 'missing' });
      xdb.create('notes', { [field]: 'a' }, { id: 'has-a' });
      expect(xdb.query('notes', { sort: { field, order: 'asc' } }).map((r) => r.id)).toEqual(['has-a', 'has-b', 'missing']);
      expect(xdb.query('notes', { sort: { field, order: 'desc' } }).map((r) => r.id)).toEqual(['has-b', 'has-a', 'missing']);
    });
  }

  it('matches a filter on an inherited name only where the record has it', () => {
    const xdb = new XDBService(createTestStorage(), 'test-xdb');
    xdb.create('notes', {}, { id: 'missing' });
    expect(xdb.query('notes', { filter: { constructor: Object } })).toEqual([]);
  });

  for (const row of [{ id: 'x' }, { id: 'x', data: null }, { id: 'x', data: 'text' }, { id: 'x', data: [1] }]) {
    it(`does not throw for an imported row like ${JSON.stringify(row)}`, () => {
      const xdb = new XDBService(createTestStorage(), 'test-xdb');
      xdb.create('notes', { status: 'open' }, { id: 'open' });
      xdb.import({ version: 1, exportedAt: '', collections: { notes: [row as never] } });
      expect(xdb.query('notes', { filter: { status: 'open' } }).map((r) => r.id)).toEqual(['open']);
      expect(xdb.query('notes', { sort: { field: 'status', order: 'asc' } }).map((r) => r.id)).toEqual(['open', 'x']);
      expect(xdb.update('x', { a: 1 })?.data).toEqual({ a: 1 });
    });
  }
});

/**
 * `db.prune` and `db.clearCollection` removed records one `hardDelete` at a
 * time, and each read and rewrote the whole collection: pruning grew with
 * the square of its size. They remove in one write, still telling server
 * sync of every record, and listeners hear of it as of a script's call.
 */
describe('removing many records for good', () => {
  function counting() {
    const storage = createTestStorage();
    const writes: string[] = [];
    const setItem = storage.setItem;
    storage.setItem = (key: string, value: string) => {
      writes.push(key);
      return setItem(key, value);
    };
    return { storage, writes };
  }

  it('writes the collection once, and tells server sync of each record', () => {
    const { storage, writes } = counting();
    const xdb = new XDBService(storage, 'test-xdb');
    for (let i = 0; i < 50; i++) xdb.create('log', { i }, { id: `r${i}` });
    const events: string[] = [];
    const mutations: string[] = [];
    xdb.subscribe('log', (event) => events.push(event.type));
    xdb.onMutation((event) => mutations.push(`${event.type}:${event.recordId}`));
    writes.length = 0;

    expect(xdb.hardDeleteMany('log', ['r0', 'r1', 'r2', 'missing'])).toBe(3);
    expect(writes).toEqual(['test-xdb:log']);
    expect(events).toEqual(['refresh']);
    expect(mutations).toEqual(['delete:r0', 'delete:r1', 'delete:r2']);
    expect(xdb.count('log')).toBe(47);
  });

  it('is how db.prune and db.clearCollection remove', async () => {
    const scope = createEphemeralXDBScope();
    try {
      for (let i = 0; i < 20; i++) scope.xdb.create('log', { i }, { id: `r${i}` });
      const one = vi.spyOn(scope.xdb, 'hardDelete');
      const many = vi.spyOn(scope.xdb, 'hardDeleteMany');
      const db = createDBNamespace(undefined, scope.appId);
      await db.ready();
      expect(db.prune('log', 5)).toBe(15);
      expect(scope.xdb.query('log').map((r) => r.id)).toEqual(['r15', 'r16', 'r17', 'r18', 'r19']);
      db.clearCollection('log');
      expect(scope.xdb.count('log')).toBe(0);
      expect(one).not.toHaveBeenCalled();
      expect(many).toHaveBeenCalledTimes(2);
    } finally {
      scope.dispose();
    }
  });
});
