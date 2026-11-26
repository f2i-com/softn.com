/** @vitest-environment jsdom */
/**
 * Editing a record of a local collection in the Data tab.
 *
 * The edit form remembered the row by its place in the list, and a save wrote the draft into
 * whatever record was at that place in the file as it was then. With the file changed while
 * the form was open (another tab's save taken in, or an undo), the draft went over another
 * record, which lost its own values and took the edited record's id.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { StudioDataWorkspace } from '../src/components/canvas/StudioDataWorkspace';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

const collection = (records: Array<{ id: string; title: string }>) =>
  `${JSON.stringify({ collection: 'notes', schema: { fields: [{ name: 'title', type: 'string' }] }, records }, null, 2)}\n`;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useAIStore.getState().setAgentState('idle');
  useWorkspaceStore.getState().reset();
  useWorkspaceStore.setState({ projectId: 'p1' });
  useVFSStore.getState().reset();
  useVFSStore.getState().hydrateFiles([
    { path: 'manifest.json', content: JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui' }) },
    { path: 'xdb/notes.xdb', content: collection([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]) },
  ]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const records = () => (JSON.parse(String(useVFSStore.getState().readFile('xdb/notes.xdb'))) as { records: Array<{ id: string; title: string }> }).records;
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('saves nothing over a record that changed place while its row was open, and says why', () => {
  act(() => root.render(<StudioDataWorkspace />));
  const editC = [...container.querySelectorAll('tbody tr')][2].querySelector('button')!;
  act(() => editC.click());
  const title = [...container.querySelectorAll<HTMLInputElement>('form input[type="text"]')][1];
  typeInto(title, 'C, edited');
  // Another tab's save, taken in while the row is open: a record now stands before the others.
  act(() => useVFSStore.getState().takeInFiles([{ path: 'xdb/notes.xdb', content: collection([{ id: 'z', title: 'Z' }, { id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]) }]));
  act(() => button('Save changes').click());
  expect(records()).toEqual([{ id: 'z', title: 'Z' }, { id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]);
  expect(container.textContent).toMatch(/changed while the row was open/);
});

it('saves an edit made to the file as it is', () => {
  act(() => root.render(<StudioDataWorkspace />));
  act(() => [...container.querySelectorAll('tbody tr')][1].querySelector('button')!.click());
  typeInto([...container.querySelectorAll<HTMLInputElement>('form input[type="text"]')][1], 'B, edited');
  act(() => button('Save changes').click());
  expect(records()).toEqual([{ id: 'a', title: 'A' }, { id: 'b', title: 'B, edited' }, { id: 'c', title: 'C' }]);
});

// The id proposed for a new record was the collection's name and one more than the count, which
// after a deletion is often the id of a record that is there: notes-1 and notes-3 left, notes-3.
it('proposes an id for a new record that no record has', () => {
  useVFSStore.getState().hydrateFiles([
    { path: 'manifest.json', content: JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui' }) },
    { path: 'xdb/notes.xdb', content: collection([{ id: 'notes-1', title: 'One' }, { id: 'notes-3', title: 'Three' }]) },
  ]);
  act(() => root.render(<StudioDataWorkspace />));
  act(() => button('+ Add record').click());
  expect(container.querySelector<HTMLInputElement>('form input[type="text"]')!.value).toBe('notes-4');
});
