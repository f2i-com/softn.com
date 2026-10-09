// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBundleEntries } from '@softn/core';
import { SourceView } from './SourceView';
import { useFilesStore } from '../../stores/filesStore';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { buildProjectBundle } from '../../utils/buildProjectBundle';
import { useHistoryStore } from '../../stores/historyStore';
import { generateSource } from '../../utils/sourceGenerator';
import { redoCanvas, undoCanvas } from '../../utils/canvasHistory';

let changeSource: (value: string) => void;
vi.mock('./CodeEditor', () => ({ CodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
  changeSource = onChange;
  return React.createElement('textarea', { value, readOnly: true, 'aria-label': 'UI source' });
} }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useFilesStore.getState().updateUIFileSource('main_ui', '<App><Text>Original</Text></App>');
  const file = useFilesStore.getState().uiFiles.get('main_ui')!;
  useCanvasStore.getState().loadState(file.elements, file.rootId);
  useProjectStore.getState().markClean();
  useFilesStore.getState().markFileDirty('main_ui', false);
  host = document.createElement('div');
  root = createRoot(host);
  act(() => root.render(React.createElement(SourceView)));
});
afterEach(() => act(() => root.unmount()));

describe('source edits and the visual model', () => {
  it.each([true, false])('keeps intentionally empty source in the editor and archive (logic file: %s)', async (withLogic) => {
    if (!withLogic) act(() => useFilesStore.getState().deleteFile('main_logic'));
    act(() => changeSource(''));
    expect(host.querySelector('textarea')!.value).toBe('');
    expect(useFilesStore.getState().uiFiles.get('main_ui')!.originalSource).toBe('');
    expect(host.querySelector('[title="Unsaved changes"]')).not.toBeNull();
    expect(useProjectStore.getState().isDirty).toBe(true);
    const bytes = await buildProjectBundle();
    expect(new TextDecoder().decode(readBundleEntries(bytes).get('ui/main.ui'))).toBe('');
  });

  it('updates the canvas model from source and keeps the dirty indicator until save', () => {
    act(() => changeSource('<App><Heading>New heading</Heading></App>'));
    const file = useFilesStore.getState().uiFiles.get('main_ui')!;
    expect([...file.elements.values()].find(e => e.componentType === 'Heading')?.props.children).toBe('New heading');
    expect(host.querySelector('[title="Unsaved changes"]')).not.toBeNull();
    act(() => useFilesStore.getState().markFileDirty('main_ui', false));
    expect(host.querySelector('[title="Unsaved changes"]')).toBeNull();
  });

  it('is one step for Undo, back to the page as it was when Code was opened', () => {
    // An edit in Code recorded no step. Back in Design, Undo went to the
    // state before the last change made on the canvas: what was written in
    // Code and that change were taken back together, by one press.
    const canvas = () => useCanvasStore.getState();
    const onCanvas = () => generateSource(canvas().elements, canvas().rootId, '');
    /** What the app does after each change: the file's tree goes onto the canvas. */
    const sync = () => {
      const file = useFilesStore.getState().uiFiles.get('main_ui')!;
      if (canvas().elements !== file.elements) canvas().loadState(file.elements, file.rootId);
    };
    useHistoryStore.getState().clear();

    act(() => changeSource('<App><Text>Original</Text><Badge>One</Badge></App>'));
    sync();
    act(() => changeSource('<App><Text>Original</Text><Badge>Two</Badge></App>'));
    sync();
    expect(onCanvas()).toContain('<Badge>Two</Badge>');
    expect(useHistoryStore.getState().past).toHaveLength(1);

    expect(undoCanvas()).toBe(true);
    expect(onCanvas()).toBe('<App>\n  <Text>Original</Text>\n</App>');
    expect(redoCanvas()).toBe(true);
    expect(onCanvas()).toContain('<Badge>Two</Badge>');
  });
});
