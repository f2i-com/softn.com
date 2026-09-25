// @vitest-environment jsdom
/**
 * A UI file whose logic is an inline `<logic>` block.
 *
 * Sessions saved before the Code view linked logic hold `ui/main.ui` with the
 * project's logic inlined — a copy the dock cannot see (it said "links no
 * logic file") while the preview and export ran it. On restore the block
 * moves into its logic file when that loses nothing; otherwise it is left,
 * and the dock offers the move as one click that overwrites nothing.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useHistoryStore } from '../stores/historyStore';
import { useSchemaStore } from '../stores/schemaStore';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from './openProject';
import { loadBundle } from './bundleLoader';
import { dockLogicFile, entryFileId, logicStarter } from './logicFiles';
import { inlineLogicOf, planInlineLogicMove } from './inlineLogic';
import { previewSourceFor } from './previewSource';
import { LogicEditor } from '../components/editor/LogicEditor';

vi.mock('../components/editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => React.createElement('textarea', { value, readOnly: true }),
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const INLINE = 'let count = 7\n\nfunction bump() {\n  count++\n}';
const UI = `<logic>\n${INLINE}\n</logic>\n\n<App>\n  <Button @click={bump}>{count}</Button>\n</App>`;

function resetStores(): void {
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
  useHistoryStore.getState().clear();
  useSchemaStore.getState().reset();
  useFilesStore.getState().reset();
}

/**
 * A session as an older Builder wrote it: the entry's source holds the
 * inline block, and `logic/main.logic` holds `logicContent` (or is absent).
 */
function oldSession(logicContent: string | null, ui = UI): string {
  resetStores();
  const files = useFilesStore.getState();
  files.updateUIFileSource('main_ui', ui);
  if (logicContent === null) files.deleteFile('main_logic');
  else files.updateLogicFile('main_logic', logicContent);
  return JSON.stringify(captureSession('design'));
}

function restore(raw: string) {
  resetStores();
  const snapshot = prepareSessionSnapshot(raw);
  commitProjectSnapshot(snapshot);
  return snapshot;
}

function logicAt(path: string) {
  return [...useFilesStore.getState().logicFiles.values()].find((file) => file.path === path);
}

function dockFile() {
  const files = useFilesStore.getState();
  return dockLogicFile(files.activeFileId, files.uiFiles, files.logicFiles, entryFileId(files.uiFiles, useProjectStore.getState().source));
}

function preview() {
  const project = useProjectStore.getState();
  const files = useFilesStore.getState();
  const canvas = useCanvasStore.getState();
  return previewSourceFor({
    elements: canvas.elements,
    rootId: canvas.rootId,
    logicSource: project.logicSource,
    collections: project.collections,
    activeFileId: files.activeFileId,
    uiFiles: files.uiFiles,
    logicFiles: files.logicFiles,
    nodes: files.nodes,
    retainedSource: project.source,
  });
}

describe('restoring a session whose entry holds its logic inline', () => {
  it('creates logic/main.logic when there is none, links it, and the dock and preview use it', () => {
    const snapshot = restore(oldSession(null));

    const logic = logicAt('logic/main.logic');
    expect(logic?.content).toBe(`${INLINE}\n`);
    const node = useFilesStore.getState().nodes.get(logic!.id)!;
    expect(node.parentId && useFilesStore.getState().nodes.get(node.parentId)?.path).toBe('logic');

    const main = useFilesStore.getState().uiFiles.get('main_ui')!;
    expect(main.logicSrc).toBe('../logic/main.logic');
    expect(main.originalSource).toContain('<logic src="../logic/main.logic" />');
    expect(main.originalSource).not.toContain('let count');
    expect(dockFile()?.id).toBe(logic!.id);
    expect(snapshot.warnings.join('\n')).toContain('logic/main.logic');

    const shown = preview();
    expect(shown.error).toBeNull();
    expect(shown.source).toContain('let count = 7');
    // Loaded, not edited.
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  it('links logic/main.logic without writing it when it already holds the same code', () => {
    restore(oldSession(`${INLINE}\n`));
    expect(useFilesStore.getState().logicFiles.size).toBe(1);
    expect(dockFile()?.path).toBe('logic/main.logic');
  });

  it('replaces the starter a new project put in logic/main.logic', () => {
    restore(oldSession(logicStarter('javascript')));
    expect(logicAt('logic/main.logic')?.content).toBe(`${INLINE}\n`);
    expect(dockFile()?.path).toBe('logic/main.logic');
  });

  it('leaves both alone when logic/main.logic holds other logic', () => {
    restore(oldSession('let count = 99\n'));
    expect(logicAt('logic/main.logic')?.content).toBe('let count = 99\n');
    expect(useFilesStore.getState().uiFiles.get('main_ui')!.originalSource).toContain(INLINE);
    expect(dockFile()).toBeUndefined();
  });

  it('links logic/main.logic as it is when the inline block is only the starter the old Code view copied in', () => {
    // The common case: the Code view inlined the starter on its first
    // keystroke, and the dock went on writing the real work to the file.
    const ui = `<logic>\n${logicStarter('javascript')}\n</logic>\n\n<App>\n  <Text>{count}</Text>\n</App>`;
    restore(oldSession('let count = 99\n', ui));
    expect(logicAt('logic/main.logic')?.content).toBe('let count = 99\n');
    expect(useFilesStore.getState().logicFiles.size).toBe(1);
    const main = useFilesStore.getState().uiFiles.get('main_ui')!;
    expect(main.logicSrc).toBe('../logic/main.logic');
    expect(main.originalSource).not.toContain('function increment');
    expect(dockFile()?.path).toBe('logic/main.logic');
    expect(preview().source).toContain('let count = 99');
  });

  it('keeps a relative import naming the same file from the logic folder', () => {
    const ui = `<logic>\nimport "./helpers.logic"\n${INLINE}\n</logic>\n<App />`;
    restore(oldSession(null, ui));
    expect(logicAt('logic/main.logic')?.content).toContain('import "../ui/helpers.logic"');
  });

  it('moves an inline Python block into logic/main.py, dedented', () => {
    const ui = '<logic lang="python">\n    count = 0\n\n    def bump():\n        global count\n        count = count + 1\n</logic>\n<App />';
    restore(oldSession(null, ui));
    expect(logicAt('logic/main.py')?.content).toBe('count = 0\n\ndef bump():\n    global count\n    count = count + 1\n');
    expect(useFilesStore.getState().uiFiles.get('main_ui')!.logicSrc).toBe('../logic/main.py');
  });
});

describe('an opened bundle with inline logic', () => {
  it('is left as the author wrote it', async () => {
    const bundle = zipSync({
      'manifest.json': strToU8(JSON.stringify({
        name: 'Inline', version: '1.0.0', description: '', main: 'ui/main.ui',
        files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] },
      })),
      'ui/main.ui': strToU8(UI),
    });
    resetStores();
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundle)));
    const main = [...useFilesStore.getState().uiFiles.values()][0];
    expect(main.originalSource).toBe(UI);
    expect(useFilesStore.getState().logicFiles.size).toBe(0);
  });
});

describe('the rule', () => {
  it('finds exactly one inline block, and none beside a <logic src>', () => {
    expect(inlineLogicOf(UI)?.code.trim()).toBe(INLINE);
    expect(inlineLogicOf(`<logic src="../logic/a.logic" />\n${UI}`)).toBeNull();
    expect(inlineLogicOf(`${UI}\n<logic>let b = 1</logic>`)).toBeNull();
    expect(inlineLogicOf('<App />')).toBeNull();
  });

  it('refuses a lossy move and finds a fresh name for a chosen one', () => {
    resetStores();
    const files = useFilesStore.getState();
    files.updateUIFileSource('main_ui', UI);
    files.updateLogicFile('main_logic', 'let count = 99\n');
    const state = useFilesStore.getState();
    const file = state.uiFiles.get('main_ui')!;
    const taken = new Set([...state.nodes.values()].map((node) => node.path));
    expect(planInlineLogicMove(file, state.logicFiles, { isEntry: true, lossless: true, takenPaths: taken })).toBeNull();
    const chosen = planInlineLogicMove(file, state.logicFiles, { isEntry: true, lossless: false, takenPaths: taken });
    expect(chosen?.logicPath).toBe('logic/main_inline.logic');
    expect(chosen?.sparedPath).toBe('logic/main.logic');
  });
});

describe('the dock', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('offers to move inline logic to a file, and the move keeps the other file', () => {
    restore(oldSession('let count = 99\n'));
    act(() => root.render(React.createElement(LogicEditor)));
    expect(host.textContent).toContain('keeps its logic inline');
    const button = host.querySelector<HTMLButtonElement>('[data-action="move-inline-logic"]')!;
    act(() => button.click());

    expect(logicAt('logic/main.logic')?.content).toBe('let count = 99\n');
    expect(logicAt('logic/main_inline.logic')?.content).toBe(`${INLINE}\n`);
    expect(useFilesStore.getState().uiFiles.get('main_ui')!.logicSrc).toBe('../logic/main_inline.logic');
    expect(dockFile()?.path).toBe('logic/main_inline.logic');
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(host.textContent).toContain('logic/main_inline.logic');
    expect(preview().source).toContain('let count = 7');
  });
});
