// @vitest-environment jsdom
/**
 * A collection is called in Data what the app that runs can call it.
 *
 * A new collection is `Entity1`, and pages read it as `entity1`. Naming it
 * `tasks` changed the first and left the second, which is the one a page
 * writes: `#each (task in tasks)` drew nothing, the collection still being
 * `entity1` there, and nothing on the Design side said what it was called.
 *
 * And the name was taken as typed. The engine reads a collection's name as
 * letters, digits, `_` and `-` after a letter, and its alias as a name code
 * can use; `Task items` or an alias of `my-tasks` was written into every
 * page's `<data>` block, where it is a parse error: the app that was
 * exported did not start, and reopened, its pages could be edited only as
 * source. `../up` went into the bundle's own file list and the export threw.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from '@softn/core';
import { useSchemaStore } from './schemaStore';
import { useProjectStore } from './projectStore';
import { useFilesStore } from './filesStore';
import { useCanvasStore } from './canvasStore';
import { buildProjectBundle, flushCanvasToActiveFile } from '../utils/buildProjectBundle';
import { loadBundle } from '../utils/bundleLoader';
import { DataPanel } from '../components/panels/DataPanel';

const schema = () => useSchemaStore.getState();
const only = () => schema().entities[0];

/** The entry page as the export writes it now. */
async function page(): Promise<string> {
  const exported = await loadBundle(await buildProjectBundle());
  const source = [...exported.uiFiles.values()][0].originalSource ?? '';
  // Whatever the Data view was told, the page still reads.
  expect(() => parse(source), source).not.toThrow();
  expect((parse(source).diagnostics ?? []).filter((d) => d.severity === 'error'), source).toEqual([]);
  return source;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useSchemaStore.getState().reset();
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  // A page with something on it, so it has a source to declare collections in.
  useCanvasStore.getState().addElement('Text', useCanvasStore.getState().rootId, undefined, { starter: true });
  flushCanvasToActiveFile();
});

describe('a collection named for the first time', () => {
  it('is called that in pages too', async () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    expect(only().alias).toBe('entity1');
    expect(schema().updateEntity(id, { name: 'tasks' })).toBeNull();
    expect(only()).toMatchObject({ name: 'tasks', alias: 'tasks' });
    expect(await page()).toContain('<collection name="tasks" as="tasks" />');
  });

  it('is given a name code can use where its own has a hyphen', async () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    expect(schema().updateEntity(id, { name: 'Task-items' })).toBeNull();
    expect(only().alias).toBe('taskItems');
    expect(await page()).toContain('<collection name="Task-items" as="taskItems" />');
  });

  it('keeps an alias that was chosen before it', () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    schema().updateEntity(id, { alias: 'jobs' });
    schema().updateEntity(id, { name: 'tasks' });
    expect(only()).toMatchObject({ name: 'tasks', alias: 'jobs' });
  });

  it('does not take the alias another collection has', () => {
    const first = schema().addEntity({ x: 0, y: 0 });
    schema().updateEntity(first, { name: 'archive', alias: 'tasks' });
    const second = schema().addEntity({ x: 0, y: 0 });
    expect(schema().updateEntity(second, { name: 'tasks' })).toBeNull();
    expect(schema().entities.map((entity) => entity.alias)).toEqual(['tasks', 'entity2']);
  });
});

describe('a collection that came with an app', () => {
  it('keeps the name its pages use, even one that looks like a new collection’s', () => {
    // An app saved before its collection was named: its pages say
    // `#each (row in entity1)`, and naming the collection now must not
    // change what they have to say.
    schema().loadEntities([{ id: 'opened', name: 'Entity1', alias: 'entity1', fields: [], position: { x: 0, y: 0 } }]);
    expect(schema().updateEntity('opened', { name: 'tasks' })).toBeNull();
    expect(only()).toMatchObject({ name: 'tasks', alias: 'entity1' });
  });
});

describe('a collection renamed later', () => {
  it('keeps the name pages already use for it', async () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    schema().updateEntity(id, { name: 'tasks' });
    schema().updateEntity(id, { name: 'todos' });
    // `#each (task in tasks)` in a page goes on working.
    expect(only()).toMatchObject({ name: 'todos', alias: 'tasks' });
    expect(await page()).toContain('<collection name="todos" as="tasks" />');
  });
});

describe('a name the engine would not read', () => {
  it.each(['Task items', 'my "tasks"', 'a/b', '../up', '1st', 'a<b>&c'])('%s is refused where it is typed', async (name) => {
    const id = schema().addEntity({ x: 0, y: 0 });
    const refusal = schema().updateEntity(id, { name });
    expect(refusal).toContain('letter');
    expect(only().name).toBe('Entity1');
    await page();
    // And the app still exports and opens.
    const reopened = await loadBundle(await buildProjectBundle());
    expect(reopened.entities.map((entity) => entity.name)).toEqual(['Entity1']);
  });

  it.each(['my-tasks', '1st', 'two words', 'a.b'])('the alias %s is refused: a page could not write it', async (alias) => {
    const id = schema().addEntity({ x: 0, y: 0 });
    schema().updateEntity(id, { name: 'tasks' });
    expect(schema().updateEntity(id, { alias })).toContain('code');
    expect(only().alias).toBe('tasks');
    await page();
  });

  it('says what would be taken', () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    expect(schema().updateEntity(id, { name: 'Task items' })).toContain('Task-items');
  });
});

describe('the Data panel beside the canvas', () => {
  it('says what a page calls each collection', () => {
    const id = schema().addEntity({ x: 0, y: 0 });
    schema().updateEntity(id, { name: 'todos', alias: 'tasks' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(React.createElement(DataPanel)));
    const row = host.querySelector('[data-collection="todos"]')!;
    expect(row.textContent).toContain('todos');
    expect(row.querySelector('[data-collection-alias]')?.textContent).toBe('tasks');
    act(() => root.unmount());
    host.remove();
  });
});
