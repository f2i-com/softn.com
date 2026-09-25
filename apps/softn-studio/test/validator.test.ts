/**
 * The validator composes the app the way the runtime will.
 *
 * It used to stop at the bundle inspector, which reads the manifest and does
 * not compose. So a missing `<logic src>` target, JavaScript and Python in one
 * app, inline Python, a reserved or duplicate module name — every one of them
 * passed validation, enabled Run and Export, and then stopped the app at Run.
 * The composer's refusal is now a `bundle-refused` error, which is what holds
 * Run and Export back.
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

const pythonMain = READING_LIST_PYTHON.files.find((f) => f.path === 'ui/main.ui')!.content;

describe('the validator runs the composer', () => {
  it('passes both bundled examples, JavaScript and Python', () => {
    expect(validateProject(toVfs(READING_LIST.files), null).filter((e) => e.level === 'error')).toEqual([]);
    expect(validateProject(toVfs(READING_LIST_PYTHON.files), null).filter((e) => e.level === 'error')).toEqual([]);
  });

  it('refuses a <logic src> whose file is not in the project', () => {
    const errors = refusals(variant(READING_LIST.files, {}, ['logic/main.logic']));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('logic/main.logic is referenced by ui/main.ui but is not in the bundle');
    expect(errors[0].file).toBe('ui/main.ui');
  });

  it('refuses an app that mixes Python and JavaScript logic', () => {
    const mixed = pythonMain.replace('<logic src="../logic/main.py" />', '<logic src="../logic/main.py" />\n<logic>let extra = 1</logic>');
    const errors = refusals(variant(READING_LIST_PYTHON.files, { 'ui/main.ui': mixed }));
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/mixes Python and JavaScript/)]);
  });

  it('refuses inline Python', () => {
    const inline = pythonMain.replace('<logic src="../logic/main.py" />', '<logic lang="python">\ncount = 0\n</logic>');
    const errors = refusals(variant(READING_LIST_PYTHON.files, { 'ui/main.ui': inline }));
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/inline <logic lang="python">/)]);
  });

  it('refuses a module name the runtime reserves', () => {
    const shelf = READING_LIST_PYTHON.files.find((f) => f.path === 'logic/shelf.py')!.content;
    const manifest = JSON.parse(READING_LIST_PYTHON.files.find((f) => f.path === 'manifest.json')!.content);
    manifest.files.logic = ['logic/json.py', 'logic/main.py'];
    const files = variant(
      READING_LIST_PYTHON.files,
      { 'logic/json.py': shelf, 'manifest.json': JSON.stringify(manifest) },
      ['logic/shelf.py'],
    );
    const errors = refusals(files);
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/reserved module name json\.py/)]);
    expect(errors[0].file).toBe('logic/json.py');
  });

  it('refuses two Python files with the same module name', () => {
    const errors = refusals(variant(READING_LIST_PYTHON.files, { 'lib/main.py': 'x = 1\n' }));
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/both named main\.py/)]);
  });

  it('refuses Python server logic, which no backend host runs', () => {
    const errors = refusals(variant(READING_LIST_PYTHON.files, { 'server/api.py': 'def handle(request):\n    return {}\n' }));
    expect(errors.map((e) => e.file)).toEqual(['server/api.py']);
    expect(errors[0].message).toMatch(/runs as JavaScript on every backend host/);
  });
});
