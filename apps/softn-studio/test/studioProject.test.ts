/**
 * What the generator makes, and what it does with text it did not write.
 *
 * The scaffold is a bundle the runtime opens and the directory takes: a
 * manifest with `main` and true file groups, a declaration, .ui pages behind
 * a shell. Everything scaffoldProjectFiles interpolates is untrusted — the
 * app name and description are whatever the user typed into the brief, and
 * page and collection names can come straight back from the model — so the
 * names the app shows go through logic as JSON strings, never into markup,
 * and the few labels a page states in place are escaped.
 */

import { describe, it, expect } from 'vitest';
import {
  collectionKey,
  generateBlueprintFromBrief,
  resolveActivePreviewPath,
  scaffoldProjectFiles,
} from '../src/lib/studioProject';
import { normalizeManifestForBundle } from '../src/lib/exportBundle';
import { validateProject } from '../src/lib/validator';
import type { ProjectBrief, VFSFile } from '../src/types/studio';

function scaffold(overrides: Partial<ProjectBrief>) {
  const brief: ProjectBrief = {
    appName: 'Test App',
    description: 'A description.',
    target: 'web',
    style: 'clean',
    pages: ['Home'],
    collections: [],
    authNeeded: false,
    ...overrides,
  } as ProjectBrief;
  return scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief));
}

const ui = (files: Array<{ path: string; content: unknown }>) =>
  files
    .filter((f) => f.path.endsWith('.ui'))
    .map((f) => String(f.content))
    .join('\n');

const logicOf = (files: Array<{ path: string; content: unknown }>) =>
  String(files.find((f) => f.path === 'logic/main.logic')!.content);

const toVfs = (files: Array<{ path: string; content: string }>) =>
  new Map<string, VFSFile>(
    files.map((f) => [
      f.path,
      { path: f.path, content: f.content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 },
    ])
  );

describe('the scaffold as a bundle', () => {
  const files = scaffold({ pages: ['Home', 'Settings'], collections: ['Tasks', 'Notes'] });
  const manifest = JSON.parse(String(files.find((f) => f.path === 'manifest.json')!.content));

  it('names ui/main.ui as main, and lists every file it makes by group', () => {
    expect(manifest.main).toBe('ui/main.ui');
    expect(manifest.entry).toBeUndefined();
    const paths = new Set(files.map((f) => f.path));
    for (const group of ['ui', 'logic', 'xdb', 'assets']) {
      for (const p of manifest.files[group]) expect(paths.has(p), `${group} lists ${p}`).toBe(true);
    }
    expect(manifest.files.ui).toEqual(['ui/main.ui', 'ui/pages/home.ui', 'ui/pages/settings.ui']);
    expect(manifest.files.xdb).toEqual(['xdb/tasks.xdb', 'xdb/notes.xdb']);
  });

  it('declares nothing, in a permission.json that is there to be edited', () => {
    const decl = JSON.parse(String(files.find((f) => f.path === 'permission.json')!.content));
    expect(decl).toEqual({ permissions: {} });
  });

  it('imports every page the shell switches between, from a file that exists', () => {
    const main = String(files.find((f) => f.path === 'ui/main.ui')!.content);
    const paths = new Set(files.map((f) => f.path));
    const imports = [...main.matchAll(/<import (\w+) from="\.\/([^"]+)" \/>/g)];
    expect(imports.length).toBe(2);
    for (const [, component, rel] of imports) {
      expect(paths.has(`ui/${rel}`)).toBe(true);
      expect(main).toContain(`<${component} />`);
    }
  });

  it('passes the inspector the export runs, with nothing the directory refuses', () => {
    const problems = validateProject(toVfs(files), null).filter((e) => e.level === 'error');
    expect(problems).toEqual([]);
  });

  it('keeps builder/ out of the exported manifest groups', () => {
    const manifestText = normalizeManifestForBundle(toVfs(files))!;
    expect(manifestText).not.toContain('builder/');
  });
});

describe('an app name carrying markup', () => {
  const files = scaffold({ appName: 'PWN</title><script>alert(1)</script>' });

  it('never reaches a template as markup', () => {
    const out = ui(files);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).not.toContain('</title><script>');
  });

  it('is still what the app shows, as a string in its logic', () => {
    expect(logicOf(files)).toContain(JSON.stringify('PWN</title><script>alert(1)</script>'));
    expect(ui(files)).toContain('{appName}');
  });
});

describe('a description carrying an event handler', () => {
  it('does not survive as an attribute', () => {
    const files = scaffold({ description: 'PWN<img src=x onerror="alert(2)">' });
    expect(ui(files)).not.toContain('onerror="alert(2)"');
    expect(logicOf(files)).toContain(JSON.stringify('PWN<img src=x onerror="alert(2)">'));
  });
});

describe('a collection name carrying markup', () => {
  it('is escaped in the cards it appears on', () => {
    const files = scaffold({ collections: ['PWN<b>Widgets</b>'] });
    const out = ui(files);
    expect(out).not.toContain('<b>Widgets</b>');
    expect(out).toContain('&lt;b&gt;Widgets&lt;/b&gt;');
  });

  it('becomes a collection key the directory and a data alias accept', () => {
    expect(collectionKey('PWN<b>Widgets</b>')).toBe('pwn_b_widgets_b');
    expect(collectionKey('2024 Sales')).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(collectionKey('///')).toBe('items');
    expect(collectionKey('x'.repeat(50)).length).toBeLessThanOrEqual(32);
  });
});

describe('a page name carrying an expression', () => {
  it('cannot open one in the template', () => {
    const files = scaffold({ pages: ['Home', 'X{alert(1)}'] });
    const page = String(files.find((f) => f.path === 'ui/pages/x-alert-1.ui')!.content);
    expect(page).not.toContain('{alert(1)}');
    expect(logicOf(files)).toContain(JSON.stringify('X{alert(1)}'));
  });
});

describe('generated logic', () => {
  it('still parses when the app name contains a quote', () => {
    // The payload that made this necessary: a name that closes the string
    // literal it is interpolated into and appends a statement.
    const files = scaffold({ appName: 'x"); globalThis.__pwned = true; ("' });
    expect(() => new Function(logicOf(files))).not.toThrow();
  });

  it('does not let the app name become code', () => {
    const files = scaffold({ appName: 'x"); globalThis.__pwned = true; ("' });
    const logic = logicOf(files);
    expect(logic).toContain('__pwned');
    expect(logic).not.toMatch(/^\s*globalThis\.__pwned/m);
  });

  it('survives a newline in the app name', () => {
    const files = scaffold({ appName: 'line one\nline two' });
    expect(() => new Function(logicOf(files))).not.toThrow();
  });
});

describe('a name that is only punctuation', () => {
  it('still produces a usable page filename', () => {
    const files = scaffold({ pages: ['///'] });
    const pages = files.filter((f) => f.path.startsWith('ui/pages/')).map((f) => f.path);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p).toMatch(/^ui\/pages\/[a-z0-9-]+\.ui$/);
  });

  it('gives two pages that collapse to one slug different files', () => {
    const files = scaffold({ pages: ['Home', 'home!'] });
    const pages = files.filter((f) => f.path.startsWith('ui/pages/')).map((f) => f.path);
    expect(new Set(pages).size).toBe(2);
  });
});

describe('exporting a project saved in the old shape', () => {
  it('gives the archive a main from entry and true file groups', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: JSON.stringify({ name: 'Old', entry: 'ui/main.ui' }) },
      { path: 'ui/main.ui', content: '<App></App>' },
      { path: 'logic/app.logic', content: 'let x = 1' },
      { path: 'builder/blueprint.json', content: '{}' },
    ]);
    const manifest = JSON.parse(normalizeManifestForBundle(vfs)!);
    expect(manifest.main).toBe('ui/main.ui');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.files).toEqual({ ui: ['ui/main.ui'], logic: ['logic/app.logic'], xdb: [], assets: [] });
  });

  it('is what the validator reports on: a project without an entry file is refused', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: JSON.stringify({ name: 'Old', entry: 'pages/home.html' }) },
      { path: 'pages/home.html', content: '<h1>hi</h1>' },
    ]);
    const report = validateProject(vfs, null);
    expect(report.some((e) => e.level === 'error' && /entry file/.test(e.message))).toBe(false);
    // An HTML page is a file the runtime will not run, but the manifest is honest about it.
    const missing = validateProject(toVfs([{ path: 'manifest.json', content: JSON.stringify({ name: 'Old', entry: 'ui/gone.ui' }) }]), null);
    expect(missing.some((e) => e.level === 'error' && /entry file is not in the bundle/.test(e.message))).toBe(true);
  });
});

describe('preview selection after replacing an imported project', () => {
  const vfs = (...paths: string[]) =>
    new Map<string, VFSFile>(
      paths.map((path) => [
        path,
        {
          path,
          content: '',
          mimeType: 'text/plain',
          lastModified: 0,
          lastModifiedBy: 'user',
          version: 1,
        },
      ])
    );

  it('drops a stale local path and selects an entry that exists in the new VFS', () => {
    const importedFiles = vfs('manifest.json', 'ui/main.ui');

    expect(resolveActivePreviewPath(importedFiles, 'ui/old-project.ui', null)).toBe('ui/main.ui');
    expect(resolveActivePreviewPath(new Map(), 'ui/old-project.ui', null)).toBeNull();
  });

  it('honors a workspace selection only when that file exists', () => {
    const importedFiles = vfs('ui/main.ui', 'ui/details.ui');

    expect(resolveActivePreviewPath(importedFiles, 'ui/main.ui', 'ui/details.ui')).toBe(
      'ui/details.ui'
    );
    expect(resolveActivePreviewPath(importedFiles, 'ui/main.ui', 'ui/missing.ui')).toBe(
      'ui/main.ui'
    );
  });
});
