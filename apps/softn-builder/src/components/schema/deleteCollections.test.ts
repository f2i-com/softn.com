// @vitest-environment jsdom
/**
 * Delete or Backspace on a collection's card asks before it deletes, as the
 * "Delete collection" button does: the collection's records go with it, and
 * nothing in the Data view brings them back. It deleted them at once.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowSchemaDelete } from './deleteCollections';
import { SchemaDesigner } from './SchemaDesigner';
import { answerConfirm, currentConfirm, useConfirmStore } from '../../utils/confirm';
import { useSchemaStore } from '../../stores/schemaStore';
import { useProjectStore } from '../../stores/projectStore';

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  useConfirmStore.setState({ queue: [] });
});

describe('what Delete may take from the diagram', () => {
  const nameOf = (id: string) => ({ a: 'tasks', b: 'people' })[id] ?? id;

  it('takes relationships alone without asking', async () => {
    await expect(allowSchemaDelete({ nodes: [], edges: [{ id: 'r' }] }, true, nameOf)).resolves.toBe(true);
    expect(currentConfirm()).toBeNull();
  });

  it('takes nothing while the key is not the diagram’s', async () => {
    await expect(allowSchemaDelete({ nodes: [{ id: 'a' }], edges: [] }, false, nameOf)).resolves.toBe(false);
    expect(currentConfirm()).toBeNull();
  });

  it('asks once about every collection picked, and takes none of them on a no', async () => {
    const asked = allowSchemaDelete({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'r' }] }, true, nameOf);
    const question = currentConfirm()!;
    expect(question.title).toBe('Delete collections');
    expect(question.message).toBe('Delete the 2 collections "tasks", "people" and their records?');
    expect(question.danger).toBe(true);
    expect(useConfirmStore.getState().queue).toHaveLength(1);
    answerConfirm(question.id, false);
    await expect(asked).resolves.toBe(false);
  });

  it('asks about one collection as the button does, and takes it on a yes', async () => {
    const asked = allowSchemaDelete({ nodes: [{ id: 'a' }], edges: [] }, true, nameOf);
    const question = currentConfirm()!;
    expect(question).toMatchObject({ title: 'Delete collection', message: 'Delete the collection "tasks" and its records?', confirmLabel: 'Delete' });
    answerConfirm(question.id, true);
    await expect(asked).resolves.toBe(true);
  });
});

describe('the diagram', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // What React Flow measures with, which jsdom does not have.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    globalThis.DOMMatrixReadOnly ??= class {
      m22 = 1;
    } as unknown as typeof DOMMatrixReadOnly;
    useProjectStore.getState().reset();
    useSchemaStore.getState().reset();
    useSchemaStore.getState().loadEntities([
      { id: 'tasks', name: 'tasks', alias: 'tasks', position: { x: 0, y: 0 }, fields: [{ id: 'k', name: 'id', type: 'string', required: true }] },
    ]);
    useSchemaStore.getState().loadSeedData(new Map([['tasks', [{ id: 't-1' }, { id: 't-2' }]]]));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(SchemaDesigner)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function pressDeleteOnTheCard(key: 'Delete' | 'Backspace') {
    const card = host.querySelector<HTMLElement>('.react-flow__node[data-id="tasks"]');
    expect(card, 'the collection is drawn').not.toBeNull();
    act(() => card!.focus());
    expect(document.activeElement).toBe(card);
    act(() => void card!.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true })));
    act(() => void card!.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true })));
    await settle();
  }

  it('asks before Delete takes a collection, and keeps it and its records on a no', async () => {
    await pressDeleteOnTheCard('Delete');
    const question = currentConfirm();
    expect(question?.message).toBe('Delete the collection "tasks" and its records?');
    expect(useSchemaStore.getState().entities.map((entity) => entity.id)).toEqual(['tasks']);
    act(() => answerConfirm(question!.id, false));
    await settle();
    expect(useSchemaStore.getState().entities.map((entity) => entity.id)).toEqual(['tasks']);
    expect(useSchemaStore.getState().seedData.get('tasks')).toHaveLength(2);
  });

  it('takes the collection and its records when Backspace is answered yes', async () => {
    await pressDeleteOnTheCard('Backspace');
    const question = currentConfirm();
    expect(question).not.toBeNull();
    act(() => answerConfirm(question!.id, true));
    await settle();
    expect(useSchemaStore.getState().entities).toEqual([]);
    expect(useSchemaStore.getState().seedData.has('tasks')).toBe(false);
  });
});
