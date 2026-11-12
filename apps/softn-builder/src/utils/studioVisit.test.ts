// @vitest-environment jsdom
/**
 * A project made in Studio is opened here, changed by hand, and taken back.
 *
 * Asked for as a way across from AI Studio, "enabling for people to make
 * further manual changes if needed". Driven first with Studio's two bundled
 * examples and a larger project of the kind a run leaves (several pages, a
 * plain HTML page, HTML among components, pictures, a helper, a server
 * file), in JavaScript and in Python, to see what the Builder does to a
 * project it is only shown.
 *
 * What it does, and so what is held here:
 *
 *  - opened and written out with nothing changed, every file leaves as it
 *    came, byte for byte, and looking at each page changes none of them;
 *  - one edit on a page changes that page's file and no other;
 *  - a stored session does not carry the .xdb files as they came, and
 *    writes each collection anew after a reload: the visit keeps them, so
 *    a reload half way does not send back a change nobody made;
 *  - "Back to Studio" names for Studio only the files that changed, and
 *    nothing at all where nothing did; Studio brings them into the project
 *    they left, as one step;
 *  - going back and forth again opens Studio's copy, not what the Builder
 *    had before, unless that was work Studio never got, and then the person
 *    is asked;
 *  - a reload half way opens the same project, with what was changed, and
 *    its way back.
 *
 * Studio's side is its own code, run here as it runs there: what the two
 * editors agree on is held by running them against each other.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBundleEntries } from '@softn/core';
import { HANDOFF_DB, HANDOFF_STORE } from '@softn/bundle-format/handoff';
import { installFakeIndexedDB, type FakeIndexedDB } from '../../../../packages/@softn/test-utils/src/fake-indexeddb';
import { StudioOrigin } from '../components/toolbar/StudioOrigin';
import { useProjectStartup } from '../hooks/useProjectStartup';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle, flushCanvasToActiveFile } from './buildProjectBundle';
import { flipTaken, type FlipRecord } from './flipHandoff';
import { SESSION_STORAGE_KEY, captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot, recoveryOf, startupAction, takeOpenedFromLink } from './openProject';
import { writeRecoveryCopy } from './recoveryCopy';
import { resetPersistedRevisions } from './saveProject';
import { SESSION_ASSETS_KEY, resetRefusedAssets } from './storedAssets';
import { LINK_DB, LINK_STORE, TAB_VISIT_KEY, isVisitWorkspace, openVisit, readTabVisit, sessionWorkspace, useStudioVisitStore, type StudioVisit } from './studioLink';
import { backToStudio, startFromStudio, studioOffered, type Arrival, type VisitDeps } from './studioVisit';
// Studio, as it is.
import { openExampleInStores } from '../../../softn-studio/src/examples';
import { READING_LIST } from '../../../softn-studio/src/examples/readingList';
import { READING_LIST_PYTHON } from '../../../softn-studio/src/examples/readingListPython';
import { groupHistory, describeUnit } from '../../../softn-studio/src/components/panels/HistoryPanel';
import { prepareBuilderVisit, readBuilderReturn, takeBuilderReturn } from '../../../softn-studio/src/lib/builderFlip';
import { buildBundle } from '../../../softn-studio/src/lib/exportBundle';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../../../softn-studio/src/lib/studioProject';
import { useVFSStore as useStudioFiles, useWorkspaceStore as useStudioWorkspace } from '../../../softn-studio/src/stores';

const site = vi.hoisted(() => ({ studio: '/studio/' }));
vi.mock('./siteUrls', () => ({
  get STUDIO_URL() {
    return site.studio;
  },
  RUNTIME_URL: '/web/',
  SITE_URL: '/',
  PRODUCT_URLS: undefined,
}));
vi.mock('../../../softn-studio/src/lib/siteUrls', () => ({ BUILDER_URL: '/builder/', RUNTIME_URL: '/web/', SITE_URL: '/', PUBLISH_URL: '/publish' }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

type Entry = { path: string; content: string | Uint8Array };

let idb: FakeIndexedDB;
const decoder = new TextDecoder();
const text = (bytes: Uint8Array | undefined) => (bytes ? decoder.decode(bytes) : '(absent)');
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !!a && !!b && a.length === b.length && a.every((byte, at) => byte === b[at]);
const exported = async () => readBundleEntries(await buildProjectBundle());
const staged = () => [...idb.records(HANDOFF_DB, HANDOFF_STORE).values()] as FlipRecord[];
const visits = () => [...idb.records(LINK_DB, LINK_STORE).values()] as StudioVisit[];
const stored = () => window.localStorage.getItem(SESSION_STORAGE_KEY);
const saved = async () => ({ failed: null, conflicts: [] as string[] });
const deps: VisitDeps = { apply: commitProjectSnapshot, ask: async () => true };
const page = (path: string) => [...useFilesStore.getState().uiFiles.values()].find((file) => file.path === path)!;

/** The paths whose bytes differ between two sets of files, and those only one has. */
function differences(before: ReadonlyMap<string, Uint8Array>, after: ReadonlyMap<string, Uint8Array>): string[] {
  const out: string[] = [];
  for (const [path, bytes] of before) if (!after.has(path)) out.push(`- ${path}`); else if (!same(bytes, after.get(path))) out.push(`~ ${path}`);
  for (const path of after.keys()) if (!before.has(path)) out.push(`+ ${path}`);
  return out.sort();
}

/** The Builder as a page that has just loaded finds it: an empty project, nothing of the last page in memory. */
function freshPage(address = '/builder/'): void {
  // (First, so that the project going away is not taken for the person leaving the visit: a new page has no visit.)
  useStudioVisitStore.setState({ visit: null, arriving: false, problem: null });
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  useHistoryStore.getState().clear();
  useNotificationStore.getState().clearAll();
  takeOpenedFromLink();
  resetPersistedRevisions();
  window.history.replaceState(null, '', address);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  idb = installFakeIndexedDB();
  site.studio = '/studio/';
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetRefusedAssets();
  freshPage();
  useStudioFiles.getState().reset();
  useStudioWorkspace.getState().reset();
});

afterEach(() => vi.restoreAllMocks());

// --- Studio's projects ----------------------------------------------------------------

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

const LANDING = `<!-- A plain HTML page, as a person would write one. -->
<section class="hero">
  <h1>Field trips, <em>planned</em></h1>
  <p>See where we are going &amp; sign up.</p>
  <img src="assets/photos/harbour.png" alt="The harbour">
  <a href="https://example.com/terms" target="_blank" rel="noopener">Terms</a>
  <ul>
    <li>One</li>
    <li>Two</li>
  </ul>
  <table>
    <thead><tr><th>Trip</th><th>Date</th></tr></thead>
    <tbody><tr><td>Harbour</td><td>3 May</td></tr></tbody>
  </table>
  <br>
  <input type="text" placeholder="Your name" :value={name}>
</section>
<style>
  .hero { text-align: center }
</style>
`;

const MIXED = `<Stack direction="vertical" gap="md">
  <Heading level={2}>Mixed</Heading>
  <div class="note" style="border:1px solid #ccc;padding:8px">
    <p>HTML inside a <strong>component</strong> page.</p>
    <Button variant="primary" @click={() => go("home")}>Go home</Button>
  </div>
  #if (trips.length > 3)
    <Badge>Busy season</Badge>
  #else
    <Text variant="muted">Quiet</Text>
  #end
  <img src="assets/photos/museum.jpg" alt="Museum" width="320">
</Stack>
`;

/** A project as a run leaves one: Studio's scaffold for the brief, and what an agent adds to it. */
function larger(language: 'javascript' | 'python'): Entry[] {
  const brief = {
    appName: 'Field Trips', description: 'Plan school trips, with a gallery and a sign-up sheet.', target: 'web' as const,
    pages: ['Home', 'Trips', 'Gallery', 'Sign up', 'About us'], collections: ['trips', 'signups'], authNeeded: false, style: 'clean' as const,
    logicLanguage: language, referenceImages: [],
  };
  const files: Entry[] = scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief));
  const manifest = JSON.parse(files.find((file) => file.path === 'manifest.json')!.content as string) as { files: { ui: string[]; logic: string[]; assets: string[] } };
  files.push({ path: 'assets/photos/harbour.png', content: PNG }, { path: 'assets/photos/museum.jpg', content: JPEG });
  files.push({ path: 'assets/site.css', content: '.hero { padding: 48px 24px; }\n.hero h1 { font-size: 2.4rem; }\n' });
  files.push({ path: 'pages/landing.html', content: LANDING }, { path: 'pages/mixed.html', content: MIXED });
  manifest.files.ui.push('pages/landing.html', 'pages/mixed.html');
  manifest.files.assets.push('assets/photos/harbour.png', 'assets/photos/museum.jpg', 'assets/site.css');
  if (language === 'javascript') {
    files.push({ path: 'lib/format.js', content: 'function shortDate(value) {\n  return String(value).slice(0, 10)\n}\n' });
    manifest.files.logic.unshift('lib/format.js');
    files.push({ path: 'server/api.logic', content: 'function listTrips() {\n  return db.query("trips")\n}\n' });
  } else {
    files.push({ path: 'dates.py', content: 'def short_date(value):\n    return str(value)[:10]\n' });
    manifest.files.logic.unshift('dates.py');
  }
  files.push({ path: 'README.md', content: '# Field Trips\n\nNotes for whoever opens this.\n' });
  files.find((file) => file.path === 'manifest.json')!.content = JSON.stringify(manifest, null, 2);
  return files;
}

const PROJECTS: Array<[string, () => Entry[]]> = [
  ['Studio’s example', () => READING_LIST.files],
  ['Studio’s example in Python', () => READING_LIST_PYTHON.files],
  ['a larger project in JavaScript', () => larger('javascript')],
  ['a larger project in Python', () => larger('python')],
];

/** The bundle Studio makes of a project's files (its export, which is what it hands over). */
function studioBundle(files: Entry[]): Uint8Array {
  return buildBundle(new Map(files.map((file) => [file.path, { path: file.path, content: file.content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user' as const, version: 1 }])));
}

/** Put a page on the canvas, as choosing it in Files does. */
function show(path: string): void {
  flushCanvasToActiveFile();
  const file = page(path);
  useFilesStore.getState().setActiveFile(file.id);
  useCanvasStore.getState().loadState(file.elements, file.rootId, file.imports ?? [], file.writtenImports ?? [], file.id);
}

/** Change the heading of a page and add a component under it: a small edit made by hand. */
function editHome(words = 'Welcome back'): void {
  show('pages/home.html');
  const canvas = useCanvasStore.getState();
  const heading = [...canvas.elements.values()].find((element) => element.componentType === 'Heading')!;
  canvas.updateElementProps(heading.id, { children: words });
  const added = canvas.addElement('Button', heading.parentId, undefined, { starter: true });
  canvas.updateElementProps(added, { children: 'Add a book' });
  flushCanvasToActiveFile();
}

describe('a Studio project the Builder is only shown', () => {
  it.each(PROJECTS)('%s leaves as it came, byte for byte, after every page has been looked at', async (_name, make) => {
    const input = readBundleEntries(studioBundle(make()));
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(studioBundle(make()))));
    expect(differences(input, await exported())).toEqual([]);
    for (const file of [...useFilesStore.getState().uiFiles.values()]) show(file.path);
    flushCanvasToActiveFile();
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(differences(input, await exported())).toEqual([]);
  });

  it.each(PROJECTS)('%s has one file changed by one edit on a page: that page', async (_name, make) => {
    const input = readBundleEntries(studioBundle(make()));
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(studioBundle(make()))));
    editHome();
    const output = await exported();
    expect(differences(input, output)).toEqual(['~ pages/home.html']);
    expect(text(output.get('pages/home.html'))).toContain('<Heading level={2}>Welcome back</Heading>');
    expect(text(output.get('pages/home.html'))).toContain('Add a book');
  });

  it('writes its collections anew after a stored session is restored, which is why a visit keeps the .xdb files as they came', async () => {
    const input = readBundleEntries(studioBundle(READING_LIST.files));
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(studioBundle(READING_LIST.files))));
    commitProjectSnapshot(prepareSessionSnapshot(JSON.stringify(captureSession('design'))));
    expect(differences(input, await exported())).toEqual(['~ xdb/books.xdb']);
  });
});

// --- Across and back --------------------------------------------------------------------

/** Studio: open the example, and hand it to the Builder. Answers the project, and the address the tab goes to. */
async function fromStudio(): Promise<{ projectId: string; url: string }> {
  const projectId = useStudioWorkspace.getState().projectId || openExampleInStores(READING_LIST);
  const visit = await prepareBuilderVisit({ save: saved });
  if (!visit.ok) throw new Error('Studio did not hand the project over');
  return { projectId, url: visit.url };
}

/** The Builder: a page loaded at `url`, started as the app starts it. */
async function arrive(url: string, with_: Partial<VisitDeps> = {}): Promise<Arrival> {
  freshPage(url);
  const action = startupAction(window.location, window.history, stored(), { tab: readTabVisit(), visitSession: isVisitWorkspace(sessionWorkspace(stored())?.workspace ?? null) });
  if (action.kind !== 'from-studio') throw new Error(`The start was ${action.kind}`);
  return startFromStudio(action, { ...deps, ...with_ });
}

/** The Builder: Back to Studio. Answers the address the tab goes to. */
async function goBack(): Promise<string> {
  let url = '';
  const left = await backToStudio('design', { navigate: (to) => { url = to; } });
  expect(left.kind).toBe('left');
  return url;
}

/** Studio: a page loaded at the address the Builder sent the tab to. */
function comeBack(url: string, confirm: (question: string) => boolean = () => true) {
  const back = readBuilderReturn(new URL(url, 'http://site.test').search);
  if (!back) throw new Error('Not an address the Builder made');
  return takeBuilderReturn(back, { openProject: async () => ({ ok: true }), save: saved, confirm });
}

const studioText = (path: string) => useStudioFiles.getState().files.get(path)?.content as string;

describe('from Studio to the Builder and back', () => {
  it('opens Studio’s project as the Builder’s own, says where it came from, and keeps it for a reload', async () => {
    const { projectId, url } = await fromStudio();
    expect(staged()).toHaveLength(1);
    const arrival = await arrive(url);
    expect(arrival).toEqual({ kind: 'opened', name: 'Reading list (example)' });
    // The Builder's project: named as its manifest names the app, saved and exported as any other.
    expect(useProjectStore.getState().name).toBe('Reading list');
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(page('pages/home.html').originalSource).toBe(READING_LIST.files.find((file) => file.path === 'pages/home.html')!.content);
    // Where it came from, and the way back.
    expect(openVisit()).toMatchObject({ projectId, name: 'Reading list (example)', workspace: useProjectStore.getState().projectId, returned: null });
    // Kept, so the hand-off is taken out of the store and out of the address.
    expect(staged()).toEqual([]);
    expect(visits().map((visit) => visit.projectId)).toEqual([projectId]);
    expect(window.location.search).toBe('');
    expect(readTabVisit()).toEqual({ projectId, visit: openVisit()!.visit });
    // What "nothing changed" is: the files as they came are the files as the Builder writes them.
    expect(openVisit()!.opened).toEqual(openVisit()!.came);
    expect(Object.keys(openVisit()!.came).sort()).toEqual(READING_LIST.files.map((file) => file.path).sort());
  });

  it('takes nothing back where nothing was changed, and Studio makes no step', async () => {
    const { projectId, url } = await fromStudio();
    await arrive(url);
    for (const file of [...useFilesStore.getState().uiFiles.values()]) show(file.path);
    const back = await goBack();
    expect(back).toBe(`/studio/?from=builder&project=${projectId}`);
    expect(staged()).toEqual([]);
    expect(await comeBack(back)).toEqual({ kind: 'nothing', kept: [] });
    expect(useStudioFiles.getState().history).toEqual([]);
    expect(studioText('pages/home.html')).toBe(READING_LIST.files.find((file) => file.path === 'pages/home.html')!.content);
  });

  it('takes back the page that was changed and nothing else, as one step Studio can undo and redo', async () => {
    const { projectId, url } = await fromStudio();
    const before = new Map(useStudioFiles.getState().files);
    await arrive(url);
    editHome();
    expect(useProjectStore.getState().isDirty).toBe(true);

    const back = await goBack();
    const [record] = staged();
    expect(record).toMatchObject({ to: 'studio', from: 'builder', name: 'Reading list (example)' });
    expect(record.flip).toEqual({ kind: 'return', projectId, changed: ['pages/home.html'], deleted: [], sent: { 'pages/home.html': openVisit()!.sent['pages/home.html'] } });
    expect(back).toBe(`/studio/?from=builder&project=${projectId}&handoff=${record.id}`);
    // Handed back is saved: nothing here is unsaved, and the stored copy is not offered as work that was lost.
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(recoveryOf(stored()!)).toBeNull();
    // The tab has left the visit.
    expect(readTabVisit()).toBeNull();

    const outcome = await comeBack(back);
    expect(outcome).toMatchObject({ kind: 'applied', step: 'Edited in the Builder: 1 file changed', paths: ['pages/home.html'], kept: [] });
    expect(studioText('pages/home.html')).toContain('<Heading level={2}>Welcome back</Heading>');
    expect(studioText('pages/home.html')).toContain('Add a book');
    for (const [path, file] of before) if (path !== 'pages/home.html') expect(useStudioFiles.getState().files.get(path), path).toBe(file);
    const units = groupHistory(useStudioFiles.getState().history);
    expect(units.map((unit) => describeUnit(unit).title)).toEqual(['Edited in the Builder: 1 file changed']);
    useStudioFiles.getState().undoLast();
    expect(studioText('pages/home.html')).toBe(before.get('pages/home.html')!.content);
    useStudioFiles.getState().redoLast();
    expect(studioText('pages/home.html')).toContain('Welcome back');
    // Studio has it: said where the Builder will look.
    expect(staged()).toEqual([]);
    expect(flipTaken(projectId)).toBe(record.id);
  });

  it('takes back a file that was added, one that was taken out, and the manifest that lists them', async () => {
    const { url } = await fromStudio();
    const ownManifest = studioText('manifest.json');
    await arrive(url);
    const files = useFilesStore.getState();
    files.createFile('pages', 'contact.html', 'ui');
    // Nothing uses the About page once the entry page no longer imports it.
    const entry = page('index.html');
    files.updateUIFileSource(entry.id, entry.originalSource!.replace('<import AboutPage from="./pages/about.html" />\n', '').replace('        <AboutPage />\n', '<Text>About</Text>\n'));
    useFilesStore.getState().deleteFile(page('pages/about.html').id);
    const back = await goBack();
    const flip = staged()[0].flip;
    expect(flip.kind === 'return' && [...flip.changed].sort()).toEqual(['index.html', 'manifest.json', 'pages/contact.html']);
    expect(flip.kind === 'return' && flip.deleted).toEqual(['pages/about.html']);
    const outcome = await comeBack(back);
    expect(outcome).toMatchObject({ kind: 'applied', step: 'Edited in the Builder: 4 files changed' });
    expect(useStudioFiles.getState().files.has('pages/about.html')).toBe(false);
    expect(useStudioFiles.getState().files.has('pages/contact.html')).toBe(true);
    // Studio's manifest was the one it sent, so it takes the Builder's, which lists the new page.
    expect(studioText('manifest.json')).not.toBe(ownManifest);
    expect((JSON.parse(studioText('manifest.json')) as { files: { ui: string[] } }).files.ui).toEqual(['index.html', 'pages/home.html', 'pages/contact.html']);
  });

  it('asks in Studio about a file changed there while the Builder had the project', async () => {
    const { url } = await fromStudio();
    await arrive(url);
    editHome();
    const back = await goBack();
    // Meanwhile, in Studio: another tab, or a run left working.
    useStudioFiles.getState().updateFile('pages/home.html', '<Text>Changed in Studio</Text>', 'ai');
    const asked: string[] = [];
    const outcome = await comeBack(back, (question) => { asked.push(question); return false; });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^pages\/home\.html was changed in Studio while this project was open in the Builder\./);
    expect(outcome).toEqual({ kind: 'nothing', kept: ['pages/home.html'] });
    expect(studioText('pages/home.html')).toBe('<Text>Changed in Studio</Text>');
  });

  it('goes again with Studio’s copy, and without a word about what the Builder had before', async () => {
    const first = await fromStudio();
    await arrive(first.url);
    editHome();
    await comeBack(await goBack());
    // In Studio: the AI goes on from the hand edit.
    useStudioFiles.getState().updateFile('pages/about.html', '<Text>About, by the AI</Text>', 'ai');

    const second = await fromStudio();
    const ask = vi.fn(async () => true);
    const arrival = await arrive(second.url, { ask });
    expect(arrival.kind).toBe('opened');
    expect(ask).not.toHaveBeenCalled();
    expect(page('pages/about.html').originalSource).toBe('<Text>About, by the AI</Text>');
    expect(page('pages/home.html').originalSource).toContain('Welcome back');
    // One visit for the project, the new one: no second copy to open by mistake.
    expect(visits()).toHaveLength(1);
    expect(visits()[0].visit).toBe(openVisit()!.visit);
    // A second edit comes back as a second step, of that edit alone.
    editHome('Welcome again');
    const outcome = await comeBack(await goBack());
    expect(outcome).toMatchObject({ kind: 'applied', paths: ['pages/home.html'] });
    expect(groupHistory(useStudioFiles.getState().history).map((unit) => describeUnit(unit).title)).toEqual(['Edited in the Builder: 1 file changed', 'AI · Edited', 'Edited in the Builder: 1 file changed']);
    // And nothing was set aside on the way: the Builder's stored copy was work Studio already had.
    expect(useNotificationStore.getState().notifications.map((notification) => notification.message)).toEqual([]);
  });

  it('asks before opening Studio’s copy over work that never went back', async () => {
    const first = await fromStudio();
    await arrive(first.url);
    editHome('Only in the Builder');
    // Kept as unsaved work, and the tab is gone without Back to Studio.
    expect(writeRecoveryCopy({ view: 'design' }).kind).toBe('written');

    const asked: string[] = [];
    const goOn = await arrive((await fromStudio()).url, { ask: async (question) => { asked.push(question); return true; } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^The Builder has work on Reading list \(example\) from before that did not go back to Studio\. Go on with it, or start again from Studio’s copy\?/);
    expect(goOn).toEqual({ kind: 'restored', name: 'Reading list (example)' });
    expect(page('pages/home.html').originalSource).toContain('Only in the Builder');
    expect(useProjectStore.getState().isDirty).toBe(true);
    // The earlier visit goes on; what Studio staged just now is let go.
    expect(openVisit()!.visit).toBe(new URL(first.url, 'http://site.test').searchParams.get('handoff'));
    expect(staged()).toEqual([]);
    expect(await comeBack(await goBack())).toMatchObject({ kind: 'applied', paths: ['pages/home.html'] });
    expect(studioText('pages/home.html')).toContain('Only in the Builder');
  });

  it('starts from Studio’s copy when that is the answer, and the work left out is set aside, not lost', async () => {
    await arrive((await fromStudio()).url);
    editHome('Only in the Builder');
    writeRecoveryCopy({ view: 'design' });
    const again = await arrive((await fromStudio()).url, { ask: async () => false });
    expect(again.kind).toBe('opened');
    expect(page('pages/home.html').originalSource).not.toContain('Only in the Builder');
    // The first change here sets the earlier work aside before writing over it.
    editHome('A new start');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', setAside: 'Reading list' });
  });
});

describe('a reload half way', () => {
  it('opens the project again as it came when nothing was changed, with its way back', async () => {
    const { projectId, url } = await fromStudio();
    await arrive(url);
    const visit = openVisit()!.visit;
    // The tab is reloaded: the address is the Builder's own, and nothing is stored but the visit.
    const arrival = await arrive('/builder/');
    expect(arrival).toEqual({ kind: 'opened', name: 'Reading list (example)' });
    expect(openVisit()).toMatchObject({ projectId, visit, workspace: useProjectStore.getState().projectId });
    expect(await goBack()).toBe(`/studio/?from=builder&project=${projectId}`);
  });

  it('opens it again when the reload came before the address was tidied', async () => {
    const { url } = await fromStudio();
    await arrive(url);
    // The same address again: the hand-off is gone from the store, and the tab knows the visit.
    expect(await arrive(url)).toEqual({ kind: 'opened', name: 'Reading list (example)' });
    expect(window.location.search).toBe('');
  });

  it('brings back what was changed without asking, and still sends Studio only that', async () => {
    const { projectId, url } = await fromStudio();
    await arrive(url);
    editHome();
    expect(writeRecoveryCopy({ view: 'design' }).kind).toBe('written');
    const ask = vi.fn(async () => true);
    const arrival = await arrive('/builder/', { ask });
    expect(arrival).toEqual({ kind: 'restored', name: 'Reading list (example)' });
    expect(ask).not.toHaveBeenCalled();
    expect(page('pages/home.html').originalSource).toContain('Welcome back');
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(openVisit()?.projectId).toBe(projectId);
    // The collection's file as it came, though a restored session writes collections anew.
    await goBack();
    const flip = staged()[0].flip;
    expect(flip.kind === 'return' && flip.changed).toEqual(['pages/home.html']);
    expect(flip.kind === 'return' && flip.deleted).toEqual([]);
  });

  it.each(PROJECTS)('%s, changed and then reloaded, still sends Studio the changed page and nothing else', async (_name, make) => {
    useStudioWorkspace.setState({ projectId: 'studio-project', projectName: 'A project' });
    useStudioFiles.getState().openFiles(make());
    const before = new Map(useStudioFiles.getState().files);
    await arrive((await fromStudio()).url);
    editHome();
    // Kept as the recovery copy keeps it: the text, with the pictures and the collections apart or not at all.
    expect(writeRecoveryCopy({ view: 'design' }).kind).toBe('written');
    expect((await arrive('/builder/')).kind).toBe('restored');
    const back = await goBack();
    const flip = staged()[0].flip;
    expect(flip.kind === 'return' && flip.changed).toEqual(['pages/home.html']);
    expect(flip.kind === 'return' && flip.deleted).toEqual([]);
    expect(await comeBack(back)).toMatchObject({ kind: 'applied', paths: ['pages/home.html'] });
    // Every other file Studio has is the file it had: its notes under builder/ among them.
    for (const [path, file] of before) if (path !== 'pages/home.html') expect(useStudioFiles.getState().files.get(path), path).toBe(file);
  });

  it('does not send Studio a deletion for a picture the browser’s store had no room for', async () => {
    useStudioWorkspace.getState().reset();
    const projectId = openExampleInStores(READING_LIST);
    useStudioFiles.getState().createFile('assets/photo.png', PNG);
    const manifest = JSON.parse(studioText('manifest.json')) as { files: { assets: string[] } };
    manifest.files.assets.push('assets/photo.png');
    useStudioFiles.getState().updateFile('manifest.json', JSON.stringify(manifest, null, 2));
    await arrive((await fromStudio()).url);
    editHome();
    writeRecoveryCopy({ view: 'design' });
    // The store kept the text and not the pictures.
    window.localStorage.removeItem(SESSION_ASSETS_KEY);
    expect((await arrive('/builder/')).kind).toBe('restored');
    // Put back from the bundle Studio sent.
    expect([...useFilesStore.getState().assetFiles.values()].map((asset) => asset.bundlePath).sort()).toEqual(['assets/icon.svg', 'assets/photo.png']);
    const back = await goBack();
    const flip = staged()[0].flip;
    expect(flip.kind === 'return' && flip.deleted).toEqual([]);
    expect(flip.kind === 'return' && flip.changed).toEqual(['pages/home.html']);
    await comeBack(back);
    expect(useStudioFiles.getState().files.get('assets/photo.png')?.content).toEqual(PNG);
    expect(useStudioWorkspace.getState().projectId).toBe(projectId);
  });

  it('offers a visit’s stored work back to a Builder opened some other way, with its way back', async () => {
    const { projectId, url } = await fromStudio();
    await arrive(url);
    editHome();
    writeRecoveryCopy({ view: 'design' });
    // Another tab, or the same one much later: no visit of its own.
    window.sessionStorage.removeItem(TAB_VISIT_KEY);
    const asked: string[] = [];
    const arrival = await arrive('/builder/', { ask: async (question) => { asked.push(question); return true; } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Restore “Reading list” with the changes that were not saved/);
    expect(arrival.kind).toBe('restored');
    expect(openVisit()?.projectId).toBe(projectId);

    // Not now: the Builder starts empty, and the visit is not this project's.
    writeRecoveryCopy({ view: 'design' });
    window.sessionStorage.removeItem(TAB_VISIT_KEY);
    expect(await arrive('/builder/', { ask: async () => false })).toEqual({ kind: 'declined' });
    expect(openVisit()).toBeNull();
  });
});

describe('the start', () => {
  const location = (search: string) => ({ search, pathname: '/builder/', hash: '', origin: 'http://site.test' }) as Location;
  const history = { state: null, replaceState: vi.fn() } as unknown as History;
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('puts a project Studio has just handed over before a link and before a stored session, and leaves the address as it is', () => {
    expect(startupAction(location(`?from=studio&handoff=${id}&open=/x.softn`), history, '{"stored":1}')).toEqual({
      kind: 'from-studio', id, tab: null, session: null, otherwise: { kind: 'restore-prompt', raw: '{"stored":1}' },
    });
    expect(history.replaceState).not.toHaveBeenCalled();
    // An address the Builder did not get from Studio is not one.
    expect(startupAction(location('?from=studio&handoff=x'), history, null)).toEqual({ kind: 'nothing' });
    expect(startupAction(location('?from=builder&handoff=' + id), history, null)).toEqual({ kind: 'nothing' });
  });

  it('goes on with the tab’s visit, and asks about a stored session only when it is a visit’s', () => {
    const tab = { projectId: 'p1', visit: id };
    expect(startupAction(location(''), history, null, { tab, visitSession: false })).toEqual({ kind: 'from-studio', id: null, tab, session: null, otherwise: { kind: 'nothing' } });
    expect(startupAction(location(''), history, '{}', { tab: null, visitSession: true })).toEqual({ kind: 'from-studio', id: null, tab: null, session: '{}', otherwise: { kind: 'restore-prompt', raw: '{}' } });
    expect(startupAction(location(''), history, '{}', { tab: null, visitSession: false })).toEqual({ kind: 'restore-prompt', raw: '{}' });
    expect(startupAction(location('?open=/x.softn'), history, null, { tab, visitSession: false }).kind).toBe('remote-open');
  });

  it('is made once under StrictMode, and a link followed in a tab that was on a visit takes the tab off it', async () => {
    const draw = async (address: string) => {
      window.history.replaceState(null, '', address);
      const run = vi.fn();
      const Startup = () => {
        useProjectStartup(run);
        return null;
      };
      const root = createRoot(document.createElement('div'));
      await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Startup))));
      act(() => root.unmount());
      return run.mock.calls.map(([action]) => (action as { kind: string }).kind);
    };
    expect(await draw(`/builder/?from=studio&handoff=${id}`)).toEqual(['from-studio']);
    expect(window.location.search).toBe(`?from=studio&handoff=${id}`);
    window.sessionStorage.setItem(TAB_VISIT_KEY, JSON.stringify({ projectId: 'p1', visit: id }));
    expect(await draw('/builder/')).toEqual(['from-studio']);
    expect(readTabVisit()).toEqual({ projectId: 'p1', visit: id });
    expect(await draw('/builder/?open=/starter.softn')).toEqual(['remote-open', 'remote-open']);
    expect(readTabVisit()).toBeNull();
  });

  it('says why when what Studio handed over is not there, and hands the start back', async () => {
    const arrival = await arrive(`/builder/?from=studio&handoff=${id}`);
    expect(arrival.kind).toBe('failed');
    expect(useStudioVisitStore.getState().problem).toMatch(/Nothing from Studio is waiting here.*Go back to Studio and choose Open in Builder again\./);
    expect(openVisit()).toBeNull();
  });

  it('says why when the Builder cannot open the project, which is as it was in Studio', async () => {
    openExampleInStores(READING_LIST);
    // An entry page that is not a page.
    useStudioFiles.getState().updateFile('manifest.json', studioText('manifest.json').replace('"main": "index.html"', '"main": "missing.html"'));
    const { url } = await fromStudio();
    const arrival = await arrive(url);
    expect(arrival.kind === 'failed' && arrival.message).toMatch(/^Reading list \(example\) could not be opened in the Builder: .*It is as it was in Studio\.$/);
    expect(staged()).toEqual([]);
    expect(useProjectStore.getState().name).toBe('Untitled App');
  });
});

describe('the line over the toolbar', () => {
  function draw(): { container: HTMLDivElement; done(): void } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(React.createElement(StudioOrigin, { view: 'design' })));
    return { container, done: () => { act(() => root.unmount()); container.remove(); } };
  }

  it('is drawn for a project that came from Studio, and for no other', async () => {
    const empty = draw();
    expect(empty.container.textContent).toBe('');
    empty.done();
    await arrive((await fromStudio()).url);
    const line = draw();
    expect(line.container.querySelector('[data-studio-origin="open"]')?.textContent).toBe('From Studio: Reading list (example)Back to Studio');
    expect(line.container.querySelector('button[data-action="back-to-studio"]')).not.toBeNull();
    // A new project in the Builder is not Studio's.
    act(() => useProjectStore.getState().reset());
    expect(line.container.textContent).toBe('');
    expect(readTabVisit()).toBeNull();
    line.done();
  });

  it('is not drawn where there is no Studio beside this Builder', async () => {
    await arrive((await fromStudio()).url);
    site.studio = 'https://softn.com/studio/';
    expect(studioOffered()).toBe(false);
    const line = draw();
    expect(line.container.textContent).toBe('');
    line.done();
    expect(await backToStudio('design', { navigate: () => undefined })).toMatchObject({ kind: 'stayed' });
  });
});
