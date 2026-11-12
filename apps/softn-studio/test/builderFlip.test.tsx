/** @vitest-environment jsdom */
/**
 * A project goes to the Builder and comes back to the project it left.
 *
 * Asked for as a way to make manual changes to a project made with the AI:
 * open it in the visual editor, change it there, and be back in Studio with
 * the changes in the same project. Pinned here, on Studio's side:
 *
 *  - going saves first, asks about a run that is working the way Home asks,
 *    and hands over the bundle with a digest of every file as Studio holds it;
 *  - what comes back is one step in History, named for where it came from,
 *    which Undo last takes back whole and Redo puts back; the files the
 *    Builder does not name are not touched, and neither are the plan, the
 *    chat or Studio's own notes;
 *  - a file changed here while the Builder had the project is not written
 *    over unless the person says so;
 *  - nothing changed is no step, and a return taken twice (a reload on the
 *    way) changes nothing the second time;
 *  - it is offered only where there is a Builder beside this Studio.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readBundleEntries } from '@softn/core';
import { HANDOFF_DB, HANDOFF_STORE, HANDOFF_TTL_MS, stageBundleHandoff } from '@softn/bundle-format/handoff';
import { sha256Hex } from '@softn/bundle-format/crypto';
import { installFakeIndexedDB, type FakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { TopBar } from '../src/components/toolbar/TopBar';
import { MobileProjectMenu } from '../src/components/mobile/MobileProjectMenu';
import { describeUnit, groupHistory } from '../src/components/panels/HistoryPanel';
import { openExampleInStores } from '../src/examples';
import { READING_LIST } from '../src/examples/readingList';
import { startAgentRun } from '../src/lib/agent/runAgent';
import {
  builderOffered,
  changedMeanwhileQuestion,
  describeReturn,
  flipNavigation,
  planReturn,
  prepareBuilderVisit,
  readBuilderReturn,
  returnStepName,
  takeBuilderReturn,
  useBuilderReturnNotice,
} from '../src/lib/builderFlip';
import { describeFlipFailure, flipFrom, flipTaken, flipUrl, noteFlipTaken, readFlip, removeFlip, stageFlip, withoutFlip, type FlipBack, type FlipRecord } from '../src/lib/flipHandoff';
import { TO_BUILDER, leaveRunQuestion } from '../src/lib/leaveRun';
import { useAIStore, useEditStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import { assertScriptsPassed, fakeProvider, lastRun, resetAgent, say } from './helpers/agentHarness';

const site = vi.hoisted(() => ({ builder: '/builder/', hosted: false }));
vi.mock('../src/lib/siteUrls', () => ({
  get BUILDER_URL() {
    return site.builder;
  },
  RUNTIME_URL: '/web/',
  SITE_URL: '/',
  PUBLISH_URL: '/publish',
}));
vi.mock('@softn/editor-shared/hostedEditor', async (original) => ({
  ...(await original<typeof import('@softn/editor-shared/hostedEditor')>()),
  isHostedEditor: () => site.hosted,
}));

let idb: FakeIndexedDB;
const files = () => useVFSStore.getState().files;
const text = (path: string) => files().get(path)?.content as string;
const digest = (content: string | Uint8Array) => sha256Hex(typeof content === 'string' ? strToU8(content) : content);
const staged = () => [...idb.records(HANDOFF_DB, HANDOFF_STORE).values()] as FlipRecord[];
const saved = async () => ({ failed: null, conflicts: [] as string[] });

beforeEach(() => {
  idb = installFakeIndexedDB();
  site.builder = '/builder/';
  site.hosted = false;
  window.localStorage.clear();
  resetAgent();
  useEditStore.getState().close();
  useBuilderReturnNotice.getState().dismiss();
});

afterEach(() => {
  vi.restoreAllMocks();
  assertScriptsPassed();
  resetAgent();
});

/** What the Builder hands back: its bundle, and what it says of it. Digests are Studio's own, as sent. */
async function builderReturn(projectId: string, bundle: Record<string, string | Uint8Array>, changed: string[], deleted: string[], sent: Record<string, string | Uint8Array>): Promise<string> {
  const flip: FlipBack = { kind: 'return', projectId, changed, deleted, sent: Object.fromEntries(await Promise.all(Object.entries(sent).map(async ([path, content]) => [path, await digest(content)] as const))) };
  const bytes = zipSync(Object.fromEntries(Object.entries(bundle).map(([path, content]) => [path, typeof content === 'string' ? strToU8(content) : content])));
  const id = await stageFlip(bytes, 'Reading list (example)', 'studio', flip);
  expect(id).not.toBeNull();
  return id!;
}

const openProject = vi.fn(async () => ({ ok: true as const }));

describe('the hand-off the two editors share', () => {
  it('is one file, the same in both apps', () => {
    const studio = readFileSync(resolve(process.cwd(), 'src/lib/flipHandoff.ts'), 'utf8');
    const builder = readFileSync(resolve(process.cwd(), '../softn-builder/src/utils/flipHandoff.ts'), 'utf8');
    expect(builder.replace(/\r\n/g, '\n')).toBe(studio.replace(/\r\n/g, '\n'));
  });

  it('is read without being taken, and is gone once the receiver removes it', async () => {
    const id = await stageFlip(strToU8('bundle'), 'Notes', 'builder', { kind: 'open', projectId: 'p1', sent: { 'index.html': 'abc' } });
    const first = await readFlip(id, 'builder');
    expect(first.ok && first.record.flip).toEqual({ kind: 'open', projectId: 'p1', sent: { 'index.html': 'abc' } });
    expect(first.ok && first.record.from).toBe('studio');
    // A reload before the receiver holds the project finds it again.
    expect((await readFlip(id, 'builder')).ok).toBe(true);
    await removeFlip(id!);
    expect(await readFlip(id, 'builder')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('is left for the side it is for, and refused after its ten minutes or when its bytes are not what was staged', async () => {
    const id = await stageFlip(strToU8('bundle'), 'Notes', 'builder', { kind: 'open', projectId: 'p1', sent: {} });
    expect(await readFlip(id, 'studio')).toEqual({ ok: false, reason: 'wrong-destination' });
    expect((await readFlip(id, 'builder')).ok).toBe(true);
    expect(await readFlip(id, 'builder', Date.now() + HANDOFF_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    // A bundle staged for the runtime is the runtime's.
    const run = await stageBundleHandoff(strToU8('bundle'), 'Notes', 'studio', 'runtime');
    expect(await readFlip(run!.id, 'builder')).toEqual({ ok: false, reason: 'wrong-destination' });
    expect(idb.records(HANDOFF_DB, HANDOFF_STORE).has(run!.id)).toBe(true);
    expect(await readFlip(null, 'builder')).toEqual({ ok: false, reason: 'no-id' });
    expect(describeFlipFailure('expired', 'studio')).toMatch(/more than ten minutes.*Open the Builder again.*still there/);
  });

  it('puts the id in the Builder’s address and the project in Studio’s, and takes both out again', () => {
    const out = new URL(flipUrl('/builder/', 'builder', { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }), 'http://site.test');
    expect(out.pathname).toBe('/builder/');
    expect(flipFrom(out.search, 'builder')).toEqual({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', projectId: null });
    expect(flipFrom(out.search, 'studio')).toBeNull();
    const back = new URL(flipUrl('/studio', 'studio', { projectId: 'p-1' }), 'http://site.test');
    expect(back.pathname).toBe('/studio/');
    expect(readBuilderReturn(back.search)).toEqual({ id: null, projectId: 'p-1' });
    expect(readBuilderReturn('?open=x.softn')).toBeNull();
    expect(withoutFlip('?from=builder&project=p-1&handoff=abc&theme=dark')).toBe('?theme=dark');
    expect(withoutFlip(back.search)).toBe('');
  });

  it('notes which return of a project reached Studio', () => {
    expect(flipTaken('p1')).toBeNull();
    noteFlipTaken('p1', 'r1');
    noteFlipTaken('p2', 'r9');
    noteFlipTaken('p1', 'r2');
    expect(flipTaken('p1')).toBe('r2');
    expect(flipTaken('p2')).toBe('r9');
  });
});

describe('Open in Builder', () => {
  it('saves the project, then hands over its bundle with a digest of every file as Studio holds it', async () => {
    const projectId = openExampleInStores(READING_LIST);
    // Studio's own notes are the project's and are not the bundle's.
    useVFSStore.getState().openFiles([...READING_LIST.files, { path: 'builder/requirements.md', content: '# Notes' }]);
    const order: string[] = [];
    const visit = await prepareBuilderVisit({
      save: async () => {
        order.push('saved');
        return saved();
      },
      stage: async (...args) => {
        order.push('staged');
        return stageFlip(...args);
      },
    });
    expect(order).toEqual(['saved', 'staged']);
    expect(visit.ok).toBe(true);
    const [record] = staged();
    expect(record.to).toBe('builder');
    expect(record.from).toBe('studio');
    expect(record.name).toBe('Reading list (example)');
    expect(visit.ok && flipFrom(new URL(visit.url, 'http://site.test').search, 'builder')).toEqual({ id: record.id, projectId: null });
    expect(visit.ok && new URL(visit.url, 'http://site.test').pathname).toBe('/builder/');
    // Every file of the example goes as it is, byte for byte, and the notes stay.
    const entries = readBundleEntries(record.bytes);
    expect([...entries.keys()].sort()).toEqual(READING_LIST.files.map((file) => file.path).sort());
    for (const file of READING_LIST.files) expect(new TextDecoder().decode(entries.get(file.path)), file.path).toBe(file.content);
    const flip = record.flip;
    expect(flip.kind === 'open' && flip.projectId).toBe(projectId);
    expect(Object.keys(flip.sent).sort()).toEqual(READING_LIST.files.map((file) => file.path).sort());
    for (const file of READING_LIST.files) expect(flip.sent[file.path], file.path).toBe(await digest(file.content));
  });

  it('sends the digest of Studio’s own manifest, which is not always the one the bundle carries', async () => {
    openExampleInStores(READING_LIST);
    // A page the manifest does not list yet: the bundle's manifest lists it, Studio's file does not.
    useVFSStore.getState().createFile('pages/extra.html', '<Text>Extra</Text>');
    const own = text('manifest.json');
    await prepareBuilderVisit({ save: saved });
    const [record] = staged();
    const carried = new TextDecoder().decode(readBundleEntries(record.bytes).get('manifest.json'));
    expect(carried).not.toBe(own);
    expect(record.flip.sent['manifest.json']).toBe(await digest(own));
  });

  it('does not go when the project could not be saved, and says why', async () => {
    openExampleInStores(READING_LIST);
    const visit = await prepareBuilderVisit({ save: async () => ({ failed: { reason: 'quota', message: 'This browser’s storage is full.' }, conflicts: [] }) });
    expect(visit).toEqual({ ok: false, stayed: false, message: 'Reading list (example) could not be saved to this browser, so it was not opened in the Builder: This browser’s storage is full.' });
    expect(staged()).toEqual([]);
    const kept = await prepareBuilderVisit({ save: async () => ({ failed: null, conflicts: ['pages/home.html'] }) });
    expect(!kept.ok && !kept.stayed && kept.message).toMatch(/pages\/home\.html was changed in another tab.*save bar/);
    expect(staged()).toEqual([]);
  });

  it('asks about a draft that is not saved, and stays when the answer is no', async () => {
    openExampleInStores(READING_LIST);
    const file = files().get('main.js')!;
    useEditStore.getState().open({ path: 'main.js', text: file.content as string, baseVersion: file.version, baseText: file.content as string });
    useEditStore.getState().change('let changed = true');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(await prepareBuilderVisit({ save: saved })).toEqual({ ok: false, stayed: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(staged()).toEqual([]);
  });

  it('asks about a run that is working, as Home does, and leaves it working when the answer is no', async () => {
    openExampleInStores(READING_LIST);
    useWorkspaceStore.setState({ projectName: 'Tea Log' });
    fakeProvider('anthropic', [{ stall: true }]);
    say('Add a page for finished books');
    const running = startAgentRun();
    await vi.waitFor(() => expect(useAIStore.getState().agentState).toBe('building'));

    const asked: string[] = [];
    const stay = await prepareBuilderVisit({ save: saved, confirm: (question) => { asked.push(question); return false; } });
    expect(stay).toEqual({ ok: false, stayed: true });
    expect(asked).toEqual([leaveRunQuestion('Tea Log', TO_BUILDER)]);
    expect(asked[0]).toMatch(/still working on Tea Log\. Opening the Builder stops it\..*kept.*goes to the Builder.*ask it again when you are back.*Stop the AI and open the Builder\?/s);
    expect(lastRun().run.status).toBe('running');
    expect(staged()).toEqual([]);

    // Yes: stopped as Stop stops it, and only then saved and handed over.
    const order: string[] = [];
    const go = await prepareBuilderVisit({
      confirm: () => true,
      save: async () => {
        order.push(`saved while ${useAIStore.getState().agentState}`);
        return saved();
      },
    });
    await running;
    expect(go.ok).toBe(true);
    expect(order).toEqual(['saved while idle']);
    expect(lastRun().run.status).toBe('stopped');
    expect(staged()).toHaveLength(1);
  });

  it('is not offered inside FormLogic, or where the Builder is on another origin', async () => {
    openExampleInStores(READING_LIST);
    expect(builderOffered()).toBe(true);
    site.hosted = true;
    expect(builderOffered()).toBe(false);
    site.hosted = false;
    site.builder = 'http://localhost:1422';
    expect(builderOffered()).toBe(false);
    const visit = await prepareBuilderVisit({ save: saved });
    expect(!visit.ok && !visit.stayed && visit.message).toMatch(/not beside this Studio.*Export bundle/);
    expect(staged()).toEqual([]);
  });
});

describe('Back to Studio', () => {
  const HOME = READING_LIST.files.find((file) => file.path === 'pages/home.html')!.content;
  const ABOUT = READING_LIST.files.find((file) => file.path === 'pages/about.html')!.content;
  const EDITED = HOME.replace('>Home<', '>Welcome back<');

  it('brings the changes in as one step, named for the Builder, that Undo takes back whole and Redo puts back', async () => {
    const projectId = openExampleInStores(READING_LIST);
    const before = new Map(files());
    const chat = useAIStore.getState().messages;
    const plan = useWorkspaceStore.getState().blueprint;
    const id = await builderReturn(
      projectId,
      { 'pages/home.html': EDITED, 'pages/contact.html': '<Text>Write to us</Text>', 'manifest.json': '{"name":"Reading list"}', 'main.js': 'not named, so not looked at' },
      ['pages/home.html', 'pages/contact.html'],
      ['pages/about.html'],
      { 'pages/home.html': HOME, 'pages/about.html': ABOUT },
    );
    const outcome = await takeBuilderReturn({ projectId, id }, { openProject, save: saved });
    expect(outcome).toMatchObject({ kind: 'applied', step: 'Edited in the Builder: 3 files changed', kept: [], saved: true });
    expect(openProject).not.toHaveBeenCalled();
    expect(text('pages/home.html')).toBe(EDITED);
    expect(text('pages/contact.html')).toBe('<Text>Write to us</Text>');
    expect(files().has('pages/about.html')).toBe(false);
    // What the Builder did not name is the very file it was: not rewritten, not given a new version.
    for (const path of ['manifest.json', 'main.js', 'index.html', 'xdb/books.xdb', 'permission.json', 'assets/icon.svg']) expect(files().get(path), path).toBe(before.get(path));
    // The plan and the chat are the project's, and are as they were.
    expect(useAIStore.getState().messages).toBe(chat);
    expect(useWorkspaceStore.getState().blueprint).toBe(plan);
    // The person's own change, like any other: the AI's next write to it is checked against a new version.
    expect(files().get('pages/home.html')).toMatchObject({ lastModifiedBy: 'user', version: before.get('pages/home.html')!.version + 1 });

    const units = groupHistory(useVFSStore.getState().history);
    expect(units).toHaveLength(1);
    expect(describeUnit(units[0])).toEqual({ title: 'Edited in the Builder: 3 files changed', detail: 'pages/home.html, pages/contact.html, pages/about.html' });
    expect(describeReturn(outcome)).toBe('Back from the Builder: 3 files changed. It is one step in History, and Undo last takes the whole visit back.');

    useVFSStore.getState().undoLast();
    expect(text('pages/home.html')).toBe(HOME);
    expect(text('pages/about.html')).toBe(ABOUT);
    expect(files().has('pages/contact.html')).toBe(false);
    useVFSStore.getState().redoLast();
    expect(text('pages/home.html')).toBe(EDITED);
    expect(files().has('pages/about.html')).toBe(false);
    expect(describeUnit(groupHistory(useVFSStore.getState().history)[0]).title).toBe('Edited in the Builder: 3 files changed');
  });

  it('removes the hand-off only once the project is saved with the changes, and says Studio took it', async () => {
    const projectId = openExampleInStores(READING_LIST);
    const id = await builderReturn(projectId, { 'pages/home.html': EDITED }, ['pages/home.html'], [], { 'pages/home.html': HOME });
    const failing = await takeBuilderReturn({ projectId, id }, { openProject, save: async () => ({ failed: { reason: 'quota', message: 'Full.' }, conflicts: [] }) });
    expect(failing).toMatchObject({ kind: 'applied', saved: false });
    expect(staged().map((record) => record.id)).toEqual([id]);
    expect(flipTaken(projectId)).toBeNull();
    // The reload that follows takes it again: what is here already as the Builder has it is not a second step.
    const again = await takeBuilderReturn({ projectId, id }, { openProject, save: saved });
    expect(again).toEqual({ kind: 'nothing', kept: [] });
    expect(groupHistory(useVFSStore.getState().history)).toHaveLength(1);
    expect(staged()).toEqual([]);
    expect(flipTaken(projectId)).toBe(id);
  });

  it('makes no step when nothing was changed there', async () => {
    const projectId = openExampleInStores(READING_LIST);
    const outcome = await takeBuilderReturn({ projectId, id: null }, { openProject, save: saved });
    expect(outcome).toEqual({ kind: 'nothing', kept: [] });
    expect(describeReturn(outcome)).toBe('Back from the Builder. Nothing was changed there.');
    expect(useVFSStore.getState().history).toEqual([]);
  });

  it('does not write over a file changed here in the meantime unless the person says so', async () => {
    const projectId = openExampleInStores(READING_LIST);
    // Changed in Studio while the Builder had the project: another tab, or a run left working there.
    useVFSStore.getState().hydrateFiles(READING_LIST.files.map((file) => (file.path === 'pages/home.html' ? { ...file, content: HOME.replace('>Home<', '>Shelf<') } : file)));
    const give = () => builderReturn(projectId, { 'pages/home.html': EDITED, 'pages/about.html': ABOUT.replace('About', 'About us') }, ['pages/home.html', 'pages/about.html'], [], { 'pages/home.html': HOME, 'pages/about.html': ABOUT });

    const asked: string[] = [];
    const keep = await takeBuilderReturn({ projectId, id: await give() }, { openProject, save: saved, confirm: (question) => { asked.push(question); return false; } });
    expect(asked).toEqual([changedMeanwhileQuestion(['pages/home.html'])]);
    expect(asked[0]).toMatch(/^pages\/home\.html was changed in Studio while this project was open in the Builder\.\n\nUse the Builder’s version\? Undo last in History puts Studio’s back\. Press Cancel to keep Studio’s version/);
    expect(keep).toMatchObject({ kind: 'applied', step: 'Edited in the Builder: 1 file changed', kept: ['pages/home.html'] });
    expect(text('pages/home.html')).toContain('>Shelf<');
    expect(text('pages/about.html')).toContain('About us');
    expect(describeReturn(keep)).toBe('Back from the Builder: 1 file changed. It is one step in History, and Undo last takes the whole visit back. pages/home.html was left as Studio has it.');

    // Said yes: the Builder's version, in the same one step, which Undo puts back.
    useVFSStore.getState().hydrateFiles(READING_LIST.files.map((file) => (file.path === 'pages/home.html' ? { ...file, content: HOME.replace('>Home<', '>Shelf<') } : file)));
    const take = await takeBuilderReturn({ projectId, id: await give() }, { openProject, save: saved, confirm: () => true });
    expect(take).toMatchObject({ kind: 'applied', step: 'Edited in the Builder: 2 files changed', kept: [] });
    expect(text('pages/home.html')).toBe(EDITED);
    useVFSStore.getState().undoLast();
    expect(text('pages/home.html')).toContain('>Shelf<');
  });

  it('holds a deletion and a new file to the same rule', async () => {
    const projectId = openExampleInStores(READING_LIST);
    useVFSStore.getState().hydrateFiles([
      ...READING_LIST.files.map((file) => (file.path === 'pages/about.html' ? { ...file, content: `${ABOUT}<!-- edited here -->` } : file)),
      { path: 'pages/contact.html', content: '<Text>Made in Studio</Text>' },
    ]);
    const flip: FlipBack = { kind: 'return', projectId, changed: ['pages/contact.html', 'Pages/Home.html'], deleted: ['pages/about.html', 'main.js'], sent: { 'pages/about.html': await digest(ABOUT), 'main.js': await digest(text('main.js')), 'Pages/Home.html': await digest(HOME) } };
    const plan = await planReturn(files(), flip, new Map([['pages/contact.html', strToU8('<Text>Made in the Builder</Text>')], ['Pages/Home.html', strToU8(EDITED)]]));
    // A file both made, and a file deleted there that was changed here: asked about.
    expect(plan.conflicts.map((conflict) => [conflict.path, conflict.record.op])).toEqual([['pages/contact.html', 'update'], ['pages/about.html', 'delete']]);
    // Another spelling of a file Studio has is that file, under Studio's spelling.
    expect(plan.records).toEqual([{ op: 'update', path: 'pages/home.html', content: EDITED }, { op: 'delete', path: 'main.js' }]);
  });

  it('never takes a file into builder/, which holds Studio’s own notes, and keeps bytes as bytes', async () => {
    const projectId = openExampleInStores(READING_LIST);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const flip: FlipBack = { kind: 'return', projectId, changed: ['builder/blueprint.json', 'assets/photo.png', '../escape.txt', 'pages/missing.html'], deleted: [], sent: {} };
    const plan = await planReturn(files(), flip, new Map([['builder/blueprint.json', strToU8('{}')], ['assets/photo.png', png], ['../escape.txt', strToU8('x')]]));
    expect(plan.records).toEqual([{ op: 'create', path: 'assets/photo.png', content: png }]);
    expect(plan.skipped.map((skipped) => skipped.path)).toEqual(['builder/blueprint.json', '../escape.txt', 'pages/missing.html']);
  });

  it('opens the project the return is of when another is open, and opens the work as a new project when that one is gone', async () => {
    openExampleInStores(READING_LIST);
    const id = await builderReturn('another-project', { 'pages/home.html': EDITED, 'manifest.json': '{}' }, ['pages/home.html'], [], { 'pages/home.html': HOME });
    const gone = vi.fn(async () => ({ ok: false as const, message: 'There is no saved copy of that project in this browser.' }));
    const imported: string[] = [];
    const outcome = await takeBuilderReturn({ projectId: 'another-project', id }, {
      openProject: gone,
      save: saved,
      importBundle: async (bytes, name) => {
        imported.push(`${name}: ${[...readBundleEntries(bytes).keys()].join(', ')}`);
        return { ok: true };
      },
    });
    expect(gone).toHaveBeenCalledWith('another-project');
    expect(imported).toEqual(['Reading list (example): pages/home.html, manifest.json']);
    expect(outcome).toEqual({ kind: 'imported', name: 'Reading list (example)' });
    expect(staged()).toEqual([]);
    // The project that was open is as it was.
    expect(text('pages/home.html')).toBe(HOME);
    expect(useVFSStore.getState().history).toEqual([]);
  });

  it('says what happened to a return that is not there', async () => {
    const projectId = openExampleInStores(READING_LIST);
    const outcome = await takeBuilderReturn({ projectId, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { openProject, save: saved });
    expect(outcome.kind).toBe('failed');
    expect(describeReturn(outcome)).toMatch(/Nothing from the Builder is waiting here.*Open the Builder again and choose Back to Studio: your changes are still there\./);
    expect(returnStepName(1)).toBe('Edited in the Builder: 1 file changed');
  });
});

describe('the control', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const button = () => container.querySelector<HTMLButtonElement>('[data-action="open-in-builder"]');

  it('is in the project’s bar, saves and stages, and takes this tab to the Builder', async () => {
    openExampleInStores(READING_LIST);
    const go = vi.spyOn(flipNavigation, 'go').mockImplementation(() => undefined);
    act(() => root.render(<TopBar />));
    expect(button()?.textContent).toBe('Open in Builder');
    expect(button()?.disabled).toBe(false);
    await act(async () => {
      button()!.click();
      await vi.waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    });
    const [record] = staged();
    expect(go.mock.calls[0][0]).toBe(`/builder/?from=studio&handoff=${record.id}`);
    // On its way out: not pressed twice.
    expect(button()?.textContent).toBe('Opening…');
    expect(button()?.disabled).toBe(true);
  });

  it('says why in the bar when the project stays, and is ready to be pressed again', async () => {
    openExampleInStores(READING_LIST);
    const go = vi.spyOn(flipNavigation, 'go').mockImplementation(() => undefined);
    // A file at the bundle's root that no bundle can hold: the export refuses it, and so does this.
    useVFSStore.getState().createFile('assets/version..png', 'x');
    act(() => root.render(<TopBar />));
    await act(async () => {
      button()!.click();
      // (The bar is drawn again when this ends; the log has it as soon as it is said.)
      await vi.waitFor(() => expect(useWorkspaceStore.getState().consoleOutput.join('\n')).toContain('could not be made into a bundle'));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/could not be made into a bundle for the Builder/);
    expect(go).not.toHaveBeenCalled();
    expect(button()?.textContent).toBe('Open in Builder');
    expect(button()?.disabled).toBe(false);
  });

  it('is not drawn where there is no Builder beside this Studio', () => {
    openExampleInStores(READING_LIST);
    site.builder = 'http://localhost:1422';
    act(() => root.render(<TopBar />));
    expect(button()).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    site.builder = '/builder/';
    site.hosted = true;
    act(() => root.render(<TopBar />));
    expect(button()).toBeNull();
  });

  it('is in the project menu on a phone', () => {
    openExampleInStores(READING_LIST);
    act(() => root.render(<MobileProjectMenu />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')!.click());
    const items = Array.from(container.querySelectorAll('[role="menuitem"]')).map((item) => item.querySelector('span')?.textContent);
    expect(items).toEqual(['Run', 'Publish', 'Export bundle', 'Open in Builder']);
    site.builder = 'http://localhost:1422';
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<MobileProjectMenu />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')!.click());
    expect(Array.from(container.querySelectorAll('[role="menuitem"]')).map((item) => item.querySelector('span')?.textContent)).toEqual(['Run', 'Publish', 'Export bundle']);
  });

  it('says in the bar what a return brought in, until it is dismissed', () => {
    openExampleInStores(READING_LIST);
    act(() => root.render(<TopBar />));
    expect(container.querySelector('[data-builder-return]')).toBeNull();
    act(() => useBuilderReturnNotice.getState().say({ kind: 'applied', step: returnStepName(2), paths: ['a', 'b'], kept: [], skipped: [], saved: true }));
    const note = container.querySelector('[data-builder-return="taken"]')!;
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toContain('Back from the Builder: 2 files changed.');
    act(() => note.querySelector('button')!.click());
    expect(container.querySelector('[data-builder-return]')).toBeNull();
    act(() => useBuilderReturnNotice.getState().say({ kind: 'failed', message: 'It could not be read.' }));
    expect(container.querySelector('[data-builder-return="failed"]')?.getAttribute('role')).toBe('alert');
  });
});
