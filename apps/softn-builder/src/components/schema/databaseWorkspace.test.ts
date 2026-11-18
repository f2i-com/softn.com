// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HostedTableDesign } from '@softn/editor-shared/hostedDatabase';
import HostedTables from './HostedTables';
import DatabaseWorkspace from './DatabaseWorkspace';
import { DataEntryPanel } from './DataEntryPanel';
import { startNewProject } from '../../utils/newProject';
import { useSchemaStore } from '../../stores/schemaStore';
import { buildProjectBundle } from '../../utils/buildProjectBundle';
import { commitProjectSnapshot, prepareProjectSnapshot } from '../../utils/openProject';
import { loadBundle } from '../../utils/bundleLoader';
import { readBuilderBackendFiles } from '../../utils/backendFiles';

vi.mock('./SchemaDesigner', () => ({ SchemaDesigner: () => createElement('div', null, 'Local collections diagram') }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function type(control: HTMLInputElement, value: string) {
  act(() => {
    control.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function start() {
  startNewProject({ name: 'Notebook', description: '', theme: 'dark', template: 'blank', format: 'web', language: 'javascript', pythonPackages: [] });
  const host = document.createElement('div');
  document.body.append(host);
  return { host, root: createRoot(host) };
}

it('adds a private table from the designer, reopens its SQL and appends the next table', async () => {
  const { host, root } = start();
  const render = () => act(() => root.render(createElement(HostedTables, { saveLabel: 'Save' })));
  const submit = (design: HostedTableDesign) => {
    type(host.querySelector('input[placeholder="tasks"]')!, design.name);
    type(host.querySelector('input[aria-label="Column 1 name"]')!, design.columns[0].name);
    act(() => host.querySelector<HTMLFormElement>('form')!.requestSubmit());
  };
  try {
    render();
    submit({ name: 'notes', columns: [{ name: 'title', type: 'TEXT' }] });
    expect(host.querySelector('[role=status]')?.textContent).toContain('001.sql');
    const bytes = await buildProjectBundle();
    const loaded = await loadBundle(bytes);
    act(() => commitProjectSnapshot(prepareProjectSnapshot(loaded)));
    const original = readBuilderBackendFiles()['server/migrations/001.sql'];
    expect(original).toContain('CREATE TABLE "notes"');
    submit({ name: 'events', columns: [{ name: 'subject', type: 'TEXT' }] });
    expect(host.querySelector('[role=status]')?.textContent).toContain('002.sql');
    const reopened = await loadBundle(await buildProjectBundle());
    expect(reopened.rawManifest.server).toMatchObject({ database: { migrations: ['server/migrations/001.sql', 'server/migrations/002.sql'] } });
    expect(new TextDecoder().decode(reopened.extraEntries.get('server/migrations/001.sql'))).toBe(original);
    expect(new TextDecoder().decode(reopened.extraEntries.get('server/migrations/002.sql'))).toContain('"subject" TEXT');
  } finally { act(() => root.unmount()); host.remove(); }
});

it('keeps the table draft when inspecting local collections and focuses the next editable column', async () => {
  const { host, root } = start();
  const name = () => host.querySelector<HTMLInputElement>('input[placeholder=tasks]')!;
  const column = (index: number) => host.querySelector<HTMLInputElement>(`[aria-label="Column ${index} name"]`)!;
  const click = async (selector: string) => act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); });
  try {
    await act(async () => root.render(createElement(DatabaseWorkspace, { hosted: true, saveLabel: 'Save', onSave: () => {} })));
    type(name(), 'tasks'); type(column(1), 'title');
    await click('.bl-db-subhead button');
    expect(document.activeElement).toBe(column(2));
    type(column(2), 'details');
    await click('[aria-label="Database location"] button:first-child');
    expect(host.querySelector('.bl-db-pane')?.hasAttribute('hidden')).toBe(true);
    await click('[aria-label="Database location"] button:last-child');
    expect(name().value).toBe('tasks');
    expect(column(2).value).toBe('details');
    await click('[aria-label="Remove column 1"]');
    expect(document.activeElement).toBe(column(1));
    expect(column(1).value).toBe('details');
    await click('[aria-label="Remove column 1"]');
    expect(document.activeElement).toBe(host.querySelector('.bl-db-subhead button'));
    await click('button[type=submit]');
    expect(document.activeElement).toBe(name());
    expect(host.querySelector('[role=status]')?.textContent).toContain('001.sql');
    type(name(), 'unsaved');
    act(() => { startNewProject({ name: 'Other project', description: '', theme: 'light', template: 'blank', format: 'web', language: 'javascript', pythonPackages: [] }); });
    expect(name().value).toBe('');
  } finally { act(() => root.unmount()); host.remove(); }
});

it('keeps the record editor on the diagram selection and edits the underlying filtered row', () => {
  const { host, root } = start();
  const store = useSchemaStore.getState();
  const first = store.addEntity({ x: 0, y: 0 });
  const second = store.addEntity({ x: 30, y: 30 });
  store.updateEntity(second, { name: 'notes' });
  store.setSeedData(second, [{ id: 'first' }, { id: 'second' }]);
  try {
    act(() => root.render(createElement(DataEntryPanel)));
    expect(host.querySelector('table')?.getAttribute('aria-label')).toBe('notes sample records');
    type(host.querySelector('input[type=search]')!, 'second');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    type(host.querySelector('tbody input')!, 'edited');
    expect(useSchemaStore.getState().seedData.get(second)).toEqual([{ id: 'first' }, { id: 'edited' }]);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    act(() => useSchemaStore.getState().selectEntity(first));
    expect(host.querySelector('input[type=search]')).toBeNull();
    act(() => useSchemaStore.getState().selectEntity(second));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
  } finally { act(() => root.unmount()); host.remove(); }
});
