import { beforeEach, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { inspectBundle } from '@softn/core';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { startNewProject } from './newProject';
import { loadBundle } from './bundleLoader';
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
});
