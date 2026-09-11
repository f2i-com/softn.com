/**
 * One fixture through every run path: PLT-01 in the audit.
 *
 * The audit's finding was that Studio assembles its preview from the VFS
 * and Builder regenerates its preview from the canvas model, while the
 * runtime opens the exported archive — three entry paths into the same
 * renderer, none of them tested against the others, so a bundle could
 * preview one way and run another with nothing to say so. This takes one
 * small bundle — a manifest, a main.ui with a `<data>` collection, an
 * external logic file, a permission.json declaring storage with a policy,
 * one binary asset — and pushes it through:
 *
 *   (a) the runtime's bundle open path: core's `readBundle` and
 *       `composeBundleSource`, which apps/softn-web's bundleProcessor
 *       wraps (its own copy of this check is apps/softn-web/test/
 *       parity-run-paths.test.ts, against the built package);
 *   (b) Studio's preview assembly: `assemblePreviewSource` and
 *       `buildPreviewXDBState` from apps/softn-studio/src/lib/
 *       previewProject.ts, over the VFS the import would produce, and
 *       `planBundle` from exportBundle.ts for what Studio would export back;
 *   (c) Builder's preview pipeline: `loadBundle` from apps/softn-builder/
 *       src/utils/bundleLoader.ts, then the same steps LivePreview.tsx
 *       takes for the active main file — `generateSource` over the canvas
 *       model, merged into the original source, external logic inlined.
 *
 * "Equivalent" here is: the same declared permissions, the same collections
 * with the same records, the same rendered text for the first screen, and
 * no path handing the app a capability the bundle did not declare. Each
 * path's source is rendered through core's own SoftNRenderer under jsdom
 * with the real scripting engine (test/setup-wasm.ts), so the greeting
 * that `{greeting}` prints comes from the logic file each path inlined,
 * not from a stub.
 *
 * What is not exercised here, and why: the worker execution path (jsdom
 * has no Worker; the engine runs on the main thread), Builder's
 * LivePreview component itself (a React tree over four zustand stores —
 * its private helpers `mergeGeneratedTemplateIntoSource` and
 * `resolveExternalLogic` are mirrored below as its own preview-pipeline
 * test mirrors them; exporting them from a utils module would let this
 * test import the real ones), and Studio's VisualCanvas (the same shape;
 * what it hands the renderer is read from the source and pinned below).
 *
 * Two facts this pins that are easy to lose:
 *   - Studio's canvas passes no `permissionConfig` to the renderer at all.
 *     The runtime reads a missing config as "this bundle ships no
 *     permission.json" and denies every capability, so a Studio preview
 *     grants strictly less than the bundle declares — never more — but
 *     its refusal message blames the author for a file they did write.
 *   - Builder's preview config is the project's declaration rebuilt
 *     through buildPermissionJson, which is byte-for-byte what it exports.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { composeBundleSource } from '../src/bundle/source-composer';
import { readBundle, parseXDBFile } from '../src/bundle/bundle';
import { inspectDeclaration } from '../src/runtime/capabilities';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { registerComponent, type SoftNComponent } from '../src/renderer/registry';
import type { PermissionConfig } from '../src/runtime/script-runtime';
import type { SoftNProps } from '../src/types';
// Studio's preview assembly and export plan, by relative path: these are
// the modules VisualCanvas and the export button call.
import { assemblePreviewSource, buildPreviewXDBState } from '../../../../apps/softn-studio/src/lib/previewProject';
import { planBundle } from '../../../../apps/softn-studio/src/lib/exportBundle';
import type { VFSFile } from '../../../../apps/softn-studio/src/types/studio';
// Builder's open path and source generator: what LivePreview composes from.
import { loadBundle } from '../../../../apps/softn-builder/src/utils/bundleLoader';
import { generateSource } from '../../../../apps/softn-builder/src/utils/sourceGenerator';
import { buildPermissionJson } from '../../../../apps/softn-builder/src/utils/permissions';
import type { LogicFileState } from '../../../../apps/softn-builder/src/types/builder';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── The fixture ────────────────────────────────────────────────────────

const MANIFEST = {
  formatVersion: '1.0',
  name: 'Parity probe',
  version: '1.0.0',
  description: 'One bundle, every run path',
  main: 'ui/main.ui',
  files: {
    ui: ['ui/main.ui'],
    logic: ['logic/main.logic'],
    xdb: ['xdb/notes.xdb'],
    assets: ['assets/mark.png'],
  },
};

const MAIN_UI = `<logic src="../logic/main.logic" />

<data>
  <collection name="notes" as="notes" />
</data>

<App title="Parity probe">
  <Stack direction="vertical" gap="md">
    <Heading level={1}>Parity probe</Heading>
    <Text>{greeting}</Text>
    #each (note in notes)
      <Text>{note.data.title}</Text>
    #empty
      <Text>No notes</Text>
    #end
  </Stack>
</App>
`;

const MAIN_LOGIC = `let greeting = "Hello from logic"
`;

const NOTES_XDB = JSON.stringify(
  {
    collection: 'notes',
    schema: { alias: 'notes', fields: [{ id: 'field_title', name: 'title', type: 'string', required: true }] },
    records: [
      { id: 'n1', data: { title: 'First note' }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'n2', data: { title: 'Second note' }, created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
    ],
  },
  null,
  2
);

const PERMISSION_JSON = JSON.stringify({ permissions: { storage: { enabled: true, collections: { notes: 'append-only' } } } }, null, 2);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

const FILES: Record<string, string | Uint8Array> = {
  'manifest.json': JSON.stringify(MANIFEST, null, 2),
  'ui/main.ui': MAIN_UI,
  'logic/main.logic': MAIN_LOGIC,
  'xdb/notes.xdb': NOTES_XDB,
  'permission.json': PERMISSION_JSON,
  'assets/mark.png': PNG,
};

function bundleBytes(): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(FILES)) entries[path] = typeof content === 'string' ? strToU8(content) : content;
  return zipSync(entries, { level: 6 });
}

/** The VFS Studio's import produces from the archive: one entry per file, at its archive path. */
function studioVFS(): Map<string, VFSFile> {
  const files = new Map<string, VFSFile>();
  for (const [path, content] of Object.entries(FILES)) {
    files.set(path, {
      path,
      content,
      mimeType: typeof content === 'string' ? 'text/plain' : 'image/png',
      lastModified: 0,
      lastModifiedBy: 'user',
      version: 1,
    });
  }
  return files;
}

// ── Builder's LivePreview steps, mirrored ──────────────────────────────
// These are module-private in components/preview/LivePreview.tsx; the
// Builder's own preview-pipeline test carries the same copy. The copy is
// kept minimal and literal so a divergence is a diff against that file.

function extractFirstBlock(source: string, regex: RegExp): string | null {
  const m = source.match(regex);
  return m ? m[0].trim() : null;
}

function extractAllBlocks(source: string, regex: RegExp): string[] {
  return Array.from(source.matchAll(regex))
    .map((m) => m[0].trim())
    .filter(Boolean);
}

function mergeGeneratedTemplateIntoSource(originalSource: string | undefined, generatedSource: string): string {
  const generatedDataBlock = extractFirstBlock(generatedSource, /<data>[\s\S]*?<\/data>/i);
  const generatedLogicBlock = extractFirstBlock(generatedSource, /<logic>[\s\S]*?<\/logic>/i);
  const templateOnly = generatedSource
    .replace(/<data>[\s\S]*?<\/data>/gi, '')
    .replace(/<logic>[\s\S]*?<\/logic>/gi, '')
    .trim();
  if (!originalSource) return generatedSource;
  const preservedLogicSrc = extractFirstBlock(originalSource, /<logic\s+src=["'][^"']+["']\s*\/>/i);
  const preservedInlineLogic = extractFirstBlock(originalSource, /<logic>[\s\S]*?<\/logic>/i);
  const preservedImports = extractAllBlocks(originalSource, /<import\s+(?:\{\s*[^}]+\s*\}|\w+)\s+from=["'][^"']+["']\s*\/>/gi);
  const preservedData = extractFirstBlock(originalSource, /<data>[\s\S]*?<\/data>/i);
  const preservedStyles = extractAllBlocks(originalSource, /<style>[\s\S]*?<\/style>/gi);
  const logicBlock = preservedLogicSrc || preservedInlineLogic || generatedLogicBlock;
  const dataBlock = preservedData || generatedDataBlock;
  const headerBlocks = [logicBlock, preservedImports.length > 0 ? preservedImports.join('\n') : null, dataBlock, ...preservedStyles].filter(
    (block): block is string => Boolean(block && block.trim())
  );
  return [headerBlocks.join('\n\n'), templateOnly].filter(Boolean).join('\n\n').trim();
}

function resolveRelativePath(fromPath: string, relativePath: string): string {
  const dir = fromPath.split('/');
  dir.pop();
  for (const part of relativePath.split('/')) {
    if (part === '..') dir.pop();
    else if (part !== '.') dir.push(part);
  }
  return dir.join('/');
}

function resolveExternalLogic(source: string, uiFilePath: string, logicFiles: Map<string, LogicFileState>): string {
  return source.replace(/<logic\s+src=["']([^"']+)["']\s*\/>/g, (_match, srcPath: string) => {
    const resolved = resolveRelativePath(uiFilePath, srcPath);
    const pathsToTry = [resolved, resolved.replace(/^\//, '')];
    if (uiFilePath.startsWith('ui/') && srcPath.startsWith('./')) pathsToTry.push(`logic/${srcPath.slice(2)}`);
    if (srcPath.startsWith('./')) pathsToTry.push(srcPath.slice(2));
    for (const [, file] of logicFiles) {
      if (pathsToTry.includes(file.path)) return `<logic>\n${file.content}\n</logic>`;
    }
    return `<logic>\n// Logic file not found: ${srcPath}\n</logic>`;
  });
}

function stripComments(source: string): string {
  return source
    .replace(/^\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

// ── Rendering ──────────────────────────────────────────────────────────
// The four component tags the fixture uses come from @softn/components in
// every host; core alone has no registration for them, so stand-ins with
// the same content contract (children through) are registered once. The
// comparison is of text, which the stand-ins do not touch.

function passThrough(tag: 'div' | 'h1' | 'p'): SoftNComponent {
  const StandIn = ({ children }: SoftNProps): React.ReactElement => React.createElement(tag, null, children as React.ReactNode);
  StandIn.displayName = `StandIn(${tag})`;
  return StandIn;
}
registerComponent('App', passThrough('div'));
registerComponent('Stack', passThrough('div'));
registerComponent('Heading', passThrough('h1'));
registerComponent('Text', passThrough('p'));

/** Records as `initialData` hands them to the renderer: one array per alias. */
type InitialData = Record<string, unknown[]>;

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
});

/**
 * Render a source the way each host does — through SoftNRenderer with the
 * path's own data and config — and return the first screen's text once the
 * engine has run the logic (the greeting is the tell: it cannot appear
 * until the inlined logic has executed).
 */
async function firstScreenText(source: string, initialData: InitialData, permissionConfig: PermissionConfig | undefined): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(React.createElement(SoftNRenderer, { source, initialData, permissionConfig }));
  });
  for (let i = 0; i < 100; i++) {
    if (container.textContent?.includes('Hello from logic')) break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** What matters about a seeded record for parity: its id and its data. */
function essence(records: unknown[]): Array<{ id: unknown; data: unknown }> {
  return (records as Array<{ id: unknown; data: unknown }>).map((r) => ({ id: r.id, data: r.data })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// ── The three paths ────────────────────────────────────────────────────

interface RunPath {
  name: string;
  /** The single source the renderer is given. */
  source: string;
  /** Capabilities the path's permission config asks for, in schema order. */
  requested: string[];
  storagePolicies: Record<string, string>;
  /** The permission config the path hands the renderer, as it hands it. */
  permissionConfig: PermissionConfig | undefined;
  /** Collections the path seeds, by alias, with their records. */
  data: InitialData;
}

async function runtimePath(): Promise<RunPath> {
  const bundle = await readBundle(bundleBytes());
  const textFiles = new Map<string, string>();
  for (const [path, file] of bundle.files) if (typeof file.content === 'string') textFiles.set(path, file.content);
  const composed = composeBundleSource(textFiles, bundle.manifest.main, bundle.manifest.files.logic);
  const permissionText = textFiles.get('permission.json');
  const permissionConfig = permissionText ? (JSON.parse(permissionText) as PermissionConfig) : undefined;
  const report = inspectDeclaration(permissionConfig);
  const data: InitialData = {};
  for (const [, xdb] of bundle.xdbData) data[xdb.collection] = xdb.records.map((r) => ({ ...r, collection: xdb.collection }));
  return { name: 'runtime', source: composed.source, requested: report.requested, storagePolicies: report.storagePolicies, permissionConfig, data };
}

async function studioPath(): Promise<RunPath> {
  const files = studioVFS();
  const uiFiles = new Map<string, string>();
  const logicFiles = new Map<string, string>();
  for (const [path, file] of files) {
    if (typeof file.content !== 'string') continue;
    if (/\.ui$/i.test(path)) uiFiles.set(path, file.content);
    if (/\.logic$/i.test(path)) logicFiles.set(path, file.content);
  }
  const assembled = assemblePreviewSource('ui/main.ui', MAIN_UI, uiFiles, logicFiles);
  const xdbState = buildPreviewXDBState(files);
  // VisualCanvas hands SoftNRenderer `source`, `functions`, `initialData`,
  // `importResolver`, `preIncludedLogicPaths`, `appId` — and no
  // `permissionConfig`. This is that absence, made explicit.
  const permissionConfig = undefined;
  const report = inspectDeclaration(permissionConfig);
  return {
    name: 'studio',
    source: assembled.source,
    requested: report.requested,
    storagePolicies: report.storagePolicies,
    permissionConfig,
    data: xdbState.initialData as InitialData,
  };
}

async function builderPath(): Promise<RunPath> {
  const loaded = await loadBundle(bundleBytes());
  const main = loaded.uiFiles.get(loaded.mainFileId);
  expect(main, 'Builder loaded the entry file').toBeDefined();
  // LivePreview, for the active main file: the canvas model regenerated,
  // merged into the original source's header blocks, external logic
  // inlined, comments stripped.
  const logic = [...loaded.logicFiles.values()].find((f) => f.path === 'logic/main.logic');
  const generated = generateSource(main!.elements, main!.rootId, logic?.content ?? '', loaded.collections);
  let source = mergeGeneratedTemplateIntoSource(main!.originalSource, generated);
  source = resolveExternalLogic(source, main!.path, loaded.logicFiles);
  source = stripComments(source);
  const json = buildPermissionJson(loaded.permissions);
  const permissionConfig = json ? (JSON.parse(json) as PermissionConfig) : undefined;
  const report = inspectDeclaration(permissionConfig);
  const data: InitialData = {};
  for (const col of loaded.collections) data[col.alias || col.name] = col.fullRecords ?? [];
  return { name: 'builder', source, requested: report.requested, storagePolicies: report.storagePolicies, permissionConfig, data };
}

// ── The assertions ─────────────────────────────────────────────────────

describe('one bundle through the runtime, Studio and Builder', () => {
  it('declares the same permissions on the paths that declare any, and none grants more than the bundle', async () => {
    const declared = inspectDeclaration(JSON.parse(PERMISSION_JSON));
    expect(declared.requested).toEqual(['storage']);
    expect(declared.storagePolicies).toEqual({ notes: 'append-only' });

    const [runtime, studio, builder] = await Promise.all([runtimePath(), studioPath(), builderPath()]);

    // The runtime reads the file as written; Builder rebuilds it from the
    // declaration it read back, and the two agree exactly.
    expect(runtime.requested).toEqual(declared.requested);
    expect(runtime.storagePolicies).toEqual(declared.storagePolicies);
    expect(builder.requested).toEqual(declared.requested);
    expect(builder.storagePolicies).toEqual(declared.storagePolicies);
    expect(builder.permissionConfig).toEqual(runtime.permissionConfig);

    // Studio's preview asks for nothing: the renderer gets no config, which
    // the runtime denies wholesale. Less than declared, never more.
    expect(studio.permissionConfig).toBeUndefined();
    expect(studio.requested).toEqual([]);

    // No path requests a capability the bundle did not declare.
    for (const path of [runtime, studio, builder]) {
      for (const capability of path.requested) expect(declared.requested, `${path.name} requested ${capability}`).toContain(capability);
      for (const [collection, policy] of Object.entries(path.storagePolicies)) {
        expect(declared.storagePolicies[collection], `${path.name} policy for ${collection}`).toBe(policy);
      }
    }
  });

  it('seeds the same collections with the same records on every path', async () => {
    const [runtime, studio, builder] = await Promise.all([runtimePath(), studioPath(), builderPath()]);
    const expected = { notes: essence(parseXDBFile('xdb/notes.xdb', NOTES_XDB).records) };
    expect(expected.notes).toHaveLength(2);
    for (const path of [runtime, studio, builder]) {
      expect(Object.keys(path.data).sort(), `${path.name} collections`).toEqual(['notes']);
      expect(essence(path.data.notes), `${path.name} records`).toEqual(expected.notes);
    }
  });

  it('exports from Studio exactly the entries the bundle had, with the declaration untouched', () => {
    const plan = planBundle(studioVFS());
    expect(plan.problems.filter((p) => p.level === 'error')).toEqual([]);
    expect([...plan.entries.keys()].sort()).toEqual(Object.keys(FILES).sort());
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    expect(decode(plan.entries.get('permission.json')!)).toBe(PERMISSION_JSON);
    expect(decode(plan.entries.get('ui/main.ui')!)).toBe(MAIN_UI);
    expect(decode(plan.entries.get('logic/main.logic')!)).toBe(MAIN_LOGIC);
    expect(decode(plan.entries.get('xdb/notes.xdb')!)).toBe(NOTES_XDB);
    expect(plan.entries.get('assets/mark.png')).toEqual(PNG);
    // The normalised manifest names the same files in the same groups.
    const manifest = JSON.parse(decode(plan.entries.get('manifest.json')!)) as typeof MANIFEST;
    expect(manifest.main).toBe(MANIFEST.main);
    expect(manifest.files).toEqual(MANIFEST.files);
  });

  it('inlines the same logic on every path, so the composed sources agree on what runs', async () => {
    const [runtime, studio, builder] = await Promise.all([runtimePath(), studioPath(), builderPath()]);
    for (const path of [runtime, studio, builder]) {
      expect(path.source, `${path.name} inlined the logic file`).toContain('let greeting = "Hello from logic"');
      expect(path.source, `${path.name} left no unresolved logic reference`).not.toMatch(/<logic\s+src=/);
      expect(path.source, `${path.name} kept the data block`).toMatch(/<collection\s+name="notes"\s+as="notes"/);
      expect(path.source, `${path.name} kept the loop`).toContain('#each');
    }
  });

  it('renders the same first screen on every path', async () => {
    const [runtime, studio, builder] = await Promise.all([runtimePath(), studioPath(), builderPath()]);
    const texts = new Map<string, string>();
    for (const path of [runtime, studio, builder]) {
      texts.set(path.name, await firstScreenText(path.source, path.data, path.permissionConfig));
    }
    const reference = texts.get('runtime')!;
    expect(reference, 'the runtime rendered the heading').toContain('Parity probe');
    expect(reference, 'the runtime ran the logic').toContain('Hello from logic');
    expect(reference, 'the runtime listed the seeded records').toContain('First note');
    expect(reference).toContain('Second note');
    expect(reference).not.toContain('No notes');
    expect(texts.get('studio'), 'Studio preview text').toBe(reference);
    expect(texts.get('builder'), 'Builder preview text').toBe(reference);
  }, 60_000);
});
