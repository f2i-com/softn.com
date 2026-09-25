// @vitest-environment jsdom
/**
 * Which logic file the Code view and the logic dock are about.
 *
 * Both used to be about a copy. The Code view showed a new file's source with
 * the logic inlined as a `<logic>` block, so the first keystroke there saved
 * that copy as the file's source; from then on the dock wrote
 * `logic/main.logic`, while the preview and the export ran the stale inline
 * block — the runtime reads a logic file only through a `<logic src>`. The
 * dock, for its part, looked for `logic/main.logic` by name and nothing else,
 * so in a Python app (or any app whose logic file is called something else)
 * it edited a project field the multi-file export never reads, and every
 * edit made there was dropped on save.
 *
 * Pinned: the Code view generates the shape export writes — a `<logic src>`
 * naming the linked file — and the dock edits the file the active UI file
 * links, in that file's language, so what is typed reaches the export.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { composeBundleSource, readBundleEntries } from '@softn/core';
import { SourceView } from './SourceView';
import { LogicEditor } from './LogicEditor';
import { useFilesStore } from '../../stores/filesStore';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { buildProjectBundle } from '../../utils/buildProjectBundle';
import { loadBundle } from '../../utils/bundleLoader';
import { commitProjectSnapshot, prepareProjectSnapshot } from '../../utils/openProject';
import { previewSourceFor } from '../../utils/previewSource';

/** The editors, by the language each was opened with, and what each shows. */
const editors = new Map<string, { value: string; onChange: (value: string) => void }>();
vi.mock('./CodeEditor', () => ({
  CodeEditor: ({ value, onChange, language }: { value: string; onChange: (value: string) => void; language: string }) => {
    editors.set(language, { value, onChange });
    return React.createElement('textarea', { value, readOnly: true, 'data-language': language });
  },
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

function mount(component: React.ComponentType): void {
  host = document.createElement('div');
  root = createRoot(host);
  act(() => root.render(React.createElement(component)));
}

function editor(language: string) {
  const entry = editors.get(language);
  if (!entry) throw new Error(`no ${language} editor is mounted (have ${[...editors.keys()].join(', ') || 'none'})`);
  return entry;
}

/** The bundle's entry composed the way every runtime composes it. */
async function exportedComposition() {
  const entries = readBundleEntries(await buildProjectBundle());
  const text = new Map([...entries].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
  const manifest = JSON.parse(text.get('manifest.json')!);
  return { text, composed: composeBundleSource(text, manifest.main, manifest.files.logic) };
}

/** The source the preview would run, from the stores as they stand. */
function previewSource() {
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

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  editors.clear();
});
afterEach(() => act(() => root.unmount()));

describe('the Code view of a new file', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useFilesStore.getState().reset();
    const file = useFilesStore.getState().uiFiles.get('main_ui')!;
    useCanvasStore.getState().loadState(file.elements, file.rootId);
  });

  it('links the logic file rather than inlining a copy of it', () => {
    mount(SourceView);
    const shown = editor('xml').value;
    expect(shown).toContain('<logic src="../logic/main.logic" />');
    expect(shown).not.toContain('let count');
  });

  it('does not keep a stale copy once edited, so a later dock edit reaches the preview and the export', async () => {
    mount(SourceView);
    // One keystroke in the Code view: the shown text becomes the file's source.
    act(() => editor('xml').onChange(`${editor('xml').value}\n`));
    act(() => root.unmount());

    mount(LogicEditor);
    act(() => editor('javascript').onChange('let count = 41\n'));

    const { composed } = await exportedComposition();
    expect(composed.source).toContain('let count = 41');
    expect(composed.source).not.toContain('let count = 0');

    const preview = previewSource();
    expect(preview.error).toBeNull();
    expect(preview.source).toContain('let count = 41');
    expect(preview.source).not.toContain('let count = 0');
  });
});

describe('the logic dock of an opened Python app', () => {
  const MAIN_UI = '<logic src="../logic/main.py" />\n<App>\n  <Text>{count}</Text>\n</App>\n';
  const MAIN_PY = 'count = 0\n';

  beforeEach(async () => {
    const bundle = zipSync({
      'manifest.json': strToU8(JSON.stringify({
        name: 'Py', version: '1.0.0', description: '', main: 'ui/main.ui',
        files: { ui: ['ui/main.ui'], logic: ['logic/main.py'], xdb: [], assets: [] },
      })),
      'ui/main.ui': strToU8(MAIN_UI),
      'logic/main.py': strToU8(MAIN_PY),
    });
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundle)));
  });

  it('edits the linked .py file, and the edit is exported', async () => {
    mount(LogicEditor);
    const [dock] = [...editors.values()];
    act(() => dock.onChange('count = 41\n'));

    const { text, composed } = await exportedComposition();
    expect(text.get('logic/main.py')).toBe('count = 41\n');
    expect(composed.languages).toContain('python');
    expect(composed.python?.files.main).toBe('count = 41\n');
  });

  it('shows the linked .py file, highlighted as Python', () => {
    mount(LogicEditor);
    expect(editor('python').value).toBe(MAIN_PY);
  });

  it('says so, and edits nothing, when the active UI file links no logic', () => {
    const files = useFilesStore.getState();
    const entryId = files.activeFileId!;
    act(() => files.updateUIFileSource(entryId, '<App>\n  <Text>no logic</Text>\n</App>\n'));
    mount(LogicEditor);
    expect(editors.size).toBe(0);
    expect(host.textContent).toContain('no logic file');
  });
});
