// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useExclusiveAction } from './useExclusiveAction';
import { useWorkspaceShortcuts, type WorkspaceShortcutActions } from './useWorkspaceShortcuts';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('starts only one save while its picker/write is pending, including same-tick repeats', async () => {
  let finish!: () => void;
  const action = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  let state!: ReturnType<typeof useExclusiveAction>;
  function Harness() { state = useExclusiveAction(action); return null; }
  act(() => root.render(React.createElement(Harness)));
  let first!: Promise<void>;
  act(() => { first = state.run(); void state.run(); });
  expect(action).toHaveBeenCalledTimes(1); expect(state.isPending).toBe(true);
  await act(async () => { finish(); await first; });
  expect(state.isPending).toBe(false);
  act(() => { first = state.run(); });
  expect(action).toHaveBeenCalledTimes(2);
  await act(async () => { finish(); await first; });
});

it('unlocks after a failed operation and uses the latest view callback on retry', async () => {
  let state!: ReturnType<typeof useExclusiveAction>;
  function Harness({ action }: { action: () => Promise<void> }) { state = useExclusiveAction(action); return null; }
  act(() => root.render(React.createElement(Harness, { action: async () => { throw new Error('write failed'); } })));
  await act(async () => { await expect(state.run()).rejects.toThrow('write failed'); });
  expect(state.isPending).toBe(false);
  const retry = vi.fn(async () => {});
  act(() => root.render(React.createElement(Harness, { action: retry })));
  await act(async () => { await state.run(); });
  expect(retry).toHaveBeenCalledTimes(1);
});

function shortcutHarness(patch: Partial<WorkspaceShortcutActions> = {}) {
  const actions: WorkspaceShortcutActions = { blocked: false, narrow: false, save: vi.fn(), open: vi.fn(), create: vi.fn(), export: vi.fn(), shortcuts: vi.fn(), changeView: vi.fn(), ...patch };
  function Harness() { useWorkspaceShortcuts(actions); return React.createElement('textarea'); }
  act(() => root.render(React.createElement(Harness)));
  return actions;
}
function press(key: string, options: KeyboardEventInit = {}, target: HTMLElement = host) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event); return event;
}

it('saves from a focused editor, intercepts browser defaults, and ignores held-key repeats', () => {
  const actions = shortcutHarness(); const input = host.querySelector('textarea')!;
  const editorHandler = vi.fn(); input.addEventListener('keydown', editorHandler);
  expect(press('S', { metaKey: true }, input).defaultPrevented).toBe(true);
  expect(actions.save).toHaveBeenCalledTimes(1); expect(editorHandler).not.toHaveBeenCalled();
  expect(press('s', { ctrlKey: true, repeat: true }, input).defaultPrevented).toBe(true);
  expect(actions.save).toHaveBeenCalledTimes(1);
});

it('routes view keys through the same navigation action and leaves editing keys alone', () => {
  const actions = shortcutHarness();
  press('3', { ctrlKey: true }); expect(actions.changeView).toHaveBeenCalledWith('preview');
  expect(press('z', { ctrlKey: true }, host.querySelector('textarea')!).defaultPrevented).toBe(false);
  expect(press('?', {}, host.querySelector('textarea')!).defaultPrevented).toBe(false);
  press('s', { ctrlKey: true, isComposing: true }); expect(actions.save).not.toHaveBeenCalled();
});

it('does not act behind an open dialog', () => {
  const actions = shortcutHarness({ blocked: true });
  press('s', { ctrlKey: true }); press('3', { ctrlKey: true }); press('?');
  expect(actions.save).not.toHaveBeenCalled(); expect(actions.changeView).not.toHaveBeenCalled(); expect(actions.shortcuts).not.toHaveBeenCalled();
});

it('leaves panel-mounted modal drafts in control without invoking workspace or browser file actions', () => {
  const actions = shortcutHarness();
  host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true');
  const input = host.querySelector('textarea')!;
  expect(press('s', { ctrlKey: true }, input).defaultPrevented).toBe(true);
  expect(press('o', { metaKey: true }, input).defaultPrevented).toBe(true);
  press('e', { ctrlKey: true, shiftKey: true }, input); press('?', {}, host);
  expect(actions.save).not.toHaveBeenCalled(); expect(actions.open).not.toHaveBeenCalled();
  expect(actions.export).not.toHaveBeenCalled(); expect(actions.shortcuts).not.toHaveBeenCalled();
});

it('keeps phone Save/Open keys available without opening hidden desktop panels', () => {
  const actions = shortcutHarness({ narrow: true });
  press('s', { ctrlKey: true }); press('o', { ctrlKey: true }); press('n', { ctrlKey: true }); press('3', { ctrlKey: true });
  expect(actions.save).toHaveBeenCalledOnce(); expect(actions.open).toHaveBeenCalledOnce();
  expect(actions.create).not.toHaveBeenCalled(); expect(actions.changeView).not.toHaveBeenCalled();
});

// The view keys were not heard with the focus in a field or a code editor, so
// from the Code view, where the focus is in the editor, Ctrl+1 did nothing
// (and the browser took it, to go to its first tab) while the shortcuts
// listed it. No field and no code editor uses them for text.
function codeEditorHarness(actions: WorkspaceShortcutActions) {
  function Harness() {
    useWorkspaceShortcuts(actions);
    return React.createElement('div', { className: 'bl-code-editor' }, React.createElement('textarea'));
  }
  act(() => root.render(React.createElement(Harness)));
  return host.querySelector('textarea')!;
}
const views = (patch: Partial<WorkspaceShortcutActions> = {}): WorkspaceShortcutActions => ({ blocked: false, narrow: false, save: vi.fn(), open: vi.fn(), create: vi.fn(), export: vi.fn(), shortcuts: vi.fn(), changeView: vi.fn(), ...patch });

it('changes the view from inside a code editor', () => {
  const actions = views();
  const editor = codeEditorHarness(actions);
  expect(press('1', { ctrlKey: true }, editor).defaultPrevented).toBe(true);
  expect(actions.changeView).toHaveBeenCalledWith('design');
  press('3', { metaKey: true }, editor);
  expect(actions.changeView).toHaveBeenLastCalledWith('preview');
});

it('changes the view from a field, which has no use for the keys, and commits a name being typed first', () => {
  const actions = shortcutHarness();
  const field = host.querySelector('textarea')!;
  expect(press('4', { ctrlKey: true }, field).defaultPrevented).toBe(true);
  expect(actions.changeView).toHaveBeenCalledWith('code');
  const name = document.createElement('input');
  name.setAttribute('data-schema-name', '');
  host.append(name);
  name.focus();
  const committed = vi.fn();
  name.addEventListener('blur', committed);
  press('1', { ctrlKey: true }, name);
  expect(committed).toHaveBeenCalledOnce();
  expect(actions.changeView).toHaveBeenLastCalledWith('design');
});

// AltGr is heard as Ctrl and Alt together on Windows, and is how a keyboard
// that is not American types what its digit keys also hold: | @ # on a
// Spanish one, ² ³ on a German one, { [ on a French one. Where a layout
// gives a digit key nothing with AltGr the key is still the digit. None of
// it is a view key, nor Save: a key with Alt held is left to the field,
// now that the view keys are heard there.
it('leaves a key pressed with AltGr to the field it is typed into', () => {
  const actions = shortcutHarness();
  const field = host.querySelector('textarea')!;
  for (const key of ['1', '2', '3', '4', '@', '#', 's', 'o', 'n']) {
    const event = press(key, { ctrlKey: true, altKey: true }, field);
    expect(event.defaultPrevented, key).toBe(false);
  }
  expect(actions.changeView).not.toHaveBeenCalled();
  expect(actions.save).not.toHaveBeenCalled();
  expect(actions.open).not.toHaveBeenCalled();
  expect(actions.create).not.toHaveBeenCalled();
});

// A browser's autofill, and some input methods, send a `keydown` that is a
// plain Event with no `key` at all. The handler read `event.key.toLowerCase()`
// and threw, on every such event, from a listener that sees every key the
// page gets.
it('lets a keydown with no key pass, and still hears the keys after it', () => {
  const actions = shortcutHarness();
  const thrown: unknown[] = [];
  const onError = (event: ErrorEvent) => { thrown.push(event.error); event.preventDefault(); };
  window.addEventListener('error', onError);
  try {
    const field = host.querySelector('textarea')!;
    for (const extra of [{}, { ctrlKey: true }, { metaKey: true, shiftKey: true }, { altKey: true }]) {
      const event = new Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, extra);
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(thrown).toEqual([]);
    press('s', { ctrlKey: true }, field);
    expect(actions.save).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener('error', onError);
  }
});
