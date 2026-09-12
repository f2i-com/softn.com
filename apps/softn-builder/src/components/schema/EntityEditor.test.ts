// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EntityEditor } from './EntityEditor';
import { useSchemaStore } from '../../stores/schemaStore';
import { useProjectStore } from '../../stores/projectStore';
import { useWorkspaceShortcuts } from '../../hooks/useWorkspaceShortcuts';
import type { SchemaField } from '../../types/builder';

let host: HTMLDivElement;
let root: Root;
const save = vi.fn();
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useProjectStore.getState().reset(); useSchemaStore.getState().reset(); save.mockReset();
  useSchemaStore.getState().loadEntities([
    { id: 'tasks', name: 'tasks', alias: 'tasks', position: { x: 0, y: 0 }, fields: [
      { name: 'title', type: 'string', required: false } as SchemaField,
      { name: 'lane', type: 'select', required: false, options: ['Today', 'Later'] } as SchemaField,
    ] },
    { id: 'notes', name: 'notes', alias: 'notes', position: { x: 1, y: 0 }, fields: [
      { name: 'title', type: 'string', required: false } as SchemaField,
      { name: 'lane', type: 'select', required: false, options: ['Draft', 'Published'] } as SchemaField,
    ] },
  ]);
  useSchemaStore.getState().loadSeedData(new Map([['tasks', [{ title: 'Sample task', lane: 'Today' }]]]));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  function Harness() {
    useWorkspaceShortcuts({ blocked: false, narrow: false, save, open: vi.fn(), create: vi.fn(), export: vi.fn(), shortcuts: vi.fn(), changeView: vi.fn() });
    return React.createElement(EntityEditor);
  }
  act(() => root.render(React.createElement(Harness)));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function input(label: string) { return host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; }
function type(control: HTMLInputElement, value: string) {
  act(() => {
    control.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function key(control: HTMLInputElement, key: string, options: KeyboardEventInit = {}) {
  act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })));
}

it('edits imported fields without IDs and commits only the completed name', () => {
  const name = input('Field name: title'); expect(name.disabled).toBe(false);
  expect(input('Field name: lane').disabled).toBe(false);
  type(name, 'id'); expect(name.disabled).toBe(false);
  expect(useSchemaStore.getState().seedData.get('tasks')).toEqual([{ title: 'Sample task', lane: 'Today' }]);
  type(name, 'identifier'); key(name, 'Enter');
  expect(useSchemaStore.getState().seedData.get('tasks')).toEqual([{ identifier: 'Sample task', lane: 'Today' }]);
  expect(input('Field name: identifier').disabled).toBe(false);
});

it('explains a rejected collision, restores its original name, and can cancel a draft', () => {
  const name = input('Field name: title'); const revision = useProjectStore.getState().revision;
  type(name, 'lane'); act(() => name.blur());
  expect(host.querySelector('[role=alert]')?.textContent).toContain('already exists');
  expect(name.value).toBe('title'); expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(useSchemaStore.getState().seedData.get('tasks')).toEqual([{ title: 'Sample task', lane: 'Today' }]);
  type(name, 'new_title'); key(name, 'Escape'); act(() => name.blur());
  expect(name.value).toBe('title'); expect(host.querySelector('[role=alert]')).toBeNull();
  expect(useProjectStore.getState().revision).toBe(revision);
});

it('commits the focused rename before a keyboard save reads the data', () => {
  let saved: unknown;
  save.mockImplementation(() => { saved = useSchemaStore.getState().seedData.get('tasks'); });
  const name = input('Field name: title'); type(name, 'task'); key(name, 's', { ctrlKey: true });
  expect(save).toHaveBeenCalledOnce(); expect(saved).toEqual([{ task: 'Sample task', lane: 'Today' }]);
});

it('rejects duplicate collection names and resets field option drafts when switching collections', () => {
  const name = input('Collection name'); type(name, 'notes'); key(name, 'Enter');
  expect(name.value).toBe('tasks'); expect(host.querySelector('[role=alert]')?.textContent).toContain('already exists');
  expect(host.querySelector<HTMLInputElement>('input[placeholder="Options (comma-separated)"]')?.value).toBe('Today, Later');
  act(() => useSchemaStore.getState().selectEntity('notes'));
  expect(input('Collection name').value).toBe('notes');
  expect(host.querySelector<HTMLInputElement>('input[placeholder="Options (comma-separated)"]')?.value).toBe('Draft, Published');
  expect(host.querySelector('[role=alert]')).toBeNull();
});
