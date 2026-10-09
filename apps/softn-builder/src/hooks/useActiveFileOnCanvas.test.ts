// @vitest-environment jsdom
/**
 * What is on the canvas and not yet in its file survives everything that is
 * not about that file's own tree. See useActiveFileOnCanvas.ts.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../utils/sourceParser';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useActiveFileOnCanvas } from './useActiveFileOnCanvas';

const UI_ID = 'main_ui';
const LOGIC_ID = 'main_logic';

let root: Root | undefined;
let host: HTMLDivElement;

function Host(): null {
  useActiveFileOnCanvas();
  return null;
}

function files() {
  return useFilesStore.getState();
}

function canvas() {
  return useCanvasStore.getState();
}

/** The text of every element on the canvas that has some. */
function words(): string[] {
  return [...canvas().elements.values()].map((el) => el.props.children).filter((text): text is string => typeof text === 'string');
}

function openSource(source: string): void {
  act(() => {
    files().updateUIFileSource(UI_ID, source);
    const parsed = parseSource(source);
    files().syncUIFileElements(UI_ID, parsed.elements, parsed.rootId);
    files().markFileDirty(UI_ID, false);
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(Host)));
  openSource('<logic src="../logic/main.logic" />\n<App>\n  <Text>First</Text>\n</App>\n');
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('the canvas', () => {
  it('shows the file that is open', () => {
    expect(words()).toEqual(['First']);
  });

  it('keeps an edit that is not in the file yet when another file is renamed', () => {
    let added = '';
    act(() => {
      added = canvas().addElement('Button', canvas().rootId, undefined, { starter: true });
    });
    expect(words()).toEqual(['First', 'Click me']);

    act(() => files().renameFile(LOGIC_ID, 'app.logic'));
    expect(files().uiFiles.get(UI_ID)!.logicSrc).toBe('../logic/app.logic');
    expect(words()).toEqual(['First', 'Click me']);
    // And what was being worked on is still selected.
    expect(canvas().selectedIds).toEqual([added]);
  });

  it('keeps it when another file is deleted', () => {
    // A second page, made and left: the app flushes the canvas as the tab changes.
    let extra = '';
    act(() => {
      extra = files().createFile('ui', 'Other.ui', 'ui');
    });
    act(() => files().setActiveFile(UI_ID));
    expect(words()).toEqual(['First']);

    act(() => {
      canvas().addElement('Button', canvas().rootId, undefined, { starter: true });
    });
    act(() => files().deleteFile(extra));
    expect(files().uiFiles.has(extra)).toBe(false);
    expect(words()).toEqual(['First', 'Click me']);
  });

  it('keeps its selection when it is flushed to the file', () => {
    let added = '';
    act(() => {
      added = canvas().addElement('Button', canvas().rootId, undefined, { starter: true });
    });
    act(() => files().updateUIFile(UI_ID, canvas().elements, canvas().rootId!));
    expect(files().uiFiles.get(UI_ID)!.originalSource).toContain('Click me');
    expect(canvas().selectedIds).toEqual([added]);
  });

  it('is loaded again when the file is given a new tree', () => {
    openSource('<App>\n  <Text>Rewritten</Text>\n</App>\n');
    expect(words()).toEqual(['Rewritten']);
  });

  it('is put back to the file when the file refuses its edit', () => {
    // A comment before a closing tag has no element to stay with, so this
    // file is edited as source only.
    openSource('<App>\n  <Text>First</Text>\n  // kept\n</App>\n');
    act(() => {
      canvas().addElement('Button', canvas().rootId, undefined, { starter: true });
    });
    expect(words()).toEqual(['First', 'Click me']);
    act(() => files().updateUIFile(UI_ID, canvas().elements, canvas().rootId!));
    expect(files().uiFiles.get(UI_ID)!.visualEditBlocked).toBeDefined();
    expect(words()).toEqual(['First']);
  });
});
