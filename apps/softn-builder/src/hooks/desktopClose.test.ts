// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUnsavedChanges } from './useUnsavedChanges';
import { useProjectStore } from '../stores/projectStore';

const desktop = vi.hoisted(() => ({ listen: vi.fn(), ask: vi.fn(), destroy: vi.fn(), stop: vi.fn() }));
vi.mock('../utils/desktop', () => ({ isDesktop: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: desktop.listen, destroy: desktop.destroy }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: desktop.ask }));

let root: Root;
let close: (event: { preventDefault: () => void }) => Promise<void>;
function Guard() { useUnsavedChanges(); return null; }

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useProjectStore.getState().reset();
  desktop.listen.mockImplementation(async (handler) => { close = handler; return desktop.stop; });
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Guard)));
});
afterEach(() => { act(() => root.unmount()); });

it('lets a saved desktop workspace close without a dialog', async () => {
  const preventDefault = vi.fn();
  await close({ preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(desktop.ask).not.toHaveBeenCalled();
});

it('keeps unsaved work open when the native close confirmation is declined', async () => {
  useProjectStore.getState().setLogicSource('let changed = true;');
  desktop.ask.mockResolvedValue(false);
  const preventDefault = vi.fn();
  await close({ preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  expect(desktop.destroy).not.toHaveBeenCalled();
});

it('closes only after confirming the current revision', async () => {
  useProjectStore.getState().setLogicSource('let changed = true;');
  desktop.ask.mockResolvedValue(true);
  await close({ preventDefault: vi.fn() });
  expect(desktop.destroy).toHaveBeenCalledTimes(1);
});

it('keeps later edits when a close dialog was answered for an older revision', async () => {
  useProjectStore.getState().setLogicSource('let changed = true;');
  desktop.ask.mockImplementation(async () => {
    useProjectStore.getState().setLogicSource('let newer = true;');
    return true;
  });
  await close({ preventDefault: vi.fn() });
  expect(desktop.destroy).not.toHaveBeenCalled();
});
