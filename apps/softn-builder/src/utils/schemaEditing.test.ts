// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { useSchemaStore } from '../stores/schemaStore';
import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';
import { useCanvasStore } from '../stores/canvasStore';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle } from './buildProjectBundle';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from './openProject';
import type { EntityDef, SchemaField } from '../types/builder';
import { ensureFieldIds } from './schemaFields';

const field = (name: string, id = name): SchemaField => ({ name, id, type: 'string', required: false });
const entity = (name: string, fields = [field('title'), field('lane')]): EntityDef => ({ id: name, name, alias: name, fields, position: { x: 0, y: 0 } });
const row = { title: 'Plan the garden', lane: 'Today', hidden: 'Keep me' };

function bundle(fields: unknown[]) {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ name: 'Sample tasks', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: ['xdb/tasks.xdb'], assets: [] } })),
    'ui/main.ui': strToU8('<data><collection name="tasks" as="tasks" /></data><App><Text>Sample</Text></App>'),
    'xdb/tasks.xdb': strToU8(JSON.stringify({ collection: 'tasks', schema: { alias: 'tasks', fields }, records: [{ id: 'record-1', data: row, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }] })),
  });
}

beforeEach(() => {
  useSchemaStore.getState().reset();
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
});

describe('imported schema field identities', () => {
  it('repairs missing and duplicate editor IDs without replacing valid IDs', () => {
    const fields = [field('first', ''), field('second', 'same'), field('third', 'same'), field('reserved', 'field_1')];
    const normalized = ensureFieldIds(fields);
    expect(new Set(normalized.map(f => f.id)).size).toBe(4);
    expect(normalized[1]).toBe(fields[1]);
    expect(normalized[3]).toBe(fields[3]);
    expect(ensureFieldIds(normalized)).toEqual(normalized);
  });

  it('imports fields without IDs, edits exactly one, and preserves data and IDs after save/reopen', async () => {
    const imported = await loadBundle(bundle([{ name: 'title', type: 'string', required: true }, { name: 'lane', type: 'string', required: false }]));
    commitProjectSnapshot(prepareProjectSnapshot(imported));
    const initial = useSchemaStore.getState().entities[0];
    expect(initial.fields.every(f => !!f.id)).toBe(true);
    expect(new Set(initial.fields.map(f => f.id)).size).toBe(2);
    expect(useSchemaStore.getState().updateField(initial.id, initial.fields[0].id, { name: 'task' })).toBeNull();
    const reopened = await loadBundle(await buildProjectBundle());
    expect(reopened.entities[0].fields.map(f => f.name)).toEqual(['task', 'lane']);
    expect(reopened.entities[0].fields.map(f => f.id)).toEqual(initial.fields.map(f => f.id));
    expect(reopened.seedData.get(reopened.entities[0].id)).toEqual([{ task: row.title, lane: row.lane, hidden: row.hidden }]);
    expect(reopened.recordIdentity.get(reopened.entities[0].id)?.[0].id).toBe('record-1');
    expect(reopened.recordIdentity.get(reopened.entities[0].id)?.[0].created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('repairs saved-session IDs and bulk-loaded fields too', async () => {
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundle([field('title'), field('lane')]))));
    const session = captureSession('data');
    session.schema.entities[0].fields = [field('title', ''), field('lane', '')];
    const restored = prepareSessionSnapshot(JSON.stringify(session));
    expect(new Set(restored.schema.entities[0].fields.map(f => f.id)).size).toBe(2);
    useSchemaStore.getState().loadEntities([entity('tasks', [field('title', 'same'), field('lane', 'same')])]);
    expect(new Set(useSchemaStore.getState().entities[0].fields.map(f => f.id)).size).toBe(2);
  });
});

describe('safe schema renames', () => {
  beforeEach(() => {
    useSchemaStore.getState().loadEntities([entity('tasks'), entity('notes')]);
    useSchemaStore.getState().loadSeedData(new Map([['tasks', [row]]]));
  });

  it.each(['lane', 'hidden', '   '])('rejects field name %j without modifying any data or dirty state', name => {
    const before = useSchemaStore.getState();
    const revision = useProjectStore.getState().revision;
    expect(before.updateField('tasks', 'title', { name })).toBeTypeOf('string');
    expect(useSchemaStore.getState()).toBe(before);
    expect(useSchemaStore.getState().seedData.get('tasks')).toEqual([row]);
    expect(useProjectStore.getState().revision).toBe(revision);
  });

  it('rejects a duplicate/empty collection name or alias before changing the schema', () => {
    const before = useSchemaStore.getState();
    expect(before.updateEntity('tasks', { name: 'notes' })).toMatch(/already exists/);
    expect(before.updateEntity('tasks', { name: ' ' })).toMatch(/Enter/);
    expect(before.updateEntity('tasks', { alias: 'notes' })).toMatch(/in use/);
    expect(before.updateEntity('tasks', { alias: ' ' })).toMatch(/Enter/);
    expect(useSchemaStore.getState()).toBe(before);
  });

  it('allows a valid rename and ignores unchanged names without marking dirty', () => {
    const revision = useProjectStore.getState().revision;
    expect(useSchemaStore.getState().updateField('tasks', 'title', { name: ' title ' })).toBeNull();
    expect(useSchemaStore.getState().updateEntity('tasks', { name: ' tasks ' })).toBeNull();
    expect(useProjectStore.getState().revision).toBe(revision);
    expect(useSchemaStore.getState().updateField('tasks', 'title', { name: 'task' })).toBeNull();
    expect(useSchemaStore.getState().seedData.get('tasks')).toEqual([{ task: row.title, lane: row.lane, hidden: row.hidden }]);
    expect(useProjectStore.getState().revision).toBeGreaterThan(revision);
  });

  it('refuses duplicate collections already present in an old session before exporting', async () => {
    useSchemaStore.setState({ entities: [entity('tasks'), { ...entity('tasks'), id: 'other' }] });
    await expect(buildProjectBundle()).rejects.toThrow('Two collections are named "tasks"');
  });

  it('refuses duplicate fields already present in an old session before exporting', async () => {
    useSchemaStore.setState({ entities: [entity('tasks', [field('title'), field('title', 'other')])] });
    await expect(buildProjectBundle()).rejects.toThrow('two fields named "title"');
  });
});
