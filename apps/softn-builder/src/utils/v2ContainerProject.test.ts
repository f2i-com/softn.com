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

  it('scaffolds, edits, and round-trips a full-stack PHP + SQLite Web Container bundle with vendor/ preserved', async () => {
    startNewProject({
      name: 'Desk Ledger',
      description: 'Sandboxed PHP + SQLite ledger',
      theme: 'dark',
      template: 'blank',
      format: 'web',
      backend: 'php',
      language: 'typescript',
      pythonPackages: [],
    });

    const files = useFilesStore.getState();
    const logicPaths = [...files.logicFiles.values()].map((f) => f.path).sort();
    expect(logicPaths).toEqual(['app.ts', 'backend/index.php', 'backend/schema.sql', 'style.css']);

    const retainedManifest = useProjectStore.getState().source.manifest as Record<string, unknown>;
    expect(retainedManifest.backend).toEqual({
      runtime: 'php',
      entry: 'backend/index.php',
      mode: 'api',
      routes: ['/api/'],
    });
    expect(Array.isArray(retainedManifest.databases)).toBe(true);

    const exported = await buildProjectBundle();
    const reopened = await loadBundle(exported);
    expect(reopened.projectFormat).toBe('web');
    expect(reopened.rawManifest.backend).toEqual({
      runtime: 'php',
      entry: 'backend/index.php',
      mode: 'api',
      routes: ['/api/'],
    });
    expect([...reopened.logicFiles.values()].map((f) => f.path)).toContain('backend/index.php');
    expect([...reopened.logicFiles.values()].map((f) => f.path)).toContain('backend/schema.sql');
  });

  it('opens a Slim 4 style full-stack PHP bundle, keeps vendor/ in extraEntries, and lets .php/.sql/.htaccess be edited', async () => {
    const rawZip = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          id: 'com.demo.brewdesk',
          name: 'BrewDesk',
          version: '1.0.0',
          engine: 2,
          main: 'public/index.html',
          frontendRoot: 'public',
          backend: {
            runtime: 'php',
            entry: 'backend/public/index.php',
            mode: 'api',
            routes: ['/api/'],
          },
          databases: [{ name: 'brewdesk', engine: 'sqlite', file: 'brewdesk.db', seedSql: 'backend/migrations/001_init.sql' }],
        })
      ),
      'public/index.html': strToU8('<!DOCTYPE html><html><body><div id="app"></div><script type="module" src="./app.js"></script></body></html>'),
      'public/app.js': strToU8('fetch("/api/health");'),
      'backend/public/index.php': strToU8('<?php echo json_encode(["ok" => true]);'),
      'backend/public/.htaccess': strToU8('RewriteEngine On\nRewriteRule ^ index.php [QSA,L]\n'),
      'backend/migrations/001_init.sql': strToU8('CREATE TABLE items (id INTEGER PRIMARY KEY);'),
      'backend/vendor/autoload.php': strToU8('<?php // vendor autoload'),
    });

    const loaded = await loadBundle(rawZip);
    expect(loaded.projectFormat).toBe('web');
    const editablePaths = [...loaded.logicFiles.values()].map((f) => f.path);
    expect(editablePaths).toContain('backend/public/index.php');
    expect(editablePaths).toContain('backend/public/.htaccess');
    expect(editablePaths).toContain('backend/migrations/001_init.sql');
    expect(editablePaths).not.toContain('backend/vendor/autoload.php');
    expect(loaded.extraEntries.has('backend/vendor/autoload.php')).toBe(true);

    // Edit PHP entry and re-export: vendor/ and backend manifest must survive intact
    commitProjectSnapshot(prepareProjectSnapshot(loaded));
    const phpEntry = [...useFilesStore.getState().logicFiles.values()].find((f) => f.path === 'backend/public/index.php')!;
    useFilesStore.getState().updateLogicFile(phpEntry.id, '<?php echo json_encode(["ok" => true, "v" => 2]);');

    const exported = await buildProjectBundle();
    const reopened = await loadBundle(exported);
    expect(reopened.extraEntries.has('backend/vendor/autoload.php')).toBe(true);
    const updatedPhp = [...reopened.logicFiles.values()].find((f) => f.path === 'backend/public/index.php')?.content;
    expect(updatedPhp).toContain('"v" => 2');
    expect(reopened.rawManifest.frontendRoot).toBe('public');
  });
});
