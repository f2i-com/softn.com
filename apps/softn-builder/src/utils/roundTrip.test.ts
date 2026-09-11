/**
 * Opening a bundle and exporting it without touching the canvas gives the
 * same source back.
 *
 * Every save, export and pre-flight check flushes the canvas into the
 * active file, and `updateUIFile` used to take each flush as an edit: it
 * regenerated the file's source from the visual model — a lossy one, that
 * drops comments, flattens grouped expressions and collapses nested
 * blocks — even when nothing had changed. So an app opened in Builder and
 * saved, or merely checked in the export dialog, came out rewritten.
 *
 * Pinned here, on a fixture with the things the visual model cannot hold:
 * every UI, logic and asset entry of a no-edit round trip is byte-for-byte
 * the input; opening the export dialog (a pre-flight build) mutates
 * nothing; a real visual edit does regenerate, and marks the file dirty.
 * The manifest and the .xdb entries are regenerated on export and are the
 * subject of BLD-04, BLD-05 and BLD-06, so they are not compared here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readBundleEntries } from '@softn/core';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle } from './buildProjectBundle';
import { useFilesStore } from '../stores/filesStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import type { AssetFile } from '../types/builder';

const MAIN_UI = `// The entry file. This comment is part of the source.
<import Header from="./components/Header.ui" />
<logic src="../logic/main.logic" />

<data>
  <collection name="tasks" as="tasks" />
</data>

<App theme="dark" title="Round trip">
  <Stack direction="vertical" gap="md">
    <Header title={(a + b) * c} />
    #if (outer)
      #if (inner)
        <Text>{items.length > 0 ? "some" : "none"}</Text>
      #end
    #end
    #each (task in tasks)
      #each (tag in task.data.tags)
        <Badge>{tag}</Badge>
      #end
    #empty
      <Text>Nothing yet</Text>
    #end
    <Button @click={() => count = count + 1}>Add</Button>
  </Stack>
</App>

<style>
  /* scoped */
  .custom { color: rebeccapurple; }
</style>
`;

const HEADER_UI = `<component name="Header">
  <prop name="title" propType="number" />
</component>

<Heading level={1}>{title}</Heading>
`;

const MAIN_LOGIC = `// main.logic — kept as written
let a = 2
let b = 3
let c = 5
let count = 0
let outer = false
let inner = true
let items = []
`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

const MANIFEST = {
  formatVersion: '1.0',
  name: 'Round trip',
  version: '1.2.3',
  description: 'A fixture',
  main: 'ui/main.ui',
  files: { ui: ['ui/main.ui', 'ui/components/Header.ui'], logic: ['logic/main.logic'], xdb: [], assets: ['assets/dot.png'] },
  config: { window: { title: 'Round trip', width: 1200, height: 800 }, theme: { mode: 'dark' } },
};

function fixture(): Uint8Array {
  return zipSync(
    {
      'manifest.json': strToU8(JSON.stringify(MANIFEST, null, 2)),
      'ui/main.ui': strToU8(MAIN_UI),
      'ui/components/Header.ui': strToU8(HEADER_UI),
      'logic/main.logic': strToU8(MAIN_LOGIC),
      'assets/dot.png': PNG,
    },
    { level: 6 },
  );
}

/** Open the fixture the way the app does, minus React. */
async function open(): Promise<void> {
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
  useSchemaStore.getState().reset();
  useFilesStore.getState().reset();
  const bundle = await loadBundle(fixture());
  const project = useProjectStore.getState();
  project.setName(bundle.manifest.name);
  project.setVersion(bundle.manifest.version);
  project.setDescription(bundle.manifest.description);
  project.setThemeMode(bundle.manifest.config.theme.mode);
  const assets: AssetFile[] = [...bundle.assets.entries()].map(([path, data]) => ({ name: path.replace(/^assets\//, ''), type: 'image/png', data }));
  project.setAssets(assets);
  const assetMap = new Map(assets.map((a) => [`assets/${a.name}`, a]));
  useFilesStore.getState().loadFromBundle(bundle.uiFiles, bundle.logicFiles, assetMap);
  const main = [...bundle.uiFiles.values()].find((f) => f.path === 'ui/main.ui')!;
  useCanvasStore.getState().loadState(new Map(main.elements), main.rootId, main.imports);
  project.markClean();
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function exported(): Promise<Map<string, Uint8Array>> {
  return readBundleEntries(await buildProjectBundle());
}

beforeEach(async () => {
  await open();
});

describe('a no-edit round trip', () => {
  it('keeps every UI, logic and asset entry byte-for-byte', async () => {
    const out = await exported();
    expect(decode(out.get('ui/main.ui')!)).toBe(MAIN_UI);
    expect(decode(out.get('ui/components/Header.ui')!)).toBe(HEADER_UI);
    expect(decode(out.get('logic/main.logic')!)).toBe(MAIN_LOGIC);
    expect([...out.get('assets/dot.png')!]).toEqual([...PNG]);
  });

  it('keeps them after a second export too, and leaves the project clean', async () => {
    await exported();
    const out = await exported();
    expect(decode(out.get('ui/main.ui')!)).toBe(MAIN_UI);
    expect(useProjectStore.getState().isDirty).toBe(false);
    const main = [...useFilesStore.getState().uiFiles.values()].find((f) => f.path === 'ui/main.ui')!;
    expect(useFilesStore.getState().nodes.get(main.id)?.isDirty).toBe(false);
    expect(main.originalSource).toBe(MAIN_UI);
  });

  it('is not disturbed by a flush of a canvas copy, as a tab switch or pre-flight makes', () => {
    const files = useFilesStore.getState();
    const main = [...files.uiFiles.values()].find((f) => f.path === 'ui/main.ui')!;
    const copy = new Map([...useCanvasStore.getState().elements].map(([id, el]) => [id, { ...el, props: { ...el.props } }]));
    files.updateUIFile(main.id, copy, useCanvasStore.getState().rootId);
    const after = useFilesStore.getState().uiFiles.get(main.id)!;
    expect(after.originalSource).toBe(MAIN_UI);
    expect(useFilesStore.getState().nodes.get(main.id)?.isDirty).toBe(false);
  });
});

/**
 * main.ui is not something the visual model can hold: it opens with a
 * comment, which the parser drops before the model sees it. A visual edit
 * used to regenerate the file anyway, comment gone. Now the file is
 * source-only: the edit is refused, the reason is recorded on the file,
 * and the bytes stay. (Its handler `() => count = count + 1` used to be a
 * second reason — the parser stopped reading it at `count` and wrote
 * back `() => count` plus a stray `count` attribute — but the parser reads
 * assignments now, so the handler is whole and is not a reason.)
 */
describe('a visual edit on a file the visual model cannot write back', () => {
  function mainFile() {
    return [...useFilesStore.getState().uiFiles.values()].find((f) => f.path === 'ui/main.ui')!;
  }

  it('keeps every entry byte-for-byte and does not mark the file dirty', async () => {
    const canvas = useCanvasStore.getState();
    const root = canvas.getElement(canvas.rootId)!;
    canvas.updateElementProps(root.id, { title: 'Edited' });
    const out = await exported();
    expect(decode(out.get('ui/main.ui')!)).toBe(MAIN_UI);
    expect(decode(out.get('ui/components/Header.ui')!)).toBe(HEADER_UI);
    expect(decode(out.get('logic/main.logic')!)).toBe(MAIN_LOGIC);
    expect(mainFile().originalSource).toBe(MAIN_UI);
    expect(useFilesStore.getState().nodes.get(mainFile().id)?.isDirty).toBe(false);
  });

  it('records why the edit was refused: the comment, and only the comment', async () => {
    const canvas = useCanvasStore.getState();
    const root = canvas.getElement(canvas.rootId)!;
    canvas.updateElementProps(root.id, { title: 'Edited' });
    await exported();
    const file = mainFile();
    expect(file.sourceFidelity?.lossless).toBe(false);
    expect(file.visualEditBlocked).toBeDefined();
    const reasons = file.visualEditBlocked!.join('\n');
    expect(reasons).toMatch(/comment on line 1/);
    // The assignment handler is read whole now; it is no longer a reason.
    expect(reasons).not.toMatch(/count = count \+ 1/);
    expect(file.visualEditBlocked).toHaveLength(1);
  });

  it('holds the assignment handler whole in the visual model', () => {
    const button = [...mainFile().elements.values()].find((el) => el.componentType === 'Button')!;
    expect(button.events?.click).toBe('() => count = count + 1');
    expect(button.props).not.toHaveProperty('count');
  });

  it('does not drop the nested blocks or the #empty branch', async () => {
    const canvas = useCanvasStore.getState();
    const root = canvas.getElement(canvas.rootId)!;
    canvas.updateElementProps(root.id, { title: 'Edited' });
    const main = decode((await exported()).get('ui/main.ui')!);
    expect(main).toContain('#if (outer)');
    expect(main).toContain('#if (inner)');
    expect(main).toContain('#each (tag in task.data.tags)');
    expect(main).toContain('#empty');
    expect(main).toContain('// The entry file.');
  });
});

/**
 * Header.ui the visual model does hold — a component declaration the
 * regenerator now carries across, one element, one interpolation — so a
 * visual edit there is written back, with the header intact.
 */
describe('a visual edit on a file the visual model can write back', () => {
  it('regenerates that file, marks it dirty, and leaves the other files alone', async () => {
    const files = useFilesStore.getState();
    const header = [...files.uiFiles.values()].find((f) => f.path === 'ui/components/Header.ui')!;
    const edited = new Map([...header.elements].map(([id, el]) => [id, { ...el, props: { ...el.props } }]));
    const heading = [...edited.values()].find((el) => el.componentType === 'Heading')!;
    heading.props.level = 2;
    files.updateUIFile(header.id, edited, header.rootId);

    const out = await exported();
    const headerOut = decode(out.get('ui/components/Header.ui')!);
    expect(headerOut).not.toBe(HEADER_UI);
    expect(headerOut).toContain('<component name="Header">');
    expect(headerOut).toContain('<prop name="title" propType="number" />');
    expect(headerOut).toContain('<Heading level={2}>{title}</Heading>');
    expect(decode(out.get('ui/main.ui')!)).toBe(MAIN_UI);
    expect(decode(out.get('logic/main.logic')!)).toBe(MAIN_LOGIC);
    const after = useFilesStore.getState().uiFiles.get(header.id)!;
    expect(after.visualEditBlocked).toBeUndefined();
    expect(after.sourceFidelity?.lossless).toBe(true);
    expect(useFilesStore.getState().nodes.get(header.id)?.isDirty).toBe(true);
  });
});
