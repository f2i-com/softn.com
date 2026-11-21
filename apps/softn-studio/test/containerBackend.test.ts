import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readProjectArchive } from '../src/lib/projectImport';
import { validateProject } from '../src/lib/validator';
import { buildBundle, planBundle } from '../src/lib/exportBundle';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import { buildV2ContainerGuide, projectHasContainerBackend } from '../src/lib/agent/guide';
import { CONTAINER_FULLSTACK_NOTES } from '../src/examples/containerFullstackNotes';
import type { ProjectBrief, VFSFile } from '../src/types/studio';

function toVfs(entries: Array<{ path: string; content: string | Uint8Array }>): Map<string, VFSFile> {
  const map = new Map<string, VFSFile>();
  for (const e of entries) {
    map.set(e.path, {
      path: e.path,
      content: e.content,
      mimeType: 'text/plain',
      lastModified: Date.now(),
      lastModifiedBy: 'user',
      version: 1,
    });
  }
  return map;
}

describe('Studio container backend support (v2 full-stack apps)', () => {
  it('imports, validates, and round-trips a Slim 4 PHP + SQLite container with frontendRoot and .htaccess', async () => {
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
          databases: [
            {
              name: 'brewdesk',
              engine: 'sqlite',
              file: 'brewdesk.db',
              seedSql: 'backend/migrations/001_init.sql',
              persist: true,
            },
          ],
        })
      ),
      'permission.json': strToU8(JSON.stringify({ permissions: {} })),
      'public/index.html': strToU8(
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>'
      ),
      'public/style.css': strToU8('body { margin: 0; }'),
      'public/app.js': strToU8('fetch("/api/health");'),
      'backend/public/index.php': strToU8('<?php echo json_encode(["ok" => true]);'),
      'backend/public/.htaccess': strToU8('RewriteEngine On\nRewriteRule ^ index.php [QSA,L]\n'),
      'backend/migrations/001_init.sql': strToU8('CREATE TABLE orders (id INTEGER PRIMARY KEY);'),
      'backend/vendor/autoload.php': strToU8('<?php // vendor autoload'),
    });

    const imported = readProjectArchive(rawZip);
    const byPath = new Map(imported.map((e) => [e.path, e.content]));
    expect(typeof byPath.get('backend/public/index.php')).toBe('string');
    expect(typeof byPath.get('backend/public/.htaccess')).toBe('string');
    expect(typeof byPath.get('backend/migrations/001_init.sql')).toBe('string');

    const vfs = toVfs(imported);
    const problems = validateProject(vfs, null).filter((p) => p.level === 'error');
    expect(problems).toEqual([]);

    // Export and verify manifest.backend, databases, frontendRoot, and vendor survive intact
    const exportedBytes = await buildBundle(vfs);
    const reimported = readProjectArchive(exportedBytes);
    const manifestEntry = reimported.find((e) => e.path === 'manifest.json');
    expect(typeof manifestEntry?.content).toBe('string');
    const manifest = JSON.parse(manifestEntry!.content as string) as Record<string, unknown>;
    expect(manifest.frontendRoot).toBe('public');
    expect(manifest.backend).toEqual({
      runtime: 'php',
      entry: 'backend/public/index.php',
      mode: 'api',
      routes: ['/api/'],
    });
    expect(Array.isArray(manifest.databases)).toBe(true);
    expect(reimported.some((e) => e.path === 'backend/vendor/autoload.php')).toBe(true);
  });

  it('reports validation errors for invalid backend runtime, missing entry, or missing seedSql', () => {
    const vfs = toVfs([
      {
        path: 'manifest.json',
        content: JSON.stringify({
          engine: 2,
          name: 'Broken Backend',
          version: '1.0.0',
          main: 'index.html',
          backend: { runtime: 'cobol', entry: 'backend/missing.php', mode: 'api' },
          databases: [{ name: 'app', engine: 'sqlite', seedSql: 'backend/missing.sql' }],
        }),
      },
      { path: 'index.html', content: '<!DOCTYPE html><html><body>Hi</body></html>' },
    ]);

    const errors = validateProject(vfs, null).filter((p) => p.level === 'error');
    expect(errors.some((e) => e.message.includes('backend.runtime'))).toBe(true);
    expect(errors.some((e) => e.message.includes('backend/missing.php'))).toBe(true);
    expect(errors.some((e) => e.message.includes('backend/missing.sql'))).toBe(true);
  });

  it('scaffolds a full-stack PHP + SQLite container from a brief and teaches the agent its contract', () => {
    const brief: ProjectBrief = {
      appName: 'Order Ledger',
      description: 'Track customer orders with a sandboxed PHP API.',
      target: 'web',
      pages: ['Orders'],
      collections: [],
      authNeeded: false,
      style: 'dark',
      appFormat: 'container',
      logicLanguage: 'typescript',
      containerBackend: 'php',
      referenceImages: [],
    };
    const blueprint = generateBlueprintFromBrief(brief);
    const starter = scaffoldProjectFiles(brief, blueprint);
    const vfs = toVfs(starter);

    expect(vfs.has('backend/index.php')).toBe(true);
    expect(vfs.has('backend/schema.sql')).toBe(true);
    const manifestText = vfs.get('manifest.json')!.content as string;
    expect(projectHasContainerBackend(manifestText)).toBe(true);

    const errors = validateProject(vfs, blueprint).filter((p) => p.level === 'error');
    expect(errors).toEqual([]);

    const guide = buildV2ContainerGuide({
      language: 'typescript',
      torch: false,
      containerBackend: true,
      style: 'dark',
    });
    expect(guide).toContain('Sandboxed Container Backend');
    expect(guide).toContain("new PDO('sqlite:app.db')");
    expect(guide).toContain('safe-sandbox');
  });

  it('ships the bundled Full-Stack Notes PHP + SQLite example with zero errors', () => {
    const vfs = toVfs(CONTAINER_FULLSTACK_NOTES.files);
    const errors = validateProject(vfs, null).filter((p) => p.level === 'error');
    expect(errors).toEqual([]);
    const plan = planBundle(vfs);
    expect(plan.entries.has('backend/index.php')).toBe(true);
    expect(plan.entries.has('backend/schema.sql')).toBe(true);
  });
});
