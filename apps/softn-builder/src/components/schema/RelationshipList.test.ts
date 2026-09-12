// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RelationshipList } from './RelationshipList';
import type { EntityDef, RelationshipDef } from '../../types/builder';

let root: Root;
let host: HTMLDivElement;
const onSelect = vi.fn(); const onEdit = vi.fn(); const onRemove = vi.fn(); const onAdd = vi.fn();
const entities: EntityDef[] = [
  { id: 'appointments', name: 'appointments', alias: 'appointments', position: { x: 0, y: 0 }, fields: [{ id: 'client', name: 'client_id', type: 'reference', required: false, refEntity: 'clients' }] },
  { id: 'clients', name: 'clients', alias: 'clients', position: { x: 300, y: 0 }, fields: [] },
];
const links: RelationshipDef[] = [
  { id: 'reference', sourceEntityId: 'appointments', sourceFieldId: 'client', targetEntityId: 'clients', type: 'many-to-one' },
  { id: 'diagram', sourceEntityId: 'clients', sourceFieldId: '', targetEntityId: 'appointments', type: 'one-to-many' },
];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render(relationships = links, selectedId: string | null = null, available = entities) {
  act(() => root.render(React.createElement(RelationshipList, { relationships, entities: available, selectedId, onSelect, onEdit, onRemove, onAdd })));
}
function button(label: string) { return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!; }

it('names source fields, direction and cardinality, distinguishing real references from diagram links', () => {
  render();
  expect(host.textContent).toContain('appointments.client_id → clients');
  expect(host.textContent).toContain('N:1 · Reference field');
  expect(host.textContent).toContain('1:N · Diagram only');
  expect(host.querySelector('ul')?.getAttribute('aria-label')).toBe('Relationships');
});

it('provides separate accessible select, edit and remove actions with stable relationship IDs', () => {
  render(links, 'reference');
  const select = button('Select relationship appointments.client_id → clients');
  expect(select.getAttribute('aria-pressed')).toBe('true');
  act(() => select.click()); expect(onSelect).toHaveBeenCalledWith('reference'); expect(onEdit).not.toHaveBeenCalled();
  act(() => button('Edit relationship appointments.client_id → clients').click()); expect(onEdit).toHaveBeenCalledWith('reference'); expect(onRemove).not.toHaveBeenCalled();
  act(() => button('Remove relationship appointments.client_id → clients').click()); expect(onRemove).toHaveBeenCalledWith('reference');
  expect(host.textContent).toContain('keeps its field and existing values');
});

it('offers a keyboard-reachable create route for empty schemas with collections', () => {
  render([]); expect(host.textContent).toContain('No relationships yet');
  const add = host.querySelector('button')!; expect(add.disabled).toBe(false);
  add.focus(); expect(document.activeElement).toBe(add); act(() => add.click()); expect(onAdd).toHaveBeenCalledOnce();
  render([], null, []); expect(host.querySelector('button')?.disabled).toBe(true);
});
