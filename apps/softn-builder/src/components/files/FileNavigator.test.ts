// @vitest-environment jsdom
/**
 * The file list says which files the canvas can write back (UX-02).
 *
 * The source/visual capability badge sat on the source view and on the
 * canvas — for the file already open. A creator choosing which file to
 * edit visually had to open each one to find out whether the canvas
 * would refuse it. Every .ui row in the navigator now carries a small
 * "source" mark when its fidelity is not lossless, computed lazily with
 * the same hook the other two surfaces use, so the answer is visible
 * before the file is opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFilesStore } from '../../stores/filesStore';
import { parseSource } from '../../utils/sourceParser';
import { FileNavigator } from './FileNavigator';

const LOSSY_UI = `// a comment the visual model cannot hold\n<App>\n  <Text>Hi</Text>\n</App>\n`;
const LOSSLESS_UI = `<App>\n  #each (task in tasks)\n    <Text>{task}</Text>\n  #empty\n    <Text>None</Text>\n  #end\n</App>\n`;

const mounted: Root[] = [];

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(React.createElement(FileNavigator));
  });
  return host;
}

/** Open `source` as the file, the way the app does: text plus its parsed elements, clean. */
function open(id: string, source: string): void {
  const store = useFilesStore.getState();
  store.updateUIFileSource(id, source);
  const parsed = parseSource(source);
  store.syncUIFileElements(id, parsed.elements, parsed.rootId);
  store.markFileDirty(id, false);
}

function rowOf(host: HTMLElement, name: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>('div')].find(
    (el) => el.textContent?.startsWith(name) && el.querySelector('span')
  );
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let otherId: string;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const store = useFilesStore.getState();
  store.reset();
  store.initializeProject();
  otherId = store.createFile('ui', 'Other.ui', 'ui');
  open('main_ui', LOSSY_UI);
  open(otherId, LOSSLESS_UI);
});

afterEach(() => {
  act(() => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  vi.useRealTimers();
});

describe('the file navigator', () => {
  it('marks a file whose fidelity is not lossless as source-only, and only that file', () => {
    const host = mount();
    // Nothing is assessed yet: the verdict comes a moment after the source settles.
    expect(host.querySelector('[data-fidelity="source-only"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const marks = host.querySelectorAll<HTMLElement>('[data-fidelity="source-only"]');
    expect(marks).toHaveLength(1);
    expect(rowOf(host, 'main.ui').querySelector('[data-fidelity="source-only"]')).not.toBeNull();
    expect(rowOf(host, 'Other.ui').querySelector('[data-fidelity="source-only"]')).toBeNull();
    expect(marks[0].title).toMatch(/comment on line 1/);
  });

  it('uses the verdict the store already recorded without waiting', () => {
    // A refused visual edit records the verdict on the file; the row then
    // shows it at once.
    const file = useFilesStore.getState().uiFiles.get('main_ui')!;
    useFilesStore.getState().updateUIFile('main_ui', new Map(), file.rootId);
    expect(useFilesStore.getState().uiFiles.get('main_ui')!.sourceFidelity?.lossless).toBe(false);
    const host = mount();
    expect(rowOf(host, 'main.ui').querySelector('[data-fidelity="source-only"]')).not.toBeNull();
  });

  it('drops the mark once the source no longer has the construct', () => {
    const host = mount();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(host.querySelectorAll('[data-fidelity="source-only"]')).toHaveLength(1);

    act(() => {
      open('main_ui', LOSSLESS_UI);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(host.querySelector('[data-fidelity="source-only"]')).toBeNull();
  });
});
