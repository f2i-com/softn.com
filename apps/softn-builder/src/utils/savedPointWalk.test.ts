// @vitest-environment jsdom
/**
 * A project said to be saved is one whose save writes what was last kept:
 * walked at random.
 *
 * savedPoint.test.ts holds the ways a project comes back to what was kept,
 * each thought of and written down. The two that were wrong were ones
 * nobody had thought of: a page written in Code and saved, then stepped
 * back with Undo, was "saved" with the canvas holding something else, and
 * so was everything done on the canvas from there; and a text typed back in
 * Code, with the canvas stepped back to before it, was "saved" while the
 * next save wrote the page again in the Builder's layout. Both were found
 * by doing what a person does, in no particular order, and asking after
 * each step: the toolbar does not say "Unsaved", so does a save write the
 * bundle that was opened, or the one last saved?
 *
 * The walks are the same every run: each is drawn from its own number. The
 * app's own hook is mounted (useActiveFileOnCanvas), so a tab changed, a
 * page written in Code and a logic file opened in the middle go as they go
 * in the app. `SAVED_POINT_WALKS` and `SAVED_POINT_STEPS` make it longer
 * when something here is changed: 2,500 walks of sixty steps over each
 * layout took under three minutes, and found nothing more.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readBundleEntries } from '@softn/core';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { useActiveFileOnCanvas } from '../hooks/useActiveFileOnCanvas';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle, flushCanvasToActiveFile } from './buildProjectBundle';
import { redoCanvas, undoCanvas } from './canvasHistory';
import { commitProjectSnapshot, prepareProjectSnapshot } from './openProject';
import { writeRecoveryCopy } from './recoveryCopy';
import { resetPersistedRevisions, saveProject } from './saveProject';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const WALKS = Number(process.env.SAVED_POINT_WALKS ?? 60);
const STEPS = Number(process.env.SAVED_POINT_STEPS ?? 60);

const LOGIC = 'let count = 0;\n';
const TASKS = {
  collection: 'tasks',
  schema: { alias: 'tasks', fields: [{ id: 'f_title', name: 'title', type: 'string', required: true }] },
  records: [{ id: '0f3c0c4e-7f4a-4a2c-9a51-3a0f2e5b7d11', collection: 'tasks', data: { title: 'Write it' }, created_at: '2024-01-02T03:04:05.000Z', updated_at: '2024-01-03T03:04:05.000Z', deleted: false }],
};
const HEAD = '<logic src="../logic/main.logic" />\n\n<data>\n  <collection name="tasks" as="tasks" />\n</data>\n\n';
/** The pages as a person lays them out, and as the Builder writes them: only the second is what a page written again comes to. */
const LAYOUTS: Record<string, { main: string; about: string }> = {
  'as a person laid them out': { main: `${HEAD}<App>\n\n  <Text>First</Text>\n\n  <Button>Go</Button>\n</App>\n`, about: '<App>\n\n  <Text>About</Text>\n</App>\n' },
  'as the Builder writes them': { main: `${HEAD}<App>\n  <Text>First</Text>\n  <Button>Go</Button>\n</App>`, about: '<App>\n  <Text>About</Text>\n</App>' },
};
const WORDS = ['First', 'Uno', 'Due', 'About', 'Go'];

/** Numbers between 0 and 1, the same for the same seed (mulberry32). */
function numbers(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function Host(): null {
  useActiveFileOnCanvas();
  return null;
}

const files = () => useFilesStore.getState();
const canvas = () => useCanvasStore.getState();
const project = () => useProjectStore.getState();
const schema = () => useSchemaStore.getState();
const nowhere = () => ({ setItem: () => undefined, getItem: () => null, removeItem: () => undefined });

/** A bundle's entries as text, without the time a save stamps anew on a record it has changed. */
function written(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, entry] of readBundleEntries(bytes)) {
    let text = new TextDecoder().decode(entry);
    if (path.endsWith('.xdb')) {
      const file = JSON.parse(text) as { records?: Array<Record<string, unknown>> };
      for (const record of file.records ?? []) delete record.updated_at;
      text = JSON.stringify(file);
    }
    out[path] = text;
  }
  return out;
}

let root: Root | undefined;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

/** One walk. What was wrong, with the steps that led to it, or null. */
async function walk(seed: number, start: Uint8Array): Promise<string | null> {
  const random = numbers(seed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];

  resetPersistedRevisions();
  const bundle = await loadBundle(start);
  act(() => {
    commitProjectSnapshot(prepareProjectSnapshot(bundle));
    useHistoryStore.getState().clear();
  });
  root = createRoot(document.body.appendChild(document.createElement('div')));
  act(() => root!.render(React.createElement(Host)));

  /** What the last file written holds: the bundle opened, then each save. */
  let kept = written(await buildProjectBundle());
  let view: 'design' | 'code' = 'design';
  /** The file the Code view has taken its one step for Undo for (SourceView.tsx). */
  let recordedFor: string | null = null;
  const made: string[] = [];

  const pageOpen = () => (files().activeFileId ? files().nodes.get(files().activeFileId!)?.fileType === 'ui' : false);
  // The panels hold the last page with a logic file open in the middle; Undo is offered with a page open.
  const pageHeld = () => view === 'design' && (pageOpen() || canvas().pageId !== null);
  const step = (change: () => void) => {
    useHistoryStore.getState().push(canvas().elements, canvas().rootId);
    change();
  };
  const texts = () => [...canvas().elements.values()].filter((element) => typeof element.props?.children === 'string');
  const leaves = () => [...canvas().elements.values()].filter((element) => element.id !== canvas().rootId && element.children.length === 0);
  const logic = () => [...files().logicFiles.keys()][0];
  const retype = () => {
    if (texts().length === 0) return false;
    const element = pick(texts());
    step(() => canvas().updateElementProps(element.id, { children: pick(WORDS) }));
  };

  const save = async (during?: () => void): Promise<void> => {
    let bytes: Uint8Array | null = null;
    let finish: (() => void) | null = null;
    const saving = saveProject({
      view: 'design', existingHandle: null, storage: nowhere(),
      writeFile: (saved) => {
        bytes = saved;
        return during ? new Promise((resolve) => { finish = () => resolve(null); }) : Promise.resolve(null);
      },
    });
    if (during) {
      for (let tries = 0; tries < 50 && !finish; tries += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      act(() => during());
      (finish as (() => void) | null)?.();
    }
    let outcome: Awaited<typeof saving> | undefined;
    await act(async () => { outcome = await saving; });
    if (outcome?.kind === 'saved' && bytes) kept = written(bytes);
  };

  /** Each returns false when it is not offered as things stand. Those between Code, a save and Undo are taken three times as often. */
  const steps: Array<[name: string, weight: number, run: () => boolean | void | Promise<void>]> = [
    ['retype', 3, () => (pageHeld() ? retype() : false)],
    ['add', 1, () => (pageHeld() ? step(() => void canvas().addElement('Divider', canvas().rootId, undefined, { starter: true })) : false)],
    ['delete', 1, () => {
      if (!pageHeld() || leaves().length === 0) return false;
      const element = pick(leaves());
      step(() => canvas().deleteElement(element.id));
    }],
    ['undo', 6, () => (view === 'design' && pageOpen() ? undoCanvas() : false)],
    ['redo', 3, () => (view === 'design' && pageOpen() ? redoCanvas() : false)],
    ['flush', 1, () => flushCanvasToActiveFile()],
    ['open', 1, () => {
      const others = [...files().uiFiles.keys(), logic()].filter((id) => id !== files().activeFileId);
      view = 'design';
      recordedFor = null;
      flushCanvasToActiveFile();
      files().openFile(pick(others));
    }],
    ['close', 1, () => {
      if (!files().activeFileId) return false;
      view = 'design';
      recordedFor = null;
      files().closeFile(files().activeFileId!);
    }],
    ['to-code', 3, () => {
      if (view === 'code' || !pageOpen()) return false;
      flushCanvasToActiveFile();
      view = 'code';
      recordedFor = null;
    }],
    ['to-design', 3, () => {
      if (view === 'design') return false;
      flushCanvasToActiveFile();
      view = 'design';
    }],
    ['write', 3, () => {
      if (view !== 'code' || !pageOpen()) return false;
      const id = files().activeFileId!;
      const text = files().uiFiles.get(id)!.originalSource;
      const next = text?.replace(/>(First|Uno|Due|About)</, `>${pick(WORDS.slice(0, 4))}<`);
      if (text === undefined || next === undefined || next === text) return false;
      if (recordedFor !== id) {
        recordedFor = id;
        useHistoryStore.getState().push(canvas().elements, canvas().rootId);
      }
      files().updateUIFileSource(id, next);
    }],
    ['logic', 1, () => files().updateLogicFile(logic(), pick([LOGIC, `${LOGIC}let more = 1;\n`]))],
    ['name', 1, () => project().setName(pick(['Walked', 'Other']))],
    ['record', 1, () => schema().updateSeedRecord(schema().entities[0].id, 0, { title: pick(['Write it', 'Changed']) })],
    ['new-page', 1, () => {
      if (made.length > 0) return false;
      made.push(files().createFile('ui', 'extra.ui', 'ui'));
      view = 'design';
      recordedFor = null;
    }],
    ['delete-page', 1, () => (made.length > 0 ? files().deleteFile(made.pop()!) : false)],
    ['rename', 1, () => {
      const about = [...files().uiFiles.values()].find((file) => /about|other/.test(file.path));
      if (!about) return false;
      files().renameFile(about.id, about.path.endsWith('about.ui') ? 'other.ui' : 'about.ui');
    }],
    ['recovery-copy', 1, () => void writeRecoveryCopy({ view: 'design', storage: nowhere() })],
    ['save', 3, () => save()],
    ['save-while-retyping', 1, () => save(() => void (view === 'design' && pageOpen() && retype()))],
  ];
  const offered = steps.flatMap((each) => Array.from({ length: each[1] }, () => each));

  const taken: string[] = [];
  for (let at = 0; at < STEPS; at += 1) {
    const [name, , run] = pick(offered);
    let did: boolean | void | Promise<void> = false;
    if (name.startsWith('save')) {
      await (run() as Promise<void>);
      did = true;
    } else {
      act(() => { did = run(); });
    }
    if (did === false) continue;
    taken.push(name);
    // Not after every step: asking puts the canvas into its file, as a save does, and what follows a step left unasked is walked too.
    if (project().isDirty || project().isAsKept === null || random() >= 0.6) continue;
    let bytes: Uint8Array | undefined;
    await act(async () => { bytes = await buildProjectBundle(); });
    const now = written(bytes!);
    const changed = [...new Set([...Object.keys(now), ...Object.keys(kept)])].filter((path) => now[path] !== kept[path]);
    if (changed.length > 0) return `walk ${seed}: not "Unsaved" after [${taken.join(' ')}], and a save would change ${changed.join(', ')}`;
  }
  act(() => root?.unmount());
  root = undefined;
  return null;
}

describe('a project that is not "Unsaved"', () => {
  it.each(Object.entries(LAYOUTS))('is one whose save writes what was last kept, whatever was done to it (pages %s)', async (_layout, pages) => {
    const manifest = { name: 'Walked', version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui', 'ui/pages/about.ui'], logic: ['logic/main.logic'], xdb: ['xdb/tasks.xdb'], assets: [] } };
    const start = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'ui/main.ui': strToU8(pages.main),
      'ui/pages/about.ui': strToU8(pages.about),
      'logic/main.logic': strToU8(LOGIC),
      'xdb/tasks.xdb': strToU8(JSON.stringify(TASKS)),
    });
    const wrong: string[] = [];
    for (let seed = 1; seed <= WALKS && wrong.length < 3; seed += 1) {
      const problem = await walk(seed, start);
      if (problem) wrong.push(problem);
      act(() => root?.unmount());
      root = undefined;
    }
    expect(wrong).toEqual([]);
  }, 600_000);
});
