// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelationshipDialog, type RelationshipDialogProps } from './RelationshipDialog';
import type { EntityDef, RelationshipDraft } from '../../types/builder';

const entities: EntityDef[] = [
  { id: 'orders', name: 'orders', alias: 'order', position: { x: 0, y: 0 }, fields: [
    { id: 'record-id', name: 'id', type: 'string', required: true },
    { id: 'customer-name', name: 'customerName', type: 'string', required: false },
    { id: 'customer-id', name: 'customerId', type: 'reference', refEntity: 'customers', required: false },
    { id: 'supplier-id', name: 'supplierId', type: 'reference', refEntity: 'suppliers', required: false },
    { id: 'total', name: 'total', type: 'number', required: false },
  ] },
  { id: 'customers', name: 'customers', alias: 'customer', position: { x: 200, y: 0 }, fields: [
    { id: 'manager-id', name: 'managerId', type: 'reference', refEntity: 'customers', required: false },
  ] },
  { id: 'suppliers', name: 'suppliers', alias: 'supplier', position: { x: 400, y: 0 }, fields: [] },
];
const initial: RelationshipDraft = { sourceEntityId: 'orders', targetEntityId: 'customers', sourceFieldId: '', type: 'many-to-one' };
let root: Root;
let host: HTMLDivElement;
const onSave = vi.fn<(draft: RelationshipDraft) => string | null>();
const onClose = vi.fn();
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  onSave.mockReset().mockReturnValue(null);
  onClose.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function mount(props: Partial<RelationshipDialogProps> = {}) {
  act(() => root.render(React.createElement(RelationshipDialog, { entities, initial, editing: false, onSave, onClose, ...props })));
}
function field(label: string) {
  const node = [...host.querySelectorAll<HTMLLabelElement>('label')].find((item) => item.textContent?.startsWith(label));
  expect(node, `Label ${label}`).toBeTruthy();
  expect(node!.control).toBeTruthy();
  return node!.control as HTMLInputElement | HTMLSelectElement;
}
function change(label: string, value: string) {
  const input = field(label);
  act(() => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
function choose(type: RelationshipDraft['type']) {
  act(() => host.querySelector<HTMLInputElement>(`input[type="radio"][value="${type}"]`)!.click());
}
function submit() {
  act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
function key(target: Element, name: string, extra: KeyboardEventInit = {}) {
  act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra })));
}

describe('relationship editing', () => {
  it('opens a labeled modal with the source focused and all four explained cardinalities', () => {
    mount();
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Add relationship');
    expect(document.activeElement).toBe(field('Source collection'));
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(4);
    expect(host.textContent).toContain('Many orders belong to one customer.');
    expect(host.textContent).toContain('orders stores the target record ID from customers');
    expect(host.textContent).toContain('Cardinality describes your model; app logic controls validation.');
    expect(field('Reference field').value).toBe('');
  });

  it.each(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'] as const)('saves a diagram-only %s relationship', (type) => {
    mount(); choose(type); submit();
    expect(onSave).toHaveBeenCalledWith({ ...initial, type, sourceFieldId: '' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers only non-ID text/reference fields that can point at the selected target', () => {
    mount();
    const options = [...(field('Reference field') as HTMLSelectElement).options].map((option) => option.value);
    expect(options).toEqual(['', 'field:customer-name', 'field:customer-id', 'new']);
    change('Reference field', 'field:customer-id'); submit();
    expect(onSave).toHaveBeenCalledWith({ ...initial, sourceFieldId: 'customer-id' });
  });

  it('preserves the new-field draft after a save error and retries with the trimmed name', () => {
    onSave.mockReturnValueOnce('A field with this name already exists.');
    mount(); change('Reference field', 'new'); change('New reference field name', '  ownerId  '); submit();
    expect(onSave).toHaveBeenLastCalledWith({ ...initial, sourceFieldId: '', newFieldName: 'ownerId' });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('A field with this name already exists.');
    expect(field('New reference field name').value).toBe('  ownerId  ');
    expect(field('Reference field').value).toBe('new');
    expect(onClose).not.toHaveBeenCalled();
    change('New reference field name', 'customerRef');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    submit(); expect(onClose).toHaveBeenCalledOnce();
  });

  it('requires both endpoints and a nonempty new-field name without dropping the form', () => {
    mount({ initial: { ...initial, targetEntityId: '' } }); submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('source and target');
    change('Target collection', 'customers'); change('Reference field', 'new'); change('New reference field name', '  '); submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('name for the new reference field');
    expect(onSave).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  it('focuses and reveals each failed save without discarding the draft', () => {
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
    try {
      onSave.mockReturnValue('This field already has a relationship.');
      mount(); change('Reference field', 'field:customer-id');
      submit();
      const alert = host.querySelector<HTMLElement>('[role="alert"]')!;
      expect(document.activeElement).toBe(alert);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
      expect(field('Reference field').value).toBe('field:customer-id');
      const saveButton = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      act(() => saveButton.focus());
      submit();
      expect(document.activeElement).toBe(alert);
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('clears a conflicting reference on endpoint changes and keeps a plain string choice valid', () => {
    mount({ initial: { ...initial, sourceFieldId: 'customer-id' } });
    expect(field('Reference field').value).toBe('field:customer-id');
    change('Target collection', 'suppliers'); expect(field('Reference field').value).toBe('');
    change('Reference field', 'field:customer-name');
    change('Target collection', 'customers'); expect(field('Reference field').value).toBe('field:customer-name');
    change('Source collection', 'customers'); expect(field('Reference field').value).toBe('');
    submit(); expect(onSave).toHaveBeenCalledWith({ ...initial, sourceEntityId: 'customers', sourceFieldId: '' });
  });

  it('drops stored-reference selection when switching to many targets, without changing fields or records', () => {
    const before = structuredClone(entities);
    mount({ initial: { ...initial, sourceFieldId: 'customer-id' } });
    choose('one-to-many');
    expect([...host.querySelectorAll('select')]).toHaveLength(2);
    expect(host.textContent).toContain('reverse the collections');
    choose('many-to-one'); expect(field('Reference field').value).toBe('');
    submit(); expect(onSave).toHaveBeenCalledWith(initial); expect(entities).toEqual(before);
  });

  it('keeps typed new-field text available when returning to that option but never submits it for a diagram', () => {
    mount(); change('Reference field', 'new'); change('New reference field name', 'ownerId');
    choose('many-to-many'); submit();
    expect(onSave).toHaveBeenCalledWith({ ...initial, type: 'many-to-many' });
    choose('many-to-one'); change('Reference field', 'new');
    expect(field('New reference field name').value).toBe('ownerId');
  });

  it('can edit a legacy one-to-many diagram and create a self-reference', () => {
    mount({ editing: true, initial: { ...initial, type: 'one-to-many', sourceFieldId: 'customer-id' } });
    expect(host.querySelector('h2')?.textContent).toBe('Edit relationship');
    submit(); expect(onSave).toHaveBeenLastCalledWith({ ...initial, type: 'one-to-many', sourceFieldId: '' });
    choose('many-to-one'); change('Source collection', 'customers'); change('Reference field', 'field:manager-id'); submit();
    expect(onSave).toHaveBeenLastCalledWith({ ...initial, sourceEntityId: 'customers', sourceFieldId: 'manager-id' });
  });

  it('does not submit a reference field removed from the entities prop while editing', () => {
    const props = { editing: true, initial: { ...initial, sourceFieldId: 'customer-id' } };
    mount(props);
    mount({ ...props, entities: entities.map((entity) => ({ ...entity, fields: entity.fields.filter((item) => item.id !== 'customer-id') })) });
    expect(field('Reference field').value).toBe(''); submit(); expect(onSave).toHaveBeenCalledWith(initial);
  });
});

describe('relationship keyboard controls', () => {
  it('submits a new-field name with Enter while keeping IME composition out of submission', () => {
    mount(); change('Reference field', 'new'); change('New reference field name', 'ownerId');
    const input = field('New reference field name');
    key(input, 'Enter', { isComposing: true }); key(input, 'Enter', { keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
    key(input, 'Enter'); expect(onSave).toHaveBeenCalledOnce();
  });

  it('traps focus and restores the opener after Escape', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return React.createElement(React.Fragment, null,
        React.createElement('button', { onClick: () => setOpen(true) }, 'Open relationship'),
        open && React.createElement(RelationshipDialog, { entities, initial, editing: false, onSave, onClose: () => setOpen(false) }));
    }
    act(() => root.render(React.createElement(Harness)));
    const opener = host.querySelector('button')!; opener.focus(); act(() => opener.click());
    const controls = [...host.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] input, [role="dialog"] select')];
    controls.at(-1)!.focus(); key(controls.at(-1)!, 'Tab'); expect(document.activeElement).toBe(controls[0]);
    key(controls[0], 'Tab', { shiftKey: true }); expect(document.activeElement).toBe(controls.at(-1));
    key(controls.at(-1)!, 'Escape'); expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Cancel closes without attempting to save', () => {
    mount(); const cancel = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!;
    act(() => cancel.click()); expect(onClose).toHaveBeenCalledOnce(); expect(onSave).not.toHaveBeenCalled();
  });

  it('restores a focused SVG diagram edge after closing the relationship dialog', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return React.createElement(React.Fragment, null,
        React.createElement('svg', null, React.createElement('g', { tabIndex: 0, role: 'button', 'aria-label': 'Edit diagram edge', onClick: () => setOpen(true) })),
        open && React.createElement(RelationshipDialog, { entities, initial, editing: true, onSave, onClose: () => setOpen(false) }));
    }
    act(() => root.render(React.createElement(Harness)));
    const edge = host.querySelector<SVGElement>('g')!;
    edge.focus();
    expect(document.activeElement).toBe(edge);
    act(() => edge.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.activeElement).toBe(field('Source collection'));
    key(document.activeElement!, 'Escape');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(edge);
    expect(onSave).not.toHaveBeenCalled();
  });
});
