// @vitest-environment jsdom
/**
 * A record added in the Data view has an id from the moment it is made.
 *
 * Its key field, `id`, required, was written as `""`: the row went into the
 * .xdb with an empty key and nothing said so, while the record itself was
 * written under an id of its own that nothing on the screen showed. The key
 * is that id now, and it follows the record when the records are
 * re-identified.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readBundleEntries } from '@softn/core';
import { useSchemaStore } from './schemaStore';
import { useProjectStore } from './projectStore';
import { useFilesStore } from './filesStore';
import { useCanvasStore } from './canvasStore';
import { buildProjectBundle, flushCanvasToActiveFile } from '../utils/buildProjectBundle';

const schema = () => useSchemaStore.getState();

/** The records of `name`'s .xdb as the export writes them. */
async function exportedRecords(name: string): Promise<Array<{ id: string; updated_at: string; data: Record<string, unknown> }>> {
  const entries = await readBundleEntries(await buildProjectBundle());
  const bytes = entries.get(`xdb/${name}.xdb`);
  if (!bytes) throw new Error(`no xdb/${name}.xdb in ${[...entries.keys()].join(', ')}`);
  return JSON.parse(new TextDecoder().decode(bytes)).records;
}

beforeEach(() => {
  useSchemaStore.getState().reset();
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useCanvasStore.getState().addElement('Text', useCanvasStore.getState().rootId, undefined, { starter: true });
  flushCanvasToActiveFile();
});

describe('a record added in the Data view', () => {
  it('has its key set to the id it is written under, and exports it so', async () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    schema().updateEntity(id, { name: 'tasks' });
    schema().addSeedRecord(id);
    const row = schema().seedData.get(id)![0];
    const identity = schema().recordIdentity.get(id)![0];
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.id).toBe(identity.id);
    const [record] = await exportedRecords('tasks');
    expect(record.id).toBe(row.id);
    expect(record.data.id).toBe(row.id);
  });

  it('is not an edit at its first export: its updated time is the one it was made with', async () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    schema().updateEntity(id, { name: 'tasks' });
    schema().addSeedRecord(id);
    const identity = schema().recordIdentity.get(id)![0];
    const [record] = await exportedRecords('tasks');
    expect(record.updated_at).toBe(identity.updated_at);
  });

  it('keeps a key field that has a default of its own, or that holds a number', () => {
    schema().loadEntities([
      { id: 'a', name: 'a', alias: 'a', position: { x: 0, y: 0 }, fields: [{ id: 'k', name: 'id', type: 'string', required: true, defaultValue: 'fixed' }] },
      { id: 'b', name: 'b', alias: 'b', position: { x: 0, y: 0 }, fields: [{ id: 'k', name: 'id', type: 'number', required: true }] },
    ]);
    schema().addSeedRecord('a');
    schema().addSeedRecord('b');
    expect(schema().seedData.get('a')![0].id).toBe('fixed');
    expect(schema().seedData.get('b')![0].id).toBe(0);
  });

  it('keeps its key in step with its id when the records are re-identified, and gets it back on undo', () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    schema().addSeedRecord(id);
    const before = schema().seedData.get(id)![0].id;
    schema().reidentifyRecords(id);
    const row = schema().seedData.get(id)![0];
    const identity = schema().recordIdentity.get(id)![0];
    expect(identity.id).not.toBe(before);
    expect(row.id).toBe(identity.id);
    // The baseline is the row as it now is, so the next export is not an edit.
    expect(identity.data).toEqual(row);
    expect(schema().undoReidentify()).toBe(true);
    expect(schema().seedData.get(id)![0].id).toBe(before);
    expect(schema().recordIdentity.get(id)![0].id).toBe(before);
  });

  it('leaves a key typed by hand alone when the records are re-identified', () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    schema().addSeedRecord(id);
    schema().updateSeedRecord(id, 0, { id: 'task-1' });
    schema().reidentifyRecords(id);
    expect(schema().seedData.get(id)![0].id).toBe('task-1');
  });
});
