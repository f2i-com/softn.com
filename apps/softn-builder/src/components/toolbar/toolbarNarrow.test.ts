// @vitest-environment jsdom
/**
 * The project's name can be read in the narrowest window Design is offered in.
 *
 * At 900 pixels the toolbar's row is longer than the window, and one thing
 * in it could give way: the name, which is the one thing that is cut short
 * with an ellipsis. Every button kept its full width, and "Field Notes"
 * was "F…".
 *
 * The row measures itself (a container query, so it is the row's own width
 * that counts and not the window's), and where it is short the buttons that
 * a glance knows by their drawing give up their words: Undo and Redo, then
 * New and Open. Each keeps its name for a screen reader and its tooltip.
 * Driven in Chromium at 900 pixels for what is left to the name; what can
 * be held here is that the pieces are in place.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../stores/projectStore';
import { Toolbar } from './Toolbar';

// Whether the editor can be installed is asked of the browser, which this DOM is not.
vi.mock('./useInstallPrompt', () => ({ useInstallPrompt: () => ({ canInstall: false, promptInstall: () => undefined }) }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// By its path: under this DOM `import.meta.url` is an http address.
const css = readFileSync(resolve(__dirname, '../../styles/builder.css'), 'utf8');
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useProjectStore.getState().reset();
  useProjectStore.getState().setName('Field Notes');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const nothing = () => undefined;
  act(() =>
    root.render(
      React.createElement(Toolbar, { view: 'design', onViewChange: nothing, onSave: nothing, onNew: nothing, onOpen: nothing, onShortcuts: nothing, onExport: nothing, activeFileType: 'ui' })
    )
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === name);

describe('the toolbar in a narrow window', () => {
  it('measures its own row', () => {
    expect(host.querySelector('[role="toolbar"]')!.classList.contains('bl-toolbar')).toBe(true);
    expect(/\.bl-toolbar\s*\{[^}]*container-type:\s*inline-size/.test(css)).toBe(true);
  });

  it('has buttons that can give up their words and keep their names', () => {
    for (const [name, step] of [['Undo', '1'], ['Redo', '1'], ['New', '2'], ['Open', '2']] as const) {
      const tool = button(name)!;
      expect(tool, name).toBeDefined();
      expect(tool.getAttribute('data-compact'), name).toBe(step);
      // The word is still there to be read, and is what is put out of sight.
      expect(tool.querySelector('.bl-tool-label')?.textContent, name).toBe(name);
      expect(tool.getAttribute('title'), name).toContain(name);
    }
    // Save and Export say what they do in every width.
    expect(button('Save')).toBeUndefined();
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Export') && !b.hasAttribute('data-compact'))).toBe(true);
  });

  it('puts the words out of sight where the row is short, the undo pair first, in a way a screen reader still reads', () => {
    const rule = (step: string) => new RegExp(`@container[^{]*\\(max-width:\\s*(\\d+)px\\)\\s*\\{\\s*\\.bl-tool\\[data-compact='${step}'\\]\\s+\\.bl-tool-label\\s*\\{([^}]*)\\}`).exec(css);
    const first = rule('1');
    const second = rule('2');
    expect(first, 'the rule for Undo and Redo').not.toBeNull();
    expect(second, 'the rule for New and Open').not.toBeNull();
    expect(Number(first![1])).toBeGreaterThan(Number(second![1]));
    for (const found of [first!, second!]) {
      // Clipped to nothing, not `display: none`: the name stays in the accessibility tree.
      expect(found[2]).toContain('position: absolute');
      expect(found[2]).toContain('clip-path: inset(50%)');
      expect(found[2]).not.toContain('display: none');
    }
  });

  it('gives the name the room that is left, and the whole of it in a tooltip', () => {
    const name = host.querySelector<HTMLElement>('[data-project-name]')!;
    expect(name.textContent).toBe('Field Notes');
    expect(name.getAttribute('title')).toContain('Field Notes');
    // It may shrink, and is the last to: nothing else in the row may.
    expect(name.style.flexShrink).toBe('1');
    expect(['0', '0px']).toContain(name.style.minWidth);
  });
});
