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
  findPageFile,
  generateBlueprintFromBrief,
  pageFileCandidates,
  pageSlugs,
  resolveActivePreviewPath,
  scaffoldProjectFiles,
} from '../src/lib/studioProject';
import { buildGuide } from '../src/lib/agent/guide';
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
    .filter((f) => /\.(ui|html)$/.test(f.path))
    .map((f) => String(f.content))
    .join('\n');

const logicOf = (files: Array<{ path: string; content: unknown }>) =>
  String(files.find((f) => f.path === 'main.js')!.content);

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

  it('names index.html as main, and lists every file it makes by group', () => {
    expect(manifest.main).toBe('index.html');
    expect(manifest.entry).toBeUndefined();
    const paths = new Set(files.map((f) => f.path));
    for (const group of ['ui', 'logic', 'xdb', 'assets']) {
      for (const p of manifest.files[group]) expect(paths.has(p), `${group} lists ${p}`).toBe(true);
    }
    expect(manifest.files.ui).toEqual(['index.html', 'pages/home.html', 'pages/settings.html']);
    expect(manifest.files.logic).toEqual(['main.js']);
    expect(manifest.files.xdb).toEqual(['xdb/tasks.xdb', 'xdb/notes.xdb']);
  });

  it('declares nothing, in a permission.json that is there to be edited', () => {
    const decl = JSON.parse(String(files.find((f) => f.path === 'permission.json')!.content));
    expect(decl).toEqual({ permissions: {} });
  });

  it('imports every page the shell switches between, from a file that exists', () => {
    const main = String(files.find((f) => f.path === 'index.html')!.content);
    const paths = new Set(files.map((f) => f.path));
    const imports = [...main.matchAll(/<import (\w+) from="\.\/([^"]+)" \/>/g)];
    expect(imports.length).toBe(2);
    expect(main).toContain('<script src="main.js"></script>');
    for (const [, component, rel] of imports) {
      expect(paths.has(rel)).toBe(true);
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

  // Every new app wore a warning from its first moment, "No icon: the card will show the
  // first letter of the name", which nothing in Studio could act on and the agent was shown
  // after every check. The scaffold comes with an icon: a real one, in the bundle, that the
  // person or the agent can redraw, since an SVG is text.
  it('comes with an icon the directory will show, so a new app starts with nothing to warn about', () => {
    expect(manifest.icon).toBe('assets/icon.svg');
    expect(manifest.files.assets).toEqual(['assets/icon.svg']);
    const icon = String(files.find((f) => f.path === 'assets/icon.svg')!.content);
    expect(icon).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(icon.length).toBeLessThan(2_000);
    // Drawn in the style's accent, with nothing the person typed in it.
    expect(icon).toContain('#14b8a6');
    expect(icon).not.toContain('Test App');
    const notes = validateProject(toVfs(files), null);
    expect(notes.filter((e) => /icon/i.test(e.message))).toEqual([]);
    expect(notes.filter((e) => e.level !== 'info')).toEqual([]);
    // The exported manifest still names it, and the export holds the file.
    expect(JSON.parse(normalizeManifestForBundle(toVfs(files))!).icon).toBe('assets/icon.svg');
  });

  // The agent rewrites manifest.json, and what its guide does not name it does not keep.
  it('is an icon the agent is told about: to keep in the manifest, and that it may redraw', () => {
    for (const python of [false, true]) {
      const guide = buildGuide({ python, torch: false, style: 'clean' });
      expect(guide).toContain('"icon": "assets/icon.svg"');
      expect(guide).toMatch(/Keep it when you rewrite the manifest/);
    }
  });

  it('gives the Python scaffold the same icon', () => {
    const python = scaffold({ logicLanguage: 'python' });
    expect(python.some((f) => f.path === 'assets/icon.svg')).toBe(true);
    expect(validateProject(toVfs(python), null).filter((e) => /icon/i.test(e.message))).toEqual([]);
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
    const page = String(files.find((f) => f.path === 'pages/x-alert-1.html')!.content);
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

// A brief that named no pages was planned as three, Home, Overview and Workspace, with a row
// of buttons to move between them. A one-screen app got two pages nobody asked for, the build
// was told to make them, and what it left alone stayed in the bundle as empty placeholders.
describe('a brief that names no pages', () => {
  const NO_PAGES: ProjectBrief = { appName: 'Counter', description: 'A counter.', target: 'web', style: 'clean', pages: [], collections: [], authNeeded: false, referenceImages: [] };

  it('is planned as one page, and its shell has no row of buttons for moving between pages', () => {
    const blueprint = generateBlueprintFromBrief(NO_PAGES);
    expect(blueprint.pages.map((p) => p.name)).toEqual(['Home']);
    expect(blueprint.navigation.items).toEqual(['Home']);
    const files = scaffold({ pages: [] });
    expect(files.filter((f) => f.path.startsWith('pages/')).map((f) => f.path)).toEqual(['pages/home.html']);
    const main = String(files.find((f) => f.path === 'index.html')!.content);
    expect(main).toContain('<HomePage />');
    expect(main).not.toContain('#each (item in pages)');
    // It is still a bundle the inspector and the composer take.
    expect(validateProject(toVfs(files as Array<{ path: string; content: string }>), blueprint).filter((e) => e.level === 'error')).toEqual([]);
  });

  it('still plans one page when it names collections: the first page lists them', () => {
    const blueprint = generateBlueprintFromBrief({ ...NO_PAGES, appName: 'Tasks', description: 'Tasks.', collections: ['Tasks'] });
    expect(blueprint.pages.map((p) => p.name)).toEqual(['Home']);
  });

  it('keeps the buttons where there are pages to move between', () => {
    const main = String(scaffold({ pages: ['Home', 'Settings'] }).find((f) => f.path === 'index.html')!.content);
    expect(main).toContain('#each (item in pages)');
  });

  it('says nothing in its plan about roles or API providers, which the plan knows nothing of', () => {
    const blueprint = generateBlueprintFromBrief(NO_PAGES);
    expect([...blueprint.risks, ...blueprint.assumptions].join(' ')).not.toMatch(/per role|API provider/i);
    // Nor about data it does not have, or sign-in it was not asked for.
    expect(blueprint.risks.join(' ')).not.toMatch(/collection|authentication/i);
    const withBoth = generateBlueprintFromBrief({ ...NO_PAGES, collections: ['Tasks'], authNeeded: true });
    expect(withBoth.risks.join(' ')).toMatch(/collection-specific validation/);
    expect(withBoth.risks.join(' ')).toMatch(/Authentication flows/);
  });
});

describe('a name that is only punctuation', () => {
  it('still produces a usable page filename', () => {
    const files = scaffold({ pages: ['///'] });
    const pages = files.filter((f) => f.path.startsWith('pages/')).map((f) => f.path);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p).toMatch(/^pages\/[a-z0-9-]+\.html$/);
  });

  it('gives two pages that collapse to one slug different files', () => {
    const files = scaffold({ pages: ['Home', 'home!'] });
    const pages = files.filter((f) => f.path.startsWith('pages/')).map((f) => f.path);
    expect(new Set(pages).size).toBe(2);
  });

  // The second "Home" was numbered home-2 without a look at whether a page called "Home 2"
  // already had that slug: two pages, one file.
  it('gives every page its own file when a name repeats beside one that already carries its number', () => {
    expect(pageSlugs([{ name: 'Home' }, { name: 'Home 2' }, { name: 'Home' }, { name: 'home' }])).toEqual(['home', 'home-2', 'home-3', 'home-4']);
    const files = scaffold({ pages: ['Home', 'Home 2', 'Home'] });
    const pages = files.filter((f) => f.path.startsWith('pages/')).map((f) => f.path);
    expect(new Set(pages).size).toBe(3);
  });

  // Two names for one collection are one collection: the directory keys it by one name, a
  // <data> alias is one name, and both wrote the same .xdb file. The scaffold named that path
  // twice, in its files and in the manifest, and a project cannot hold one path twice.
  it('scaffolds a collection named twice once, with no path written or listed twice', () => {
    const files = scaffold({ collections: ['Tasks', 'tasks', 'Notes', ' TASKS '] });
    const paths = files.map((f) => f.path);
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(paths.length);
    expect(paths.filter((p) => p.startsWith('xdb/'))).toEqual(['xdb/tasks.xdb', 'xdb/notes.xdb']);
    const manifest = JSON.parse(String(files.find((f) => f.path === 'manifest.json')!.content)) as { files: { xdb: string[] } };
    expect(manifest.files.xdb).toEqual(['xdb/tasks.xdb', 'xdb/notes.xdb']);
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

/**
 * One page-path rule. The scaffold writes `pages/<slug>.html`; the pages
 * panel looked in `pages/` and `ui/` only, so a page of a project Studio had
 * just made could not be opened from the panel, and its slug rule differed
 * from the scaffold's and the validator's.
 */
describe('where a blueprint page lives', () => {
  it('finds every scaffolded page, including two whose names collapse to one slug', () => {
    const brief = { appName: 'A', description: 'B', target: 'web', style: 'clean', pages: ['Home', 'Home!', 'Team Settings'], collections: [], authNeeded: false } as unknown as ProjectBrief;
    const blueprint = generateBlueprintFromBrief(brief);
    const vfs = toVfs(scaffoldProjectFiles(brief, blueprint));
    expect(blueprint.pages.map((_page, index) => findPageFile(vfs, blueprint.pages, index))).toEqual([
      'pages/home.html',
      'pages/home-2.html',
      'pages/team-settings.html',
    ]);
    expect(validateProject(vfs, blueprint).filter((e) => e.type === 'missing-page-file')).toEqual([]);
  });

  it('still finds a page in the older and imported shapes, and nothing when there is no file', () => {
    const pages = [{ name: 'About' }, { name: 'Contact' }, { name: 'Missing' }];
    const vfs = toVfs([
      { path: 'ui/about.ui', content: '<Text>About</Text>' },
      { path: 'pages/contact.html', content: '<p>Contact</p>' },
    ]);
    expect(findPageFile(vfs, pages, 0)).toBe('ui/about.ui');
    expect(findPageFile(vfs, pages, 1)).toBe('pages/contact.html');
    expect(findPageFile(vfs, pages, 2)).toBeNull();
    expect(pageFileCandidates(pageSlugs(pages)[2])[0]).toBe('pages/missing.html');
  });
});
