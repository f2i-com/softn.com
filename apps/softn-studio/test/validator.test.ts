/**
 * The validator composes the app the way the runtime will.
 *
 * It used to stop at the bundle inspector, which reads the manifest and does
 * not compose. So a missing `<logic src>` target, JavaScript and Python in one
 * app, inline Python, a reserved or duplicate module name — every one of them
 * passed validation, enabled Run and Export, and then stopped the app at Run.
 * The composer's refusal is now a `bundle-refused` error, which is what holds
 * Run and Export back.
 *
 * Each case runs on both layouts a project can have: the HTML one Studio makes
 * now (`index.html`, `pages/*.html`, `main.js` or `main.py`), and the one it
 * made before (`ui/*.ui`, `logic/*`), which saved projects still have.
 */

import { describe, expect, it } from 'vitest';
import { READING_LIST } from '../src/examples/readingList';
import { READING_LIST_PYTHON } from '../src/examples/readingListPython';
import { validateProject } from '../src/lib/validator';
import type { VFSFile } from '../src/types/studio';

type Files = Array<{ path: string; content: string }>;

const toVfs = (files: Files) =>
  new Map<string, VFSFile>(
    files.map((f) => [
      f.path,
      { path: f.path, content: f.content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 },
    ]),
  );

/** The example with one file replaced (or added) and any listed paths removed. */
function variant(base: Files, changes: Record<string, string>, remove: string[] = []): Map<string, VFSFile> {
  const files = base.filter((f) => !remove.includes(f.path)).map((f) => (f.path in changes ? { ...f, content: changes[f.path] } : f));
  for (const [path, content] of Object.entries(changes)) {
    if (!files.some((f) => f.path === path)) files.push({ path, content });
  }
  return toVfs(files);
}

const refusals = (files: Map<string, VFSFile>) =>
  validateProject(files, null).filter((e) => e.level === 'error' && e.type === 'bundle-refused');

/** Where each file of the examples was in the layout Studio made before the HTML one. */
const LEGACY_PATHS: Record<string, string> = {
  'index.html': 'ui/main.ui',
  'pages/home.html': 'ui/pages/home.ui',
  'pages/about.html': 'ui/pages/about.ui',
  'main.js': 'logic/main.logic',
  'main.py': 'logic/main.py',
  'shelf.py': 'logic/shelf.py',
};

/** An example as it was before it was HTML: the same files under their old names, naming each other by them. */
function legacy(files: Files): Files {
  const rename = (path: string) => LEGACY_PATHS[path] ?? path;
  return files.map((f) => {
    if (f.path === 'manifest.json') {
      const manifest = JSON.parse(f.content) as { main: string; files: Record<string, string[]>; pages: Array<{ path: string }> };
      manifest.main = rename(manifest.main);
      for (const group of Object.keys(manifest.files)) manifest.files[group] = manifest.files[group].map(rename);
      for (const page of manifest.pages) page.path = rename(page.path);
      return { path: f.path, content: JSON.stringify(manifest, null, 2) };
    }
    const content = f.content
      .replace(/from="\.\/pages\/([\w-]+)\.html"/g, 'from="./pages/$1.ui"')
      .replace('<script src="main.js"></script>', '<logic src="../logic/main.logic" />')
      .replace('<script src="main.py"></script>', '<logic src="../logic/main.py" />');
    return { path: rename(f.path), content };
  });
}

interface Layout {
  name: string;
  js: Files;
  python: Files;
  main: string;
  jsLogic: string;
  /** Where Python modules are, and how the main page names main.py. */
  pyDir: string;
  pyRef: string;
}

const LAYOUTS: Layout[] = [
  {
    name: 'the HTML layout Studio makes',
    js: READING_LIST.files,
    python: READING_LIST_PYTHON.files,
    main: 'index.html',
    jsLogic: 'main.js',
    pyDir: '',
    pyRef: '<script src="main.py"></script>',
  },
  {
    name: 'the .ui and .logic layout of projects made before',
    js: legacy(READING_LIST.files),
    python: legacy(READING_LIST_PYTHON.files),
    main: 'ui/main.ui',
    jsLogic: 'logic/main.logic',
    pyDir: 'logic/',
    pyRef: '<logic src="../logic/main.py" />',
  },
];

describe.each(LAYOUTS)('the validator runs the composer, in $name', ({ js, python, main, jsLogic, pyDir, pyRef }) => {
  const pythonMain = python.find((f) => f.path === main)!.content;

  it('passes both bundled examples, JavaScript and Python', () => {
    expect(pythonMain).toContain(pyRef);
    expect(validateProject(toVfs(js), null).filter((e) => e.level === 'error')).toEqual([]);
    expect(validateProject(toVfs(python), null).filter((e) => e.level === 'error')).toEqual([]);
  });

  it('refuses a <logic src> whose file is not in the project', () => {
    const errors = refusals(variant(js, {}, [jsLogic]));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(`${jsLogic} is referenced by ${main} but is not in the bundle`);
    expect(errors[0].file).toBe(main);
  });

  it('refuses an app that mixes Python and JavaScript logic', () => {
    const mixed = pythonMain.replace(pyRef, `${pyRef}\n<logic>let extra = 1</logic>`);
    const errors = refusals(variant(python, { [main]: mixed }));
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/mixes Python and JavaScript/)]);
  });

  it('refuses inline Python', () => {
    const inline = pythonMain.replace(pyRef, '<logic lang="python">\ncount = 0\n</logic>');
    const errors = refusals(variant(python, { [main]: inline }));
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/inline <logic lang="python">/)]);
  });

  it('refuses a module name the runtime reserves', () => {
    const shelf = python.find((f) => f.path === `${pyDir}shelf.py`)!.content;
    const manifest = JSON.parse(python.find((f) => f.path === 'manifest.json')!.content);
    manifest.files.logic = [`${pyDir}json.py`, `${pyDir}main.py`];
    const files = variant(
      python,
      { [`${pyDir}json.py`]: shelf, 'manifest.json': JSON.stringify(manifest) },
      [`${pyDir}shelf.py`],
    );
    const errors = refusals(files);
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/reserved module name json\.py/)]);
    expect(errors[0].file).toBe(`${pyDir}json.py`);
  });

  it('refuses two Python files with the same module name', () => {
    const errors = refusals(variant(python, { 'lib/main.py': 'x = 1\n' }));
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/both named main\.py/)]);
  });

  it('refuses Python server logic, which no backend host runs', () => {
    const errors = refusals(variant(python, { 'server/api.py': 'def handle(request):\n    return {}\n' }));
    expect(errors.map((e) => e.file)).toEqual(['server/api.py']);
    expect(errors[0].message).toMatch(/runs as JavaScript on every backend host/);
  });
});
