/**
 * Faults a scan of the components found, each pinned by what a person meets:
 * a due date a day early, a form that will not send, focus lost after a
 * dialog, a row that took its buttons' keys, a colour that could not be
 * typed, a stat that would not draw, Escape in an editor closing its dialog.
 */

import React, { useState } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type, click } from './dom';
import { recordDate } from '../src/smart/record-dates';
import { SmartForm } from '../src/smart/SmartForm';
import { SmartStats } from '../src/smart/SmartStats';
import { Table } from '../src/data/Table';
import { Confirm } from '../src/feedback/Confirm';
import { Modal } from '../src/feedback/Modal';
import { ColorPicker } from '../src/form/ColorPicker';
import { CodeEditor } from '../src/editors/CodeEditor';

afterEach(() => {
  document.body.innerHTML = '';
});

const key = (target: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

describe('a record’s date with no time', () => {
  it('is the day it names, at local midnight, wherever it is read', () => {
    const day = recordDate('2024-03-15');
    expect([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()]).toEqual([2024, 2, 15, 0]);
    // A time is the time it names, as before.
    expect(recordDate('2024-03-15T10:30:00Z').toISOString()).toBe('2024-03-15T10:30:00.000Z');
  });
});

describe('SmartForm', () => {
  it('sends a form whose optional number with a minimum is left empty', () => {
    const onSubmit = vi.fn();
    const { container } = mount(
      <SmartForm fields={[{ name: 'title', type: 'text' }, { name: 'qty', type: 'number', min: 1 }]} data={{ title: 'Tea', qty: null }} onSubmit={onSubmit} />
    );
    act(() => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).not.toContain('Must be at least');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps what is typed when its data is written inline and the page redraws', () => {
    function Page() {
      const [, setSeen] = useState(0);
      return <SmartForm fields={[{ name: 'notes', type: 'text' }]} data={{ status: 'new' }} onChange={() => setSeen((n) => n + 1)} />;
    }
    const { container } = mount(<Page />);
    const field = container.querySelector('input') as HTMLInputElement;
    type(field, 'Hello');
    expect(field.value).toBe('Hello');
  });
});

describe('SmartStats', () => {
  it('draws a trend given as a number', () => {
    const { container } = mount(<SmartStats stats={[{ label: 'Revenue', value: 100, trend: 12 }, { label: 'Churn', value: 3, trend: -2 }]} />);
    expect(container.textContent).toContain('+12');
    expect(container.textContent).toContain('-2');
  });
});

describe('a table whose rows can be clicked', () => {
  it('leaves Enter and Space on a control in a row to that control', () => {
    const onRowClick = vi.fn();
    const onDelete = vi.fn();
    const { container } = mount(
      <Table
        columns={[{ key: 'name', header: 'Name' }, { key: 'id', header: '', render: () => <button onClick={onDelete}>Delete</button> }]}
        data={[{ id: '1', name: 'Tea' }]}
        onRowClick={onRowClick}
      />
    );
    const button = container.querySelector('button')!;
    expect(key(button, 'Enter').defaultPrevented).toBe(false);
    expect(key(button, ' ').defaultPrevented).toBe(false);
    expect(onRowClick).not.toHaveBeenCalled();
    // The row itself still answers them.
    const row = button.closest('tr')!;
    expect(key(row, 'Enter').defaultPrevented).toBe(true);
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});

describe('focus after a dialog', () => {
  function Opener({ dialog }: { dialog: (close: () => void) => React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button id="opener" onClick={() => setOpen(true)}>Open</button>
        {open && dialog(() => setOpen(false))}
      </>
    );
  }

  it('goes back to what opened a Confirm', () => {
    const { container } = mount(<Opener dialog={(close) => <Confirm open title="Sure?" onCancel={close} onConfirm={close} />} />);
    const opener = container.querySelector<HTMLButtonElement>('#opener')!;
    opener.focus();
    click(opener);
    expect(document.activeElement).not.toBe(opener);
    click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'));
    expect(document.activeElement).toBe(opener);
  });

  it('goes back to what opened a Modal whose field takes focus', () => {
    const { container } = mount(
      <Opener
        dialog={(close) => (
          <Modal open onClose={close} title="Edit" disableAnimation>
            <input autoFocus />
            <button onClick={close}>Done</button>
          </Modal>
        )}
      />
    );
    const opener = container.querySelector<HTMLButtonElement>('#opener')!;
    opener.focus();
    click(opener);
    expect(document.activeElement?.tagName).toBe('INPUT');
    click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done'));
    expect(document.activeElement).toBe(opener);
  });
});

describe('a bound ColorPicker', () => {
  it('takes a six-digit colour typed into it', () => {
    function Page() {
      const [colour, setColour] = useState('#000000');
      return (
        <>
          <ColorPicker value={colour} onChange={setColour} />
          <output>{colour}</output>
        </>
      );
    }
    const { container } = mount(<Page />);
    click(container.querySelector('[aria-haspopup="dialog"]'));
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Hex colour"]')!;
    for (const text of ['#', '#a', '#ab', '#abc']) type(field, text);
    // Not taken, expanded and written back at its third digit, with no room left.
    expect(field.value).toBe('#abc');
    for (const text of ['#abcd', '#abcde', '#abcdef']) type(field, text);
    expect(field.value).toBe('#ABCDEF');
    expect(container.querySelector('output')!.textContent).toBe('#ABCDEF');
  });

  it('takes a three-digit colour when the field is left', () => {
    const onChange = vi.fn();
    const { container } = mount(<ColorPicker defaultValue="#000000" onChange={onChange} />);
    click(container.querySelector('[aria-haspopup="dialog"]'));
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Hex colour"]')!;
    type(field, '#abc');
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith('#AABBCC');
  });
});

describe('Escape in a CodeEditor in a dialog', () => {
  it('is the editor’s the first time, and the dialog’s the second', () => {
    const onClose = vi.fn();
    mount(
      <Modal open onClose={onClose} title="Code" disableAnimation>
        <CodeEditor defaultValue="let a = 1" />
      </Modal>
    );
    const editor = document.querySelector('textarea')!;
    editor.focus();
    expect(key(editor, 'Escape').defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    key(editor, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
