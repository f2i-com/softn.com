/**
 * A project written as HTML, the way Studio makes one now: `index.html`,
 * which names its code with `<script src="main.js"></script>` and imports
 * `pages/home.html`, and `main.js`.
 *
 * The Builder found a page's logic only through `<logic src>`, so it took
 * such a page for one with no logic: its functions were not offered to its
 * handlers, and a `main.js` the manifest did not list would not have opened.
 * It reads a page's links by the composer's own rule now (core's
 * `pageLogicSources`). What it writes back is what it opened, with the edits
 * made on the canvas, `<script src>` and the `.html` imports kept.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readBundleEntries } from '@softn/core';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle } from './buildProjectBundle';
import { prepareProjectSnapshot, commitProjectSnapshot } from './openProject';
import { useFilesStore } from '../stores/filesStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';

const INDEX = `<import HomePage from="./pages/home.html" />

<data>
  <collection name="tasks" as="tasks" />
</data>
<script src="main.js"></script>

<App theme="light">
  <Container size="lg">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Heading level={1}>{appName}</Heading>
      <HomePage />
    </Stack>
  </Container>
</App>
`;

const HOME = `<Stack direction="vertical" gap="md">
  <Heading level={2}>Home</Heading>
  <p>Plain <b>HTML</b><br>here</p>
</Stack>
`;

const MAIN_JS = `let appName = "Notes"\nlet page = "home"\nfunction go(id) { page = id }\n`;

const TASKS = { collection: 'tasks', records: [{ id: '1', title: 'One' }] };

function entries(listLogic = true): Record<string, Uint8Array> {
  const manifest = {
    name: 'Notes',
    version: '1.0.0',
    main: 'index.html',
    files: { ui: ['index.html', 'pages/home.html'], logic: listLogic ? ['main.js'] : [], xdb: ['xdb/tasks.xdb'], assets: [] },
  };
  return {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'index.html': strToU8(INDEX),
    'pages/home.html': strToU8(HOME),
    'main.js': strToU8(MAIN_JS),
    'xdb/tasks.xdb': strToU8(JSON.stringify(TASKS, null, 2)),
  };
}

const decode = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

beforeEach(() => {
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  useProjectStore.getState().reset();
  useSchemaStore.getState().reset();
});

describe('a project written as HTML', () => {
  it('opens with each page parsed and the main page linked to main.js', async () => {
    const bundle = await loadBundle(zipSync(entries()));
    expect(bundle.warnings).toEqual([]);
    const pages = [...bundle.uiFiles.values()];
    expect(pages.map((page) => page.path)).toEqual(['index.html', 'pages/home.html']);
    expect(pages[0].logicSrc).toBe('main.js');
    expect(pages.every((page) => page.elements.size > 0)).toBe(true);
    expect([...bundle.logicFiles.values()].map((file) => file.path)).toEqual(['main.js']);
  });

  it('opens main.js as the app’s logic when the manifest does not list it, because the page links it', async () => {
    const bundle = await loadBundle(zipSync(entries(false)));
    expect([...bundle.logicFiles.values()].map((file) => file.path)).toEqual(['main.js']);
    expect(bundle.warnings).toEqual([
      'Logic file "main.js" is linked by index.html but not listed in manifest.json; the export will list it.',
    ]);
  });

  it('opens on its main page, index.html, with that file active', async () => {
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(zipSync(entries()))));
    const files = useFilesStore.getState();
    expect(files.activeFileId).not.toBeNull();
    expect(files.uiFiles.get(files.activeFileId!)?.path).toBe('index.html');
  });

  it('is written back as it was opened when nothing is changed', async () => {
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(zipSync(entries()))));
    const out = readBundleEntries(await buildProjectBundle());
    expect(decode(out.get('index.html'))).toBe(INDEX);
    expect(decode(out.get('pages/home.html'))).toBe(HOME);
    expect(decode(out.get('main.js'))).toBe(MAIN_JS);
    expect(JSON.parse(decode(out.get('manifest.json'))!).main).toBe('index.html');
  });

  it('keeps <script src> and the .html imports when the canvas changes the page', async () => {
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(zipSync(entries()))));
    const canvas = useCanvasStore.getState();
    const heading = [...canvas.elements.values()].find((element) => element.componentType === 'Heading')!;
    canvas.updateElementProps(heading.id, { level: 3 });
    const index = decode(readBundleEntries(await buildProjectBundle()).get('index.html'))!;
    expect(index).toContain('<Heading level={3}>{appName}</Heading>');
    expect(index).toContain('<script src="main.js"></script>');
    expect(index).toContain('<import HomePage from="./pages/home.html" />');
    expect(index).not.toContain('<logic');
  });
});

describe('a project written as HTML, its files renamed or moved', () => {
  const idOf = (path: string) => [...useFilesStore.getState().nodes.values()].find((node) => node.path === path)!.id;
  const exported = async (path: string) => decode(readBundleEntries(await buildProjectBundle()).get(path));

  it('follows its code to a new name in <script src>', async () => {
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(zipSync(entries()))));
    useFilesStore.getState().renameFile(idOf('main.js'), 'app.js');
    const index = await exported('index.html');
    expect(index).toContain('<script src="app.js"></script>');
    expect(await exported('app.js')).toBe(MAIN_JS);
  });

  it('follows its code into a renamed folder, and leaves an address on another site alone', async () => {
    const files = entries();
    files['index.html'] = strToU8(
      INDEX.replace('<script src="main.js"></script>', '<script src="js/main.js"></script><script src="https://cdn.example.com/x.js"></script>')
    );
    files['js/main.js'] = files['main.js'];
    delete files['main.js'];
    const manifest = JSON.parse(decode(files['manifest.json'])!);
    manifest.files.logic = ['js/main.js'];
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(zipSync(files))));
    useFilesStore.getState().renameFolder(idOf('js'), 'scripts');
    const index = await exported('index.html');
    expect(index).toContain('<script src="scripts/main.js"></script>');
    expect(index).toContain('<script src="https://cdn.example.com/x.js"></script>');
  });

  it('follows its code and stylesheet from a page moved into a folder', async () => {
    const files = entries();
    files['index.html'] = strToU8(INDEX.replace('<script src="main.js"></script>', '<link rel="stylesheet" href="styles.css"><script src="main.js"></script>'));
    files['styles.css'] = strToU8('p { color: teal }');
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(zipSync(files))));
    useFilesStore.getState().createFolder('', 'site');
    useFilesStore.getState().moveFile(idOf('index.html'), 'site');
    const index = await exported('site/index.html');
    expect(index).toContain('<script src="../main.js"></script>');
    expect(index).toContain('<link rel="stylesheet" href="../styles.css">');
    expect(index).toContain('from="../pages/home.html"');
  });
});
