/** @vitest-environment jsdom */
/**
 * A page is given the collections it declares, and no others.
 *
 * Where an app is run, the only records a page can read are the ones its
 * `<data>` block binds: its own block, and the blocks of the pages it
 * imports, which the composer joins to it. A collection that is only a file
 * in the bundle (listed under `xdb` in the manifest, seeded into the store)
 * is there for the logic's `db` calls and is nothing to the page.
 *
 * Studio's preview and the agent's check also handed the page every record
 * of every collection under the collection's own name, declared or not. So
 * `#each (task in tasks)` with no `<data>` block drew its rows here, passed
 * the check (whose name check counted every collection as defined), and was
 * an empty list everywhere the app was run. The page is given what a runtime
 * gives it now, and the check says which line would declare the collection.
 *
 * A page that is imported into another has that page's declarations when it
 * is run, so it has them here when it is looked at on its own.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { EXAMPLES } from '../src/examples';
import { browserEnvironment } from '../src/lib/agent/appCheck';
import { buildGuide } from '../src/lib/agent/guide';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ProjectBrief, VFSFile } from '../src/types/studio';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const vfs = (entries: Record<string, string>) =>
  new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));
const fromList = (entries: Array<{ path: string; content: string }>) => vfs(Object.fromEntries(entries.map((e) => [e.path, e.content])));

const LIST = `  <Heading level={1}>Tasks</Heading>
  #each (item in tasks) key={item.id}
    <Text>{item.data.title}</Text>
  #empty
    <Text>Nothing here</Text>
  #end`;
const project = (page: string, extra: Record<string, string> = {}): Record<string, string> => ({
  // The manifest lists the collection's file, as every export does: that seeds the store, and declares nothing to a page.
  'manifest.json': JSON.stringify({ name: 'Tasks', version: '1.0.0', description: 'Tasks.', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], xdb: ['xdb/tasks.xdb'] } }),
  'ui/main.ui': page,
  'xdb/tasks.xdb': JSON.stringify({ collection: 'tasks', records: [{ id: '1', title: 'Buy milk' }, { id: '2', title: 'Walk the dog' }] }),
  ...extra,
});
const UNDECLARED = `<App theme="light">\n${LIST}\n</App>\n`;
const DECLARED = `<data>\n  <collection name="tasks" as="tasks" />\n</data>\n\n${UNDECLARED}`;

describe('the check of a page that reads a collection', () => {
  it('draws no records for one the page does not declare, and names the line that would declare it', async () => {
    const report = await browserEnvironment.checkApp(vfs(project(UNDECLARED)), { blueprint: null });
    expect(report.rendered).toBe('Tasks Nothing here');
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      'ui/main.ui line 3: tasks is read here, and the project has a collection of that name (xdb/tasks.xdb), but no <data> block declares it for this page, so it is empty when the app runs. Declare it in ui/main.ui, above <App>: <data> <collection name="tasks" as="tasks" /> </data>.',
    ]);
  }, 30_000);

  it('draws them, and says nothing, once the page declares it', async () => {
    const report = await browserEnvironment.checkApp(vfs(project(DECLARED)), { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.rendered).toBe('Tasks Buy milk Walk the dog');
  }, 30_000);

  it('says so when the collection is declared under another name than the one read', async () => {
    const page = `<data>\n  <collection name="tasks" as="items" />\n</data>\n\n${UNDECLARED}`;
    const report = await browserEnvironment.checkApp(vfs(project(page)), { blueprint: null });
    expect(report.rendered).toBe('Tasks Nothing here');
    expect(report.errors).toEqual([
      'ui/main.ui line 7: tasks is read here, but this page binds that collection under another name (<collection name="tasks" as="items" />). Read items, or write as="tasks" on that line.',
    ]);
  }, 30_000);

  it('takes a declaration in a page it imports, as the composer does', async () => {
    const shell = '<import TaskList from="./list.ui" />\n\n<App theme="light">\n  <TaskList />\n</App>\n';
    const list = `<data>\n  <collection name="tasks" as="tasks" />\n</data>\n\n<Stack>\n${LIST}\n</Stack>\n`;
    const report = await browserEnvironment.checkApp(vfs(project(shell, { 'ui/list.ui': list })), { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.rendered).toBe('Tasks Buy milk Walk the dog');
  }, 30_000);
});

describe('the guide, on what a page can read', () => {
  it('says a collection is the page’s only where a <data> block binds it', () => {
    for (const python of [false, true]) {
      expect(buildGuide({ python, torch: false, style: 'clean' })).toMatch(/A page has only the collections a `<data>` block binds for it .* is an empty list to the page/);
    }
  });
});

describe('a page that is imported into another, looked at on its own', () => {
  const shell = '<import TaskList from="./list.ui" />\n\n<data>\n  <collection name="tasks" as="tasks" />\n</data>\n\n<App theme="light">\n  <TaskList />\n</App>\n';
  const list = `<Stack>\n${LIST}\n</Stack>\n`;

  it('has the collections the page that imports it declares, which is what it has when the app runs', async () => {
    const files = vfs(project(shell, { 'ui/list.ui': list }));
    const whole = await browserEnvironment.checkApp(files, { blueprint: null });
    const alone = await browserEnvironment.checkApp(files, { blueprint: null, page: 'ui/list.ui' });
    expect(whole.errors).toEqual([]);
    expect(alone.errors).toEqual([]);
    expect(alone.rendered).toBe('Tasks Buy milk Walk the dog');
  }, 30_000);

  it('has none of them when no page of the app imports it', async () => {
    const files = vfs(project(shell.replace('<import TaskList from="./list.ui" />\n\n', '').replace('  <TaskList />\n', ''), { 'ui/list.ui': list }));
    const alone = await browserEnvironment.checkApp(files, { blueprint: null, page: 'ui/list.ui' });
    expect(alone.rendered).toBe('Tasks Nothing here');
    expect(alone.errors.join('\n')).toMatch(/^ui\/list\.ui line 3: tasks is read here, and the project has a collection of that name/);
  }, 30_000);
});

describe('the pages Studio writes itself', () => {
  const brief: ProjectBrief = { appName: 'Field Notes', description: 'Notes.', target: 'web', pages: ['Home', 'Sites'], collections: ['Notes', 'Sites'], authNeeded: false, style: 'clean', referenceImages: [], logicLanguage: 'javascript' };

  it('declare what they read: the scaffold, whole and one page at a time', async () => {
    const files = fromList(scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief)));
    const whole = await browserEnvironment.checkApp(files, { blueprint: null });
    expect(whole.errors).toEqual([]);
    expect(whole.rendered).toMatch(/Sample title/);
    const home = await browserEnvironment.checkApp(files, { blueprint: null, page: 'ui/pages/home.ui' });
    expect(home.errors).toEqual([]);
    expect(home.rendered).toMatch(/Sample title/);
  }, 30_000);

  it('declare what they read: both bundled examples, the one in Python too', async () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(2);
    for (const example of EXAMPLES) {
      const files = fromList(example.files);
      const whole = await browserEnvironment.checkApp(files, { blueprint: null });
      expect(whole.errors, example.id).toEqual([]);
      expect(whole.rendered, example.id).toMatch(/Piranesi/);
      // One page on its own has what the shell gives it when the app runs: its collections, and
      // its logic. The Python example's page calls the shell's functions, and was told they were
      // not defined when it was checked on its own.
      const home = await browserEnvironment.checkApp(files, { blueprint: null, page: 'ui/pages/home.ui' });
      expect(home.errors, example.id).toEqual([]);
      expect(home.rendered, example.id).toMatch(/Piranesi/);
      if (example.files.some((file) => file.content.includes('def goal_label'))) expect(home.rendered, example.id).toMatch(/Goal: 12 books this year/);
    }
  }, 120_000);
});

describe('the preview of a page that reads a collection', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useWorkspaceStore.getState().reset();
    useVFSStore.getState().reset();
    useWorkspaceStore.setState({ projectId: `undeclared-${Math.random().toString(36).slice(2)}`, projectName: 'Tasks' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const settle = async (ms = 1500) => {
    for (let i = 0; i < ms / 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  };
  const shown = () => container.querySelector('[data-softn-preview-content]')?.textContent ?? '';

  it('shows what the running app will: nothing of a collection the page does not declare', async () => {
    useVFSStore.getState().hydrateFiles(Object.entries(project(UNDECLARED)).map(([path, content]) => ({ path, content })));
    await act(async () => { root.render(<VisualCanvas />); });
    await settle();
    expect(shown()).toContain('Nothing here');
    expect(shown()).not.toContain('Buy milk');

    // Declared: the records are there, without the page being reopened.
    await act(async () => { useVFSStore.getState().updateFile('ui/main.ui', DECLARED, 'user'); });
    await settle();
    expect(shown()).toContain('Buy milk');
    expect(shown()).not.toContain('Nothing here');
  }, 60_000);
});
