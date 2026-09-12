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
