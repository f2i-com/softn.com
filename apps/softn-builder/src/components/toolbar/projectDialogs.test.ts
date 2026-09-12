// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewProjectDialog } from './NewProjectDialog';
import { ShortcutsDialog } from './ShortcutsDialog';

let root: Root;
let host: HTMLDivElement;
const create = vi.fn();
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; create.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function mount(shortcuts = false) {
  function Harness() {
    const [open, setOpen] = useState(false);
    return React.createElement(React.Fragment, null,
      React.createElement('button', { onClick: () => setOpen(true) }, 'Open dialog'),
      shortcuts ? React.createElement(ShortcutsDialog, { isOpen: open, onClose: () => setOpen(false) })
        : React.createElement(NewProjectDialog, { isOpen: open, onClose: () => setOpen(false), onCreate: create }));
  }
  act(() => root.render(React.createElement(Harness)));
  const opener = host.querySelector('button')!; opener.focus(); act(() => opener.click()); return opener;
}
function key(name: string, shiftKey = false) {
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })));
}

it('labels the new app form, selects its name, and exposes template selection', () => {
  mount(); const dialog = host.querySelector('[role=dialog]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Create New App');
  const input = dialog.querySelector('input')!;
  expect(document.activeElement).toBe(input); expect(input.selectionEnd).toBe(input.value.length);
  for (const label of dialog.querySelectorAll('label')) expect(label.control).not.toBeNull();
  const choices = [...dialog.querySelectorAll<HTMLButtonElement>('[aria-pressed]')];
  act(() => choices[1].click());
  expect(choices[1].getAttribute('aria-pressed')).toBe('true');
  act(() => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Untitled App', template: 'landing' }));
});

it.each([false, true])('traps Tab and restores the opener after Escape (shortcuts: %s)', (shortcuts) => {
  const opener = mount(shortcuts); const dialog = host.querySelector('[role=dialog]')!;
  const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, textarea, select')];
  controls.at(-1)!.focus(); key('Tab'); expect(document.activeElement).toBe(controls[0]);
  key('Tab', true); expect(document.activeElement).toBe(controls.at(-1));
  key('Escape'); expect(host.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement).toBe(opener);
});
