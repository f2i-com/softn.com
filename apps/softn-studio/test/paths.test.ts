/**
 * One path contract, the same at every stage.
 *
 * Import validated paths by segment; the orchestrator and the export
 * rejected any path with two adjacent dots and stripped a leading slash
 * instead of refusing it; the validator inspected raw VFS keys while the
 * export wrote normalised ones. So assets/version..png imported, was shown
 * to the model, could not be written back, and vanished from the archive
 * without a word, while the four stages could disagree about what a path
 * even was. SHR-05: every stage asks src/lib/paths.ts, and this table
 * (fixture F10) asserts that import, the VFS/changeset check, validation and
 * export return the same verdict and the same canonical identity for each.
 */

import { describe, expect, it } from 'vitest';
import { normalizeProjectPath, readJsonProject } from '../src/lib/projectImport';
import { isPrivatePath, resolveProjectPath } from '../src/lib/paths';
import { planBundle } from '../src/lib/exportBundle';
import { validateProject } from '../src/lib/validator';
import { buildChangeset } from '../src/lib/changeset';
import type { VFSFile } from '../src/types/studio';

interface Fixture {
  raw: string;
  /** The canonical path, or null when the path is refused. */
  canonical: string | null;
  /** Private editor state: valid, but never exported and never written by the model. */
  isPrivate?: boolean;
  why: string;
}

const FIXTURES: Fixture[] = [
  { raw: 'ui/main.ui', canonical: 'ui/main.ui', why: 'plain' },
  { raw: 'assets/version..png', canonical: 'assets/version..png', why: 'adjacent dots inside a name are not traversal' },
  { raw: 'ui/..hidden.ui', canonical: 'ui/..hidden.ui', why: 'leading dots inside a name are not traversal' },
  { raw: '.hidden', canonical: '.hidden', why: 'a dotfile is a file' },
  { raw: 'ui\\main.ui', canonical: 'ui/main.ui', why: 'backslashes are separators' },
  { raw: '../secret.ui', canonical: null, why: 'traversal segment' },
  { raw: 'ui/../main.ui', canonical: null, why: 'traversal segment inside' },
  { raw: 'ui/./main.ui', canonical: null, why: 'self segment' },
  { raw: '/abs.ui', canonical: null, why: 'absolute' },
  { raw: '\\abs.ui', canonical: null, why: 'absolute with backslash' },
  { raw: 'C:\\abs.ui', canonical: null, why: 'drive' },
  { raw: 'c:/abs.ui', canonical: null, why: 'drive, forward slash' },
  { raw: 'ui/nul\0.ui', canonical: null, why: 'NUL' },
  { raw: 'ui//main.ui', canonical: null, why: 'repeated separator' },
  { raw: '', canonical: null, why: 'empty' },
  { raw: 'ui/', canonical: null, why: 'trailing separator' },
  { raw: 'builder/blueprint.json', canonical: 'builder/blueprint.json', isPrivate: true, why: 'private editor state' },
  { raw: 'Builder/blueprint.json', canonical: 'Builder/blueprint.json', isPrivate: true, why: 'private, other case' },
  { raw: 'builder\\blueprint.json', canonical: 'builder/blueprint.json', isPrivate: true, why: 'private, other separator' },
];

const file = (path: string, content: string | Uint8Array = '{}'): [string, VFSFile] => [
  path,
  { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 },
];

const project = (...extra: Array<[string, VFSFile]>) =>
  new Map<string, VFSFile>([
    file('manifest.json', JSON.stringify({ name: 'App', version: '1.0.0', main: 'ui/main.ui', files: {} })),
    file('ui/main.ui', '<App></App>'),
    ...extra,
  ]);

describe('every stage agrees on each fixture path', () => {
  for (const fx of FIXTURES) {
    it(`${JSON.stringify(fx.raw)} — ${fx.why}`, () => {
      // Import.
      expect(normalizeProjectPath(fx.raw)).toBe(fx.canonical);
      const imported = readJsonProject(JSON.stringify({ files: { [fx.raw]: 'x' } }));
      expect(imported.map((e) => e.path)).toEqual(fx.canonical ? [fx.canonical] : []);

      // The VFS-side check the changeset uses.
      const verdict = resolveProjectPath(fx.raw);
      expect(verdict.ok ? verdict.path : null).toBe(fx.canonical);
      if (verdict.ok) expect(verdict.private).toBe(!!fx.isPrivate);
      if (fx.canonical) expect(isPrivatePath(fx.canonical)).toBe(!!fx.isPrivate);

      // Export and validation, on a project holding the file under its raw
      // key. A spelling of the entry file stands in for it, rather than
      // beside it — two spellings of one file would be a collision, rightly.
      const files =
        fx.canonical === 'ui/main.ui'
          ? new Map<string, VFSFile>([project().entries().next().value as [string, VFSFile], file(fx.raw, '<App></App>')])
          : project(file(fx.raw));
      const plan = planBundle(files);
      const errors = validateProject(files, null).filter((e) => e.level === 'error');
      if (fx.canonical === null) {
        expect(plan.entries.has(fx.raw)).toBe(false);
        expect(plan.problems.some((p) => p.level === 'error' && p.file === fx.raw)).toBe(true);
        expect(errors.some((e) => e.file === fx.raw)).toBe(true);
      } else if (fx.isPrivate) {
        expect([...plan.entries.keys()].some((k) => /builder/i.test(k))).toBe(false);
        expect(plan.problems).toEqual([]);
        expect(errors).toEqual([]);
      } else {
        expect(plan.entries.has(fx.canonical)).toBe(true);
        expect(plan.problems.filter((p) => p.level === 'error')).toEqual([]);
        expect(errors).toEqual([]);
      }

      // The changeset a reply naming this path becomes.
      const changeset = buildChangeset(
        'turn',
        { files: [{ path: fx.raw, content: 'y' }], deletes: [] },
        { supplied: new Map(), versions: new Map() },
        new Map(),
      );
      expect(changeset.records).toHaveLength(1);
      const record = changeset.records[0];
      expect(record.verdict.ok).toBe(fx.canonical !== null && !fx.isPrivate);
      if (fx.canonical !== null) expect(record.path).toBe(fx.canonical);
    });
  }
});

describe('collisions', () => {
  it('are refused at import, in a changeset, in validation and at export alike', () => {
    expect(readJsonProject(JSON.stringify({ files: { 'ui/main.ui': 'a', 'UI/Main.ui': 'b' } }))).toEqual([]);

    const files = project(file('UI/Main.ui', 'other'));
    const plan = planBundle(files);
    expect(plan.problems.filter((p) => p.type === 'path-collision').map((p) => p.file).sort()).toEqual(['UI/Main.ui', 'ui/main.ui']);
    expect(validateProject(files, null).filter((e) => e.type === 'path-collision')).toHaveLength(2);

    // A reply that writes an alias of a file the project already holds.
    const changeset = buildChangeset(
      'turn',
      { files: [{ path: 'UI/Main.ui', content: 'y' }], deletes: [] },
      { supplied: new Map(), versions: new Map([['ui/main.ui', 1]]) },
      project(),
    );
    expect(changeset.ok).toBe(false);
    expect(changeset.records[0].verdict).toMatchObject({ ok: false });
    expect((changeset.records[0].verdict as { reason: string }).reason).toContain('ui/main.ui');
  });
});
