// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { useSchemaStore } from '../stores/schemaStore';
import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';
import { useCanvasStore } from '../stores/canvasStore';
import type { EntityDef, RelationshipDraft, SchemaField } from '../types/builder';
import { buildProjectBundle } from './buildProjectBundle';
import { loadBundle } from './bundleLoader';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from './openProject';
import { readBuilderSchema, withBuilderSchema } from './builderSchemaMetadata';

const field = (name: string, extra: Partial<SchemaField> = {}): SchemaField => ({ id: `field-${name}`, name, type: 'string', required: false, ...extra });
const entity = (name: string, fields: SchemaField[] = []): EntityDef => ({ id: `local-${name}`, name, alias: name, fields: [field('id'), ...fields], position: { x: 12, y: 34 } });
const draft = (extra: Partial<RelationshipDraft> = {}): RelationshipDraft => ({ sourceEntityId: 'local-tasks', sourceFieldId: '', targetEntityId: 'local-people', type: 'many-to-one', ...extra });
const row = { id: 'business-id', title: 'Write notes', owner: 'person-1', hidden: 'keep this value' };
const store = () => useSchemaStore.getState();

beforeEach(() => {
  useSchemaStore.getState().reset();
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  store().loadEntities([entity('tasks', [field('title'), field('owner'), field('count', { type: 'number' })]), entity('people'), entity('teams')]);
  store().loadSeedData(new Map([['local-tasks', [row]]]));
});

function fixture(builder?: unknown, reference = false) {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ name: 'Relationships', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: ['xdb/tasks.xdb', 'xdb/people.xdb'], assets: [] }, ...(builder ? { builder } : {}) })),
    'ui/main.ui': strToU8('<App><Text>Relationships</Text></App>'),
    'xdb/tasks.xdb': strToU8(JSON.stringify({ collection: 'tasks', schema: { alias: 'tasks', fields: [field('id'), field('title'), field('owner', reference ? { type: 'reference', refEntity: 'people' } : {})] }, records: [{ id: 'task-1', collection: 'tasks', data: row, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }] })),
    'xdb/people.xdb': strToU8(JSON.stringify({ collection: 'people', schema: { alias: 'people', fields: [field('name')] }, records: [{ id: 'person-1', collection: 'people', data: { name: 'Sample person' }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }] })),
  });
}

describe('relationship edits', () => {
  it.each(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'] as const)('creates a diagram-only %s link without changing fields or data', type => {
    const entities = store().entities;
    expect(store().addRelationship(draft({ type }))).toBeNull();
    expect(store().relationships[0]).toMatchObject({ type, sourceFieldId: '' });
    expect(store().entities).toBe(entities);
    expect(store().seedData.get('local-tasks')).toEqual([row]);
    expect(useProjectStore.getState().isDirty).toBe(true);
  });

  it('links an existing field without overwriting its values or record identity', () => {
    const rows = store().seedData;
    const identities = store().recordIdentity;
    expect(store().addRelationship(draft({ sourceFieldId: 'field-owner' }))).toBeNull();
    expect(store().entities[0].fields.find(item => item.name === 'owner')).toMatchObject({ type: 'reference', refEntity: 'local-people' });
    expect(store().seedData).toBe(rows);
    expect(store().recordIdentity).toBe(identities);
  });

  it('creates a self-reference field and retains it when its edge is edited or removed', () => {
    expect(store().addRelationship(draft({ targetEntityId: 'local-tasks', newFieldName: ' parentTask ', type: 'one-to-one' }))).toBeNull();
    const relationship = store().relationships[0];
    const created = store().entities[0].fields.find(item => item.name === 'parentTask');
    expect(created).toMatchObject({ id: relationship.sourceFieldId, type: 'reference', refEntity: 'local-tasks', required: false });
    expect(store().updateRelationship(relationship.id, draft({ targetEntityId: 'local-tasks', type: 'many-to-many' }))).toBeNull();
    expect(store().relationships[0]).toMatchObject({ sourceFieldId: '', type: 'many-to-many' });
    store().deleteRelationship(relationship.id);
    expect(store().relationships).toEqual([]);
    expect(store().entities[0].fields).toContainEqual(created);
    expect(store().seedData.get('local-tasks')).toEqual([row]);
  });

  it.each([
    [{ sourceEntityId: 'missing' }, /available collections/],
    [{ targetEntityId: 'missing' }, /available collections/],
    [{ sourceFieldId: 'missing' }, /no longer available/],
    [{ sourceFieldId: 'field-id' }, /other than id/],
    [{ sourceFieldId: 'field-count' }, /string or reference/],
    [{ sourceFieldId: 'field-owner', type: 'one-to-many' }, /many-to-one or one-to-one/],
    [{ newFieldName: 'owner' }, /already exists/],
    [{ newFieldName: 'hidden' }, /Records already contain/],
    [{ newFieldName: '  ' }, /Enter a reference field name/],
    [{ newFieldName: '__proto__' }, /another name/],
    [{ sourceFieldId: 'field-owner', newFieldName: 'another' }, /existing field or create/],
  ] as [Partial<RelationshipDraft>, RegExp][])('rejects invalid link %j atomically', (extra, message) => {
    const before = store();
    expect(store().addRelationship(draft(extra))).toMatch(message);
    expect(store()).toBe(before);
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  it('rejects duplicate edges and fields attached to a different collection without dirtying', () => {
    expect(store().addRelationship(draft({ sourceFieldId: 'field-owner' }))).toBeNull();
    useProjectStore.setState({ isDirty: false });
    const before = store();
    expect(store().addRelationship(draft({ sourceFieldId: 'field-owner', type: 'one-to-one' }))).toMatch(/already has a relationship/);
    expect(store().updateRelationship(store().relationships[0].id, draft({ sourceFieldId: 'field-owner', targetEntityId: 'local-teams' }))).toMatch(/already references another collection/);
    expect(store()).toBe(before);
    expect(useProjectStore.getState().isDirty).toBe(false);
    store().addRelationship(draft());
    useProjectStore.setState({ isDirty: false });
    expect(store().addRelationship(draft({ type: 'many-to-many' }))).toMatch(/already have this diagram link/);
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  it('edits cardinality, skips no-op updates and reports missing relationships', () => {
    store().addRelationship(draft({ sourceFieldId: 'field-owner' }));
    const id = store().relationships[0].id;
    expect(store().updateRelationship(id, draft({ sourceFieldId: 'field-owner', type: 'one-to-one' }))).toBeNull();
    expect(store().relationships[0].type).toBe('one-to-one');
    useProjectStore.setState({ isDirty: false });
    expect(store().updateRelationship(id, draft({ sourceFieldId: 'field-owner', type: 'one-to-one' }))).toBeNull();
    expect(store().updateRelationship('missing', draft())).toMatch(/no longer available/);
    store().deleteRelationship('missing');
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  it('clears edges on field removal while retaining unknown row values', () => {
    store().addRelationship(draft({ sourceFieldId: 'field-owner' }));
    store().deleteField('local-tasks', 'field-owner');
    expect(store().relationships).toEqual([]);
    expect(store().seedData.get('local-tasks')).toEqual([row]);
  });

  it('clears incoming metadata on target removal and keeps referring values', () => {
    store().addRelationship(draft({ sourceFieldId: 'field-owner' }));
    store().deleteEntity('local-people');
    expect(store().relationships).toEqual([]);
    expect(store().entities[0].fields.find(item => item.name === 'owner')?.refEntity).toBeUndefined();
    expect(store().seedData.get('local-tasks')).toEqual([row]);
  });

  it('clears a link when its field type changes outside the diagram', () => {
    store().addRelationship(draft({ sourceFieldId: 'field-owner' }));
    store().updateField('local-tasks', 'field-owner', { type: 'string' });
    expect(store().relationships).toEqual([]);
    expect(store().entities[0].fields.find(item => item.name === 'owner')?.refEntity).toBeUndefined();
    expect(store().seedData.get('local-tasks')).toEqual([row]);
  });

  it('shows reference changes from the field editor without resurrecting deliberately removed edges on rename', () => {
    expect(store().updateField('local-tasks', 'field-owner', { type: 'reference', refEntity: 'local-people' })).toBeNull();
    expect(store().relationships[0]).toMatchObject({ sourceFieldId: 'field-owner', targetEntityId: 'local-people', type: 'many-to-one' });
    const id = store().relationships[0].id;
    store().updateRelationship(id, draft({ sourceFieldId: 'field-owner', type: 'one-to-one' }));
    store().updateField('local-tasks', 'field-owner', { name: 'contact' });
    expect(store().relationships[0]).toMatchObject({ id, type: 'one-to-one' });
    store().deleteRelationship(id);
    store().updateField('local-tasks', 'field-owner', { name: 'owner' });
    expect(store().relationships).toEqual([]);
    store().updateField('local-tasks', 'field-owner', { refEntity: 'local-teams' });
    expect(store().relationships).toHaveLength(1);
    expect(store().relationships[0]).toMatchObject({ targetEntityId: 'local-teams', type: 'many-to-one' });
    expect(store().seedData.get('local-tasks')).toEqual([row]);
  });
});

describe('bundle and session diagram persistence', () => {
  it('saves and reopens names, positions, reference links and diagram-only links with record identity intact', async () => {
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(fixture({ customLayout: 'preserve me' }))));
    const [tasks, people] = store().entities;
    store().addRelationship({ sourceEntityId: tasks.id, sourceFieldId: 'field-owner', targetEntityId: people.id, type: 'one-to-one' });
    store().addRelationship({ sourceEntityId: tasks.id, sourceFieldId: '', targetEntityId: people.id, type: 'many-to-many' });
    store().updateEntity(tasks.id, { position: { x: 64, y: 256 } });
    store().updateEntity(people.id, { name: 'contacts', position: { x: 550, y: 160 } });
    store().updateField(tasks.id, 'field-owner', { name: 'contact' });
    const reopened = await loadBundle(await buildProjectBundle());
    expect(reopened.rawManifest.builder).toEqual({ customLayout: 'preserve me', schema: { version: 1,
      collections: [{ name: 'tasks', position: { x: 64, y: 256 } }, { name: 'contacts', position: { x: 550, y: 160 } }],
      relationships: [
        { sourceCollection: 'tasks', sourceField: 'contact', targetCollection: 'contacts', type: 'one-to-one' },
        { sourceCollection: 'tasks', sourceField: '', targetCollection: 'contacts', type: 'many-to-many' },
      ],
    } });
    expect(reopened.relationships.map(item => [item.targetEntityId, item.type])).toEqual([['entity_contacts', 'one-to-one'], ['entity_contacts', 'many-to-many']]);
    expect(reopened.entities[0].fields.find(item => item.name === 'contact')?.refEntity).toBe('entity_contacts');
    expect(reopened.entities.map(item => item.position)).toEqual([{ x: 64, y: 256 }, { x: 550, y: 160 }]);
    expect(reopened.seedData.get('entity_tasks')).toEqual([{ id: row.id, title: row.title, contact: row.owner, hidden: row.hidden }]);
    expect(reopened.recordIdentity.get('entity_tasks')?.[0]).toMatchObject({ id: 'task-1', created_at: '2026-01-01T00:00:00.000Z' });
    commitProjectSnapshot(prepareProjectSnapshot(reopened));
    expect(store().relationships).toEqual(reopened.relationships);
    expect(prepareSessionSnapshot(JSON.stringify(captureSession('data'))).schema.relationships).toEqual(reopened.relationships);
  });

  it('infers old reference fields but does not resurrect an explicitly deleted edge after reopen', async () => {
    const loaded = await loadBundle(fixture(undefined, true));
    expect(loaded.relationships).toHaveLength(1);
    expect(loaded.relationships[0].type).toBe('many-to-one');
    commitProjectSnapshot(prepareProjectSnapshot(loaded));
    const noEdit = await loadBundle(await buildProjectBundle());
    expect(noEdit.rawManifest.builder).toBeUndefined();
    store().deleteRelationship(store().relationships[0].id);
    const reopened = await loadBundle(await buildProjectBundle());
    expect(reopened.relationships).toEqual([]);
    expect(reopened.entities[0].fields.find(item => item.name === 'owner')).toMatchObject({ type: 'reference', refEntity: 'entity_people' });
    expect(reopened.seedData.get('entity_tasks')).toEqual([row]);
  });

  it('remaps persisted names to fresh editor IDs and rejects malformed or dangling links', () => {
    const entities = [entity('tasks', [field('owner', { type: 'reference', refEntity: 'local-people' })]), entity('people')];
    const manifest = withBuilderSchema({ builder: { custom: true } }, entities, [{ id: 'old-edge', ...draft({ sourceFieldId: 'field-owner' }) }])!;
    const fresh = entities.map(item => ({ ...item, id: `fresh-${item.name}`, fields: item.fields.map(item => ({ ...item, id: `fresh-${item.name}`, ...(item.refEntity ? { refEntity: 'fresh-people' } : {}) })) }));
    const loaded = readBuilderSchema(manifest, fresh);
    expect(loaded.relationships[0]).toMatchObject({ sourceEntityId: 'fresh-tasks', sourceFieldId: 'fresh-owner', targetEntityId: 'fresh-people' });
    const metadata = (manifest.builder as { schema: { relationships: unknown[] } }).schema;
    metadata.relationships.push(null, { sourceCollection: 'missing', sourceField: '', targetCollection: 'people', type: 'one-to-one' }, { sourceCollection: 'tasks', sourceField: 'id', targetCollection: 'people', type: 'one-to-one' }, metadata.relationships[0]);
    expect(readBuilderSchema(manifest, fresh).relationships).toHaveLength(1);
  });

  it('preserves a new reference field and its saved values when the target is deleted', async () => {
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(fixture())));
    const [tasks, people] = store().entities;
    expect(store().addRelationship({ sourceEntityId: tasks.id, targetEntityId: people.id, sourceFieldId: '', type: 'many-to-one', newFieldName: 'reviewer' })).toBeNull();
    store().updateSeedRecord(tasks.id, 0, { ...row, reviewer: 'person-1' });
    const linked = await loadBundle(await buildProjectBundle());
    expect(linked.relationships[0]).toMatchObject({ sourceEntityId: tasks.id, targetEntityId: people.id });
    expect(linked.entities[0].fields.find(item => item.name === 'reviewer')).toMatchObject({ type: 'reference', refEntity: people.id });
    commitProjectSnapshot(prepareProjectSnapshot(linked));
    store().deleteEntity(people.id);
    const reopened = await loadBundle(await buildProjectBundle());
    expect(reopened.relationships).toEqual([]);
    expect(reopened.entities[0].fields.find(item => item.name === 'reviewer')?.refEntity).toBeUndefined();
    expect(reopened.seedData.get(tasks.id)).toEqual([{ ...row, reviewer: 'person-1' }]);
    expect(reopened.recordIdentity.get(tasks.id)?.[0].id).toBe('task-1');
  });
});
