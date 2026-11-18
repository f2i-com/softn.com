import { beforeEach, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { inspectBundle } from '@softn/core';
import { COMPONENT_STARTERS, WEB_STARTERS, createWebStarter } from '@softn/editor-shared/webStarters';
import { compiledSourcePath } from '@softn/bundle-format/source-modules';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { startNewProject } from './newProject';
import type { NewProjectConfig } from '../components/toolbar/NewProjectDialog';
import { viewsFor } from './workspaceViews';
import { loadBundle } from './bundleLoader';
import { parseBundle } from './bundleExporter';
import { commitProjectSnapshot, prepareProjectSnapshot } from './openProject';
import { buildProjectBundle } from './buildProjectBundle';

beforeEach(() => {
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
  useHistoryStore.getState().clear();
  useSchemaStore.getState().reset();
  useFilesStore.getState().reset();
});

describe('SoftN Builder v2 Web App Containers', () => {
  it.each([...WEB_STARTERS, ...Object.values(COMPONENT_STARTERS)])('opens the $label starter as editable, unsaved source and retains its dependencies on export', async (starter) => {
    const config: NewProjectConfig = {
      name: 'Field journal', description: 'Notes from today.', theme: 'dark', template: 'blank',
      format: 'web', language: 'javascript', pythonPackages: [],
    };
    const source = await createWebStarter(starter.id, config);
    startNewProject(config, source);
    expect(useProjectStore.getState()).toMatchObject({ name: config.name, projectFormat: 'web', isDirty: true, themeMode: 'dark' });
    const files = useFilesStore.getState();
    expect(files.logicFiles.get(files.activeFileId!)?.path).toBe(starter.sourceFile);
    expect(files.openTabs.map((id) => files.nodes.get(id)?.name)).toEqual(['index.html', 'styles.css', starter.sourceFile]);
    const logic = [...files.logicFiles.values()];
    expect(logic.find((file) => file.path === 'styles.css')).toBeDefined();
    const script = logic.find((file) => file.path === starter.sourceFile)!;
    const edited = script.content.replace(' + 1)', ' + 3)');
    expect(edited).not.toBe(script.content);
    files.updateLogicFile(script.id, edited);
    const schema = useSchemaStore.getState();
    const collection = schema.addEntity({ x: 0, y: 0 });
    expect(useSchemaStore.getState().updateEntity(collection, { name: 'findings' })).toBeNull();
    useSchemaStore.getState().addField(collection);
    const field = useSchemaStore.getState().entities.find(entity => entity.id === collection)!.fields.at(-1)!;
    useSchemaStore.getState().updateField(collection, field.id, { name: 'count', type: 'number' });
    useSchemaStore.getState().addSeedRecord(collection);
    useSchemaStore.getState().updateSeedRecord(collection, 0, { count: 3 });
    const bytes = await buildProjectBundle();
    const archive = parseBundle(bytes);
    expect(archive.manifest.main).toBe('index.html');
    expect(archive.manifest.files?.xdb).toContain('xdb/findings.xdb');
    const returned = await loadBundle(bytes);
    const findings = returned.entities.find(entity => entity.name === 'findings')!;
    expect(findings.fields).toContainEqual(expect.objectContaining({ name: 'count', type: 'number' }));
    expect(returned.seedData.get(findings.id)?.[0]).toMatchObject({ count: 3 });
    for (const { path, content } of source) {
      if (path === 'manifest.json') continue;
      const expected = path === starter.sourceFile ? edited : content;
      expect(new TextDecoder().decode(archive.files.get(path)), path).toBe(expected);
    }
    const sidecar = compiledSourcePath(starter.sourceFile);
    if (sidecar) {
      expect(archive.files.has(sidecar)).toBe(true);
      const reopened = await loadBundle(bytes);
      expect([...reopened.logicFiles.values()].find((file) => file.path === starter.sourceFile)?.content).toBe(edited);
      expect([...reopened.logicFiles.values()].some((file) => file.path === sidecar)).toBe(false);
      expect(reopened.extraEntries.has(sidecar)).toBe(false);
      commitProjectSnapshot(prepareProjectSnapshot(reopened));
      const restored = useFilesStore.getState();
      expect(restored.logicFiles.get(restored.activeFileId!)?.path).toBe(starter.sourceFile);
    }
  });

  it('scaffolds a TypeScript Web Container project and exports a valid worker .softn archive', async () => {
    startNewProject({
      name: 'Pulse Board',
      description: 'Live container dashboard',
      theme: 'dark',
      template: 'dashboard',
      format: 'web',
      language: 'typescript',
      pythonPackages: [],
    });

    expect(useProjectStore.getState().projectFormat).toBe('web');
    const files = useFilesStore.getState();
    const uiPaths = [...files.uiFiles.values()].map((f) => f.path);
    const logicPaths = [...files.logicFiles.values()].map((f) => f.path).sort();

    expect(uiPaths).toEqual(['index.html']);
    expect(logicPaths).toEqual(['app.ts', 'style.css']);

    const bytes = await buildProjectBundle();
    const report = inspectBundle(bytes);
    expect(report.problem).toBeNull();
    expect(report.name).toBe('Pulse Board');
    expect(report.main).toBe('index.html');
    expect(report.execution).toBe('worker');
  });

  it('opens a zero-config dist/index.html Vite build archive, allows editing HTML/JS/CSS, and round-trips cleanly', async () => {
    const rawZip = zipSync({
      'dist/index.html': strToU8(
        '<!DOCTYPE html><html><head><title>Compiled Kanban</title><link rel="stylesheet" href="./assets/index-123.css"></head><body><div id="root"></div><script type="module" src="./assets/index-123.js"></script></body></html>'
      ),
      'dist/assets/index-123.js': strToU8('document.getElementById("root").textContent = "Kanban v1";'),
      'dist/assets/index-123.css': strToU8('body { margin: 0; background: #0f172a; }'),
      'dist/xdb/cards.xdb': strToU8(
        JSON.stringify({
          collection: 'cards',
          records: [{ id: 'c1', collection: 'cards', data: { title: 'Ship container' } }],
        })
      ),
    });

    const loaded = await loadBundle(rawZip);
    expect(loaded.projectFormat).toBe('web');
    const snapshot = prepareProjectSnapshot(loaded);
    commitProjectSnapshot(snapshot);

    expect(useProjectStore.getState().projectFormat).toBe('web');
    expect(useProjectStore.getState().name).toBe('Compiled Kanban');
    expect(useSchemaStore.getState().entities.map((e) => e.name)).toContain('cards');

    const files = useFilesStore.getState();
    const htmlEntry = [...files.uiFiles.values()].find((f) => f.path === 'index.html');
    const jsChunk = [...files.logicFiles.values()].find((f) => f.path === 'assets/index-123.js');
    expect(htmlEntry).toBeDefined();
    expect(jsChunk).toBeDefined();

    // Edit both raw HTML and compiled JS chunk without corrupting HTML5 markup
    files.updateRawUIFile(
      htmlEntry!.id,
      htmlEntry!.originalSource!.replace('<div id="root"></div>', '<div id="root" data-edited="1"></div>')
    );
    files.updateLogicFile(jsChunk!.id, 'document.getElementById("root").textContent = "Kanban v2";');

    const exported = await buildProjectBundle();
    const report = inspectBundle(exported);
    expect(report.problem).toBeNull();
    expect(report.execution).toBe('worker');

    const reopened = await loadBundle(exported);
    const reopenedHtml = [...reopened.uiFiles.values()].find((f) => f.path === 'index.html')?.originalSource ?? '';
    const reopenedJs = [...reopened.logicFiles.values()].find((f) => f.path === 'assets/index-123.js')?.content ?? '';
    expect(reopenedHtml).toContain('data-edited="1"');
    expect(reopenedHtml).toContain('<!DOCTYPE html>');
    expect(reopenedJs).toContain('Kanban v2');
  });

  it('deduplicates workspace views and links softn:ui.css across JS, TS, and Python container starters', () => {
    expect(viewsFor('ui', 'web')).toEqual(['design', 'data', 'preview']);
    expect(viewsFor('ui', 'ui')).toEqual(['design', 'data', 'preview', 'code']);

    startNewProject({
      name: 'Py Ops',
      description: 'Python container dashboard',
      theme: 'dark',
      template: 'dashboard',
      format: 'web',
      language: 'python',
      pythonPackages: [],
    });
    const files = useFilesStore.getState();
    const html = [...files.uiFiles.values()][0]?.originalSource ?? '';
    const py = [...files.logicFiles.values()].find((f) => f.path === 'main.py')?.content ?? '';
    expect(html).toContain('softn:ui.css');
    expect(py).toContain('addEventListener("click", add_task)');
  });
});
