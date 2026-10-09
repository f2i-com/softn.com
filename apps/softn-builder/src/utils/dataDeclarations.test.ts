/**
 * A collection changed in Data is changed in the pages that declare it.
 * See dataDeclarations.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from '@softn/core';
import { changeDataDeclarations } from './dataDeclarations';
import { useFilesStore } from '../stores/filesStore';
import { useSchemaStore } from '../stores/schemaStore';
import { useProjectStore } from '../stores/projectStore';

const PAGE = `// The tasks page.
<logic src="../logic/main.logic" />

<data>
  <collection name="tasks" as="tasks" />
  <collection name="people" as="team" filter={{ active: true }} />
</data>

<App>
  <Text>{tasks.length}</Text>
</App>
`;

function declared(source: string): Array<[string, string | undefined]> {
  const doc = parse(source);
  expect(doc.diagnostics ?? []).toEqual([]);
  return (doc.data?.collections ?? []).map((c) => [c.name, c.as]);
}

describe('the text of a <data> block', () => {
  it('takes a renamed collection under its new name and keeps the name the page reads it by', () => {
    const out = changeDataDeclarations(PAGE, { kind: 'rename', from: 'tasks', to: 'todos' });
    expect(declared(out)).toEqual([['todos', 'tasks'], ['people', 'team']]);
    // Nothing else moved.
    expect(out).toBe(PAGE.replace('name="tasks"', 'name="todos"'));
  });

  it('declares an added collection on the entry page, after the others', () => {
    const out = changeDataDeclarations(PAGE, { kind: 'add', name: 'projects', alias: 'projects' }, true);
    expect(declared(out)).toEqual([['tasks', 'tasks'], ['people', 'team'], ['projects', 'projects']]);
    expect(out).toContain('  <collection name="people" as="team" filter={{ active: true }} />\n  <collection name="projects" as="projects" />\n</data>');
    // Not twice, and not on a page that is not the entry.
    expect(changeDataDeclarations(out, { kind: 'add', name: 'projects', alias: 'projects' }, true)).toBe(out);
    expect(changeDataDeclarations(PAGE, { kind: 'add', name: 'projects', alias: 'projects' })).toBe(PAGE);
  });

  it('gives a page that has no block one, before its template and after what stands above it', () => {
    const page = '// A page.\n<logic src="../logic/main.logic" />\n\n<App>\n  <Text>Hi</Text>\n</App>\n';
    const out = changeDataDeclarations(page, { kind: 'add', name: 'notes', alias: 'notes' }, true);
    expect(out).toBe('// A page.\n<logic src="../logic/main.logic" />\n\n<data>\n  <collection name="notes" as="notes" />\n</data>\n\n<App>\n  <Text>Hi</Text>\n</App>\n');
    expect(declared(out)).toEqual([['notes', 'notes']]);
  });

  it('takes out the declaration of a collection that was deleted, and its line', () => {
    const out = changeDataDeclarations(PAGE, { kind: 'remove', name: 'tasks' });
    expect(declared(out)).toEqual([['people', 'team']]);
    expect(out).toContain('<data>\n  <collection name="people" as="team" filter={{ active: true }} />\n</data>');
  });

  it('follows a changed alias only where the page used the collection’s own', () => {
    expect(declared(changeDataDeclarations(PAGE, { kind: 'alias', name: 'tasks', from: 'tasks', to: 'items' }))).toEqual([['tasks', 'items'], ['people', 'team']]);
    // The page reads `people` as `team`, which is its own choice.
    expect(changeDataDeclarations(PAGE, { kind: 'alias', name: 'people', from: 'people', to: 'staff' })).toBe(PAGE);
  });

  it('leaves a page that does not declare the collection alone', () => {
    expect(changeDataDeclarations(PAGE, { kind: 'rename', from: 'orders', to: 'sales' })).toBe(PAGE);
    expect(changeDataDeclarations(PAGE, { kind: 'remove', name: 'orders' })).toBe(PAGE);
  });
});

describe('a collection changed in Data', () => {
  const UI_ID = 'main_ui';
  const source = () => useFilesStore.getState().uiFiles.get(UI_ID)!.originalSource!;

  beforeEach(() => {
    useProjectStore.getState().reset();
    useFilesStore.getState().reset();
    useSchemaStore.getState().reset();
    useFilesStore.getState().updateUIFileSource(UI_ID, PAGE);
    useFilesStore.getState().markFileDirty(UI_ID, false);
    useSchemaStore.getState().loadEntities([
      { id: 'e1', name: 'tasks', alias: 'tasks', fields: [{ id: 'f1', name: 'id', type: 'string', required: true }], position: { x: 0, y: 0 } },
      { id: 'e2', name: 'people', alias: 'people', fields: [{ id: 'f2', name: 'id', type: 'string', required: true }], position: { x: 0, y: 0 } },
    ]);
  });

  it('opened and left alone, changes no page', () => {
    expect(source()).toBe(PAGE);
    expect(useFilesStore.getState().nodes.get(UI_ID)?.isDirty).toBe(false);
  });

  it('renamed, is declared under its new name in the page that reads it', () => {
    expect(useSchemaStore.getState().updateEntity('e1', { name: 'todos' })).toBeNull();
    expect(declared(source())).toEqual([['todos', 'tasks'], ['people', 'team']]);
    expect(useFilesStore.getState().nodes.get(UI_ID)?.isDirty).toBe(true);
    // The page is still the page: its tree was not rebuilt.
    expect(useFilesStore.getState().uiFiles.get(UI_ID)!.visualEditBlocked).toBeUndefined();
  });

  it('added, is declared on the entry page under the name it is given', () => {
    const id = useSchemaStore.getState().addEntity({ x: 0, y: 0 });
    const entity = useSchemaStore.getState().entities.find((e) => e.id === id)!;
    expect(declared(source())).toContainEqual([entity.name, entity.alias]);
    useSchemaStore.getState().updateEntity(id, { name: 'projects', alias: 'projects' });
    expect(declared(source())).toEqual([['tasks', 'tasks'], ['people', 'team'], ['projects', 'projects']]);
  });

  it('deleted, is no longer declared', () => {
    useSchemaStore.getState().deleteEntity('e1');
    expect(declared(source())).toEqual([['people', 'team']]);
  });
});
