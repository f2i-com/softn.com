// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewProjectDialog } from './NewProjectDialog';
import { ShortcutsDialog } from './ShortcutsDialog';
import * as webStarters from '@softn/editor-shared/webStarters';
import * as hostedEditor from '@softn/editor-shared/hostedEditor';

let root: Root;
let host: HTMLDivElement;
const create = vi.fn();
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; create.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

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

function chooseType(dialog: Element, type: 'web' | 'ui' | 'starter') {
  act(() => dialog.querySelector<HTMLInputElement>(`input[type=radio][value=${type}]`)!.click());
}

it('focuses the project type, defaults to a working starter and exposes the layout choices', () => {
  mount(); const dialog = host.querySelector('[role=dialog]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Create a new app');
  expect(document.activeElement).toBe(dialog.querySelector('input[value=starter]'));
  expect(dialog.querySelector('button[aria-label="Vanilla JS"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(dialog.querySelector<HTMLInputElement>('input:not([type])')?.value).toBe('Trail log');
  expect(dialog.querySelector('[value=python]')).toBeNull();
  chooseType(dialog, 'web');
  for (const label of dialog.querySelectorAll('label')) expect(label.control).not.toBeNull();
  const landing = [...dialog.querySelectorAll<HTMLButtonElement>('[aria-pressed]')].find(button => button.textContent === 'Landing page')!;
  act(() => landing.click());
  expect(landing.getAttribute('aria-pressed')).toBe('true');
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

function chooseReactStarter() {
  const dialog = host.querySelector('[role=dialog]')!;
  act(() => dialog.querySelector<HTMLButtonElement>('button[aria-label="React"]')!.click());
  expect(dialog.querySelector<HTMLInputElement>('input:not([type])')!.value).toBe('Practice set');
  return dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

it('cancels a starter that is still loading and returns keyboard focus to New', async () => {
  const opener = mount();
  let finish!: (files: webStarters.StarterFile[]) => void;
  vi.spyOn(webStarters, 'createWebStarter').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const submit = chooseReactStarter();
  act(() => submit.click());
  expect(submit.disabled).toBe(true);
  expect(document.activeElement?.textContent).toBe('Cancel');
  expect(host.querySelector('[role=status]')?.textContent).toContain('Loading React starter');
  key('Escape');
  expect(document.activeElement).toBe(opener);
  await act(async () => { finish([]); });
  expect(create).not.toHaveBeenCalled();
  expect(host.querySelector('[role=dialog]')).toBeNull();
});

it('keeps the current project and the chosen settings when a starter fails', async () => {
  mount();
  const files = [{ path: 'app.js', content: '// test' }];
  vi.spyOn(webStarters, 'createWebStarter').mockRejectedValueOnce(new Error('Download failed')).mockResolvedValueOnce(files);
  const submit = chooseReactStarter();
  await act(async () => { submit.click(); });
  expect(create).not.toHaveBeenCalled();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Download failed');
  expect(document.activeElement).toBe(host.querySelector('[role=alert]'));
  expect(submit.disabled).toBe(false);
  await act(async () => { submit.click(); });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Practice set', format: 'web', language: 'javascript' }), files);
  expect(host.querySelector('[role=alert]')).toBeNull();
});

it('uses one tab stop per choice group and lets the keyboard choose a framework or layout', () => {
  mount();
  const dialog = host.querySelector('[role=dialog]')!;
  const choices = () => dialog.querySelector('[role=toolbar]')!;
  const selected = () => choices().querySelector<HTMLButtonElement>('button[tabindex="0"]')!;
  selected().focus(); key('ArrowLeft');
  expect(selected().getAttribute('aria-label')).toBe('Vue');
  expect(document.activeElement).toBe(selected());
  key('Home'); key('ArrowRight');
  expect(selected().getAttribute('aria-label')).toBe('React');
  chooseType(dialog, 'web');
  selected().focus(); key('End');
  expect(selected().textContent).toBe('Dashboard');
  expect(selected().getAttribute('aria-pressed')).toBe('true');
});

it('asks which language the logic is in, JavaScript unless changed', () => {
  // An app has one logic language — the runtime refuses a bundle that mixes
  // them — so it is chosen with the app, not converted afterwards.
  mount(); const dialog = host.querySelector('[role=dialog]')!;
  chooseType(dialog, 'web');
  const submit = () => act(() => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  submit();
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'javascript' }));
  const python = dialog.querySelector<HTMLInputElement>('input[type=radio][value=python]')!;
  expect(python.closest('fieldset')?.querySelector('legend')?.textContent).toBe('Logic language');
  act(() => python.click());
  submit();
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'python' }));
});

it('offers torch only for a Python app, and asks for it only when ticked', () => {
  mount(); const dialog = host.querySelector('[role=dialog]')!;
  chooseType(dialog, 'ui');
  const submit = () => act(() => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(dialog.querySelector('[data-setting="python-torch"]')).toBeNull();
  const python = dialog.querySelector<HTMLInputElement>('input[type=radio][value=python]')!;
  expect(python.closest('fieldset')?.querySelector('legend')?.textContent).toBe('Logic language');
  act(() => python.click());
  submit();
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'python', pythonPackages: [] }));
  act(() => dialog.querySelector<HTMLInputElement>('[data-setting="python-torch"]')!.click());
  submit();
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'python', pythonPackages: ['torch'] }));
});

it('keeps a TypeScript web layout valid when changing to a classic project', () => {
  mount(); const dialog = host.querySelector('[role=dialog]')!;
  chooseType(dialog, 'web');
  act(() => dialog.querySelector<HTMLInputElement>('[value=typescript]')!.click());
  expect(dialog.querySelector('.bl-choice-detail code:last-child')?.textContent).toBe('app.ts');
  chooseType(dialog, 'ui');
  expect(dialog.querySelector('[value=typescript]')).toBeNull();
  expect(dialog.querySelector<HTMLInputElement>('[value=javascript]')?.checked).toBe(true);
  act(() => dialog.querySelector<HTMLButtonElement>('[type=submit]')!.click());
  expect(create.mock.lastCall?.[0]).toMatchObject({ template: 'blank', language: 'javascript', pythonPackages: [] });
  expect(create.mock.lastCall?.[0].format).toBeUndefined();
});

it('retains authored metadata across project types and drops Python packages for a React starter', async () => {
  mount(); const dialog = host.querySelector('[role=dialog]')!;
  const name = dialog.querySelector<HTMLInputElement>('input:not([type])')!;
  const description = dialog.querySelector('textarea')!;
  function edit(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  edit(name, 'My log');
  edit(description, 'Track my practice');
  chooseType(dialog, 'ui');
  act(() => dialog.querySelector<HTMLInputElement>('[value=python]')!.click());
  act(() => dialog.querySelector<HTMLInputElement>('[data-setting="python-torch"]')!.click());
  chooseType(dialog, 'starter');
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label=React]')!.click());
  expect(name.value).toBe('My log');
  expect(description.value).toBe('Track my practice');
  vi.spyOn(webStarters, 'createWebStarter').mockResolvedValueOnce([]);
  await act(async () => { dialog.querySelector<HTMLButtonElement>('[type=submit]')!.click(); });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    name: 'My log', description: 'Track my practice', format: 'web', language: 'javascript', pythonPackages: [],
  }), []);
});

it('offers only classic layouts in an embedded host', () => {
  vi.spyOn(hostedEditor, 'isHostedEditor').mockReturnValue(true);
  mount(); const dialog = host.querySelector('[role=dialog]')!;
  expect(dialog.querySelector('[value=starter]')).toBeNull();
  expect(dialog.querySelector('[value=typescript]')).toBeNull();
  expect(document.activeElement?.textContent).toBe('Blank');
  expect(dialog.querySelector('footer span')?.textContent).toBe('Opens in Design');
});

it('offers the source formats the embedded host can run', async () => {
  vi.spyOn(hostedEditor, 'isHostedEditor').mockReturnValue(true);
  vi.spyOn(hostedEditor, 'hostedWebContainersEnabled').mockReturnValue(true);
  mount();
  const dialog = host.querySelector('[role=dialog]')!;
  expect(dialog.querySelector<HTMLInputElement>('[value=starter]')?.checked).toBe(true);
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label=Vue]')!.click());
  act(() => dialog.querySelector<HTMLInputElement>('[value=vue-sfc]')!.click());
  const files = [{ path: 'App.vue', content: '<template>Hello</template>' }];
  vi.spyOn(webStarters, 'createWebStarter').mockResolvedValueOnce(files);
  await act(async () => { dialog.querySelector<HTMLButtonElement>('[type=submit]')!.click(); });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ format: 'web' }), files);
});

it.each([['React', 'react-jsx', 'App.jsx'], ['Vue', 'vue-sfc', 'App.vue']])(
  'lets the %s starter switch between JavaScript and its component source', async (framework, id, file) => {
    mount();
    const dialog = host.querySelector('[role=dialog]')!;
    const load = vi.spyOn(webStarters, 'createWebStarter').mockResolvedValueOnce([]);
    act(() => dialog.querySelector<HTMLButtonElement>(`[aria-label="${framework}"]`)!.click());
    expect(dialog.querySelector<HTMLInputElement>('[value=js]')?.checked).toBe(true);
    act(() => dialog.querySelector<HTMLInputElement>(`[value="${id}"]`)!.click());
    expect(dialog.querySelector('.bl-starter-format input:checked')?.closest('label')?.querySelector('code')?.textContent).toBe(file);
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[type=submit]')!.click(); });
    expect(load).toHaveBeenCalledWith(id, expect.objectContaining({ format: 'web' }));
  },
);

it('lists the shortcuts that exist, including the hierarchy keys and Ctrl+Y', () => {
  mount(true); const dialog = host.querySelector('[role=dialog]')!;
  expect(dialog.textContent).toContain('Hierarchy');
  expect(dialog.textContent).toContain('Ctrl+Y');
  expect(dialog.textContent).not.toContain('logic tab');
});
