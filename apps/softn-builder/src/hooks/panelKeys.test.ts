// @vitest-environment jsdom
/**
 * There is a way out of a code editor from the keyboard, and the editor
 * says what it is.
 *
 * In a code editor Tab indents. That is right, and it meant the Tab key
 * stopped at the Logic dock under the canvas: Properties and the hierarchy
 * came after it, and were reached forward only by hiding the dock. The
 * editor has a key of its own that hands Tab back (Ctrl+M), which nothing
 * on the screen said.
 *
 * F6 goes to the next panel and Shift+F6 to the one before, from anywhere,
 * a code editor included: the panels are what App marks as such
 * (`data-panel`). Both keys are named beside each code editor and in the
 * list of shortcuts.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceShortcuts } from './useWorkspaceShortcuts';
import { focusPanel } from '../utils/panelFocus';
import { tabFocusKeyLabel } from '../utils/platformKeys';
import { EditorWayOut } from '../components/editor/EditorWayOut';
import { ShortcutsDialog } from '../components/toolbar/ShortcutsDialog';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

function Workspace(): null {
  const nothing = () => undefined;
  useWorkspaceShortcuts({ blocked: false, narrow: false, canvas: true, save: nothing, open: nothing, create: nothing, export: nothing, shortcuts: nothing, changeView: nothing });
  return null;
}

/** Four panels as Design lays them out: a palette with a row that holds its stop, a canvas, a code editor, and one with nothing to stop at. */
const PANELS = `
  <div data-panel="Components"><button id="hide">Hide</button><div id="row-a" tabindex="-1">A</div><div id="row-b" tabindex="0">B</div></div>
  <div data-panel="Canvas"><div id="item" tabindex="0">Heading</div></div>
  <div data-panel="Logic"><button id="hide-logic">Hide</button><textarea id="code" class="inputarea"></textarea></div>
  <div data-panel="Empty"><span>nothing here</span></div>
  <div data-panel="Properties"><input id="field" /></div>
`;
const at = () => document.activeElement?.id;
const key = (target: Element, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key: 'F6', shiftKey, bubbles: true, cancelable: true });
  act(() => void target.dispatchEvent(event));
  return event;
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  host.innerHTML = PANELS;
  const mount = document.createElement('div');
  host.appendChild(mount);
  root = createRoot(mount);
  act(() => root.render(React.createElement(Workspace)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('F6', () => {
  it('leaves a code editor for the panel after it, where Tab would have indented', () => {
    const code = document.getElementById('code')!;
    code.focus();
    const event = key(code);
    expect(at()).toBe('field');
    // The editor does not get the key as well.
    expect(event.defaultPrevented).toBe(true);
  });

  it('goes round the panels in their order, to the stop each one keeps, and back with Shift', () => {
    document.getElementById('field')!.focus();
    key(document.activeElement!);
    // The first thing that takes the focus in the panel.
    expect(at()).toBe('hide');
    key(document.activeElement!);
    expect(at()).toBe('item');
    // Into a code editor is into the code, not onto the button above it.
    key(document.activeElement!);
    expect(at()).toBe('code');
    // A panel with nothing to stop at is passed.
    key(document.activeElement!);
    expect(at()).toBe('field');
    key(document.activeElement!, true);
    expect(at()).toBe('code');
    key(document.activeElement!, true);
    expect(at()).toBe('item');
  });

  it('starts at the first panel when the focus is in none', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    key(document.body);
    expect(at()).toBe('hide');
    expect(focusPanel(1)).toBe(true);
    expect(at()).toBe('item');
  });

  it('is left to a dialog that is open over the workspace', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<input id="in-dialog" />';
    host.appendChild(dialog);
    document.getElementById('in-dialog')!.focus();
    const event = key(document.activeElement!);
    expect(at()).toBe('in-dialog');
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('the way out of a code editor', () => {
  it('is said beside the editor: F6, and the editor\'s own key that hands Tab back', () => {
    const mount = document.createElement('div');
    host.appendChild(mount);
    const hint = createRoot(mount);
    act(() => hint.render(React.createElement(EditorWayOut)));
    expect(mount.textContent).toBe(`Tab indents here. F6 goes to the next panel; ${tabFocusKeyLabel()} lets Tab leave.`);
    act(() => hint.unmount());
  });

  it('names the editor\'s key as each platform has it', () => {
    expect(tabFocusKeyLabel(false)).toBe('Ctrl+M');
    expect(tabFocusKeyLabel(true)).toBe('⌃⇧M');
  });

  it('is in the list of shortcuts', () => {
    const mount = document.createElement('div');
    host.appendChild(mount);
    const dialog = createRoot(mount);
    act(() => dialog.render(React.createElement(ShortcutsDialog, { isOpen: true, onClose: () => undefined })));
    const text = document.body.textContent ?? '';
    expect(text).toContain('Next / previous panel');
    expect(text).toContain('F6');
    expect(text).toContain('Let Tab leave a code editor');
    act(() => dialog.unmount());
  });
});
