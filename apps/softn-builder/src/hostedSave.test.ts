// @vitest-environment jsdom
/**
 * A draft edited inside FormLogic, saved back to it, and undone.
 *
 * FormLogic opens the draft over the editor channel, asks for the project
 * when the person saves, and says when it has taken it. The project is held
 * against what it was opened as (utils/savedPoint.ts), so an edit undone
 * back to that is not unsaved; but once FormLogic has taken a draft, it
 * holds a revision this cannot know, and the project as it was opened is
 * nothing to come back to. Driven here through the channel itself, as
 * FormLogic drives it (src/hostedEditor.test.ts holds the channel's own
 * contract).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { connectHostedEditor } from '@softn/editor-shared/hostedEditor';
import { useCanvasStore } from './stores/canvasStore';
import { useFilesStore } from './stores/filesStore';
import { useHistoryStore } from './stores/historyStore';
import { useProjectStore } from './stores/projectStore';
import { useSchemaStore } from './stores/schemaStore';
import { loadBundle } from './utils/bundleLoader';
import { buildProjectBundle } from './utils/buildProjectBundle';
import { undoCanvas } from './utils/canvasHistory';
import { commitProjectSnapshot, prepareProjectSnapshot } from './utils/openProject';
import { saveToHost } from './utils/saveProject';

// fflate takes a value for a file by `instanceof Uint8Array`, which jsdom's TextEncoder fails.
const encode = (text: string) => Uint8Array.from(new TextEncoder().encode(text));
const unsaved = () => useProjectStore.getState().isDirty;

function draft(): Uint8Array {
  const manifest = { name: 'Draft', version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] } };
  return zipSync({ 'manifest.json': encode(JSON.stringify(manifest)), 'ui/main.ui': encode('<App>\n\n  <Text>Opened</Text>\n</App>\n') });
}

/** An edit on the canvas and its undo: the page as it was opened again. */
function editAndUndo(): void {
  const canvas = useCanvasStore.getState();
  const text = [...canvas.elements.values()].find((element) => element.componentType === 'Text')!;
  useHistoryStore.getState().push(canvas.elements, canvas.rootId);
  canvas.updateElementProps(text.id, { children: 'Changed' });
  expect(unsaved()).toBe(true);
  expect(undoCanvas()).toBe(true);
}

/** FormLogic's side of the channel. */
function formLogic() {
  const channel = new MessageChannel();
  const heard: Array<Record<string, unknown>> = [];
  const waiting = new Map<string, (value: unknown) => void>();
  channel.port2.onmessage = ({ data }) => {
    heard.push(data);
    if (typeof data?.id === 'string' && 'ok' in data && !data.kind) waiting.get(data.id)?.(data.ok ? data.value : Promise.reject(new Error(String(data.error))));
  };
  channel.port2.start();
  let asked = 0;
  const ask = (method: string, data: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve) => {
      const id = `ask-${(asked += 1)}`;
      waiting.set(id, resolve);
      channel.port2.postMessage({ id, method, ...data });
    });
  const saveRequested = async (): Promise<string> => {
    for (let tries = 0; tries < 100; tries += 1) {
      const request = heard.find((message) => message.kind === 'save-requested');
      if (request) return String(request.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('FormLogic was not asked to save');
  };
  return { port: channel.port1, ask, saveRequested, answer: (id: string, ok: boolean) => channel.port2.postMessage({ kind: 'save-result', id, ok, ...(ok ? {} : { error: 'The draft changed in FormLogic.' }) }), close: () => channel.port2.close() };
}

let dispose: () => void = () => {};
let parent: ReturnType<typeof formLogic>;

beforeEach(async () => {
  Object.defineProperty(window, 'location', { value: { ...window.location, search: '?formlogicEditor=1', origin: 'http://formlogic.test' }, configurable: true, writable: true });
  Object.defineProperty(window, 'parent', { value: { postMessage: vi.fn() }, configurable: true, writable: true });
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  useHistoryStore.getState().clear();
  // As App.tsx connects: the draft is opened as any bundle is, and the export is the project's.
  dispose = connectHostedEditor({
    open: async (bytes) => commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bytes))),
    export: buildProjectBundle,
  });
  parent = formLogic();
  window.dispatchEvent(new MessageEvent('message', { data: { kind: 'formlogic-editor-connect', protocol: 1 }, origin: location.origin, source: window.parent as unknown as Window, ports: [parent.port] }));
  await parent.ask('open', { bytes: draft(), name: 'Draft' });
  useHistoryStore.getState().clear();
});

afterEach(() => {
  dispose();
  parent.close();
});

describe('a draft opened from FormLogic', () => {
  it('is saved again when an edit is undone, until it has been sent back', async () => {
    expect(unsaved()).toBe(false);
    editAndUndo();
    expect(unsaved()).toBe(false);

    const saving = saveToHost();
    const id = await parent.saveRequested();
    // FormLogic takes the project as it is when it asks.
    const taken = await parent.ask('export');
    // A bundle, from another realm once it has crossed the channel.
    expect(Object.prototype.toString.call(taken)).toBe('[object Uint8Array]');
    parent.answer(id, true);
    expect(await saving).toEqual({ kind: 'saved' });

    // FormLogic holds whatever revision it took: the draft as opened is not it.
    editAndUndo();
    expect(unsaved()).toBe(true);
  });

  it('is not said to be saved where FormLogic refused it, and is unsaved after an edit undone', async () => {
    const saving = saveToHost();
    parent.answer(await parent.saveRequested(), false);
    expect(await saving).toEqual({ kind: 'failed', error: 'The draft changed in FormLogic.' });
    editAndUndo();
    expect(unsaved()).toBe(true);
  });
});

describe('a save with FormLogic not on the line', () => {
  it('is said to be so, and nothing is forgotten', async () => {
    dispose();
    expect(await saveToHost()).toEqual({ kind: 'disconnected' });
    editAndUndo();
    expect(unsaved()).toBe(false);
  });
});
