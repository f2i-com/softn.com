/** @vitest-environment jsdom */
/**
 * The check and the preview give a page its data the way a runtime does.
 *
 * Wherever an app is run, its `<data>` block is what binds its collections:
 * each under the name `as` gives it, filtered, sorted and cut to `limit` as
 * the block says. Studio's preview and the agent's check drew the page with
 * the plain renderer instead, handing it every record of every collection
 * under the collection's own name. The two agree only for
 * `<collection name="tasks" as="tasks" />` with nothing else on it. A
 * collection read under another name was an empty list here and a full one
 * when run; and the guide's own line, `sort="created_at:desc" limit={50}`
 * with `filter={{ done: false }}`, was ignored: the agent asked for the
 * tasks not done, checked, and was shown them all.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { browserEnvironment } from '../src/lib/agent/appCheck';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import type { VFSFile } from '../src/types/studio';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const RECORDS = [
  { id: '1', title: 'Delta', done: false },
  { id: '2', title: 'Alpha', done: true },
  { id: '3', title: 'Charlie', done: false },
  { id: '4', title: 'Bravo', done: false },
];
const page = (collection: string, list: string) => `<data>
  ${collection}
</data>

<App theme="light">
  <Heading level={1}>Tasks</Heading>
  #each (item in ${list}) key={item.id}
    <Text>{item.data.title}</Text>
  #empty
    <Text>Nothing here</Text>
  #end
</App>
`;
const project = (collection: string, list: string): Record<string, string> => ({
  'manifest.json': JSON.stringify({ name: 'Tasks', version: '1.0.0', description: 'Tasks.', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], xdb: ['xdb/tasks.xdb'] } }),
  'ui/main.ui': page(collection, list),
  'xdb/tasks.xdb': JSON.stringify({ collection: 'tasks', records: RECORDS }),
});
const vfs = (entries: Record<string, string>) =>
  new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

describe('the agent’s check of a page with a <data> block', () => {
  it('shows a collection under the name the block gives it', async () => {
    const report = await browserEnvironment.checkApp(vfs(project('<collection name="tasks" as="items" />', 'items')), { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.rendered).toBe('Tasks Delta Alpha Charlie Bravo');
  }, 30_000);

  it('filters, sorts and limits as the block says, which is the guide’s own line', async () => {
    const report = await browserEnvironment.checkApp(vfs(project('<collection name="tasks" as="tasks" filter={{ done: false }} sort="title:asc" limit={2} />', 'tasks')), { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.rendered).toBe('Tasks Bravo Charlie');
  }, 30_000);

  it('says the same to inspect_preview', async () => {
    const seen = await browserEnvironment.inspectPreview(vfs(project('<collection name="tasks" as="items" filter={{ done: true }} />', 'items')));
    expect(seen.text).toContain('text: Alpha');
    expect(seen.text).not.toMatch(/Delta|Nothing here/);
  }, 30_000);

  // The blocks of a page may come in any order. One written with its template first and its
  // <data> and <style> after it is read the same: checked, bound, styled, and its names known.
  it('reads a page whose <data> and <style> blocks come after its template', async () => {
    const after = `<App theme="light">
  <Heading level={1}>Tasks</Heading>
  #each (item in items) key={item.id}
    <Text className="row">{item.data.title}</Text>
  #end
</App>

<data>
  <collection name="tasks" as="items" filter={{ done: true }} />
</data>

<style>
.row { letter-spacing: 3px; }
</style>
`;
    const files = vfs({ ...project('<collection name="tasks" as="items" />', 'items'), 'ui/main.ui': after });
    const report = await browserEnvironment.checkApp(files, { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.warnings.filter((w) => !/manifest\.json|permission\.json/.test(w))).toEqual([]);
    expect(report.rendered).toBe('Tasks Alpha');
  }, 30_000);

  it('starts each check from the project’s records, not from what the check before it left', async () => {
    const files = vfs(project('<collection name="tasks" as="items" />', 'items'));
    const first = await browserEnvironment.checkApp(files, { blueprint: null });
    const fewer = vfs({ ...project('<collection name="tasks" as="items" />', 'items'), 'xdb/tasks.xdb': JSON.stringify({ collection: 'tasks', records: RECORDS.slice(0, 1) }) });
    const second = await browserEnvironment.checkApp(fewer, { blueprint: null });
    expect(first.rendered).toBe('Tasks Delta Alpha Charlie Bravo');
    expect(second.rendered).toBe('Tasks Delta');
  }, 30_000);
});

describe('the preview of a page with a <data> block', () => {
  let root: Root;
  let container: HTMLDivElement;
  const Frame = ({ children }: PropsWithChildren) => <div>{children}</div>;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useWorkspaceStore.getState().reset();
    useVFSStore.getState().reset();
    useWorkspaceStore.setState({ projectId: `data-block-${Math.random().toString(36).slice(2)}`, projectName: 'Tasks' });
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
  const shown = () => [...container.querySelectorAll('[data-softn-preview-content] p, [data-softn-preview-content] span')].map((el) => el.textContent?.trim()).filter((text) => /^(Alpha|Bravo|Charlie|Delta|Nothing here)$/.test(text ?? ''));

  it('shows what the running app will: the alias, the filter, the order and the limit', async () => {
    useVFSStore.getState().hydrateFiles(Object.entries(project('<collection name="tasks" as="items" filter={{ done: false }} sort="title:asc" limit={2} />', 'items')).map(([path, content]) => ({ path, content })));
    await act(async () => { root.render(<Frame><VisualCanvas /></Frame>); });
    await settle();
    expect([...new Set(shown())]).toEqual(['Bravo', 'Charlie']);
  }, 60_000);
});
