/**
 * A bundle that comes back says what its manifest says.
 *
 * Studio's export leaves its notes (builder/) behind, so a bundle imported
 * again, straight back or by way of Builder, has its brief and plan worked
 * out from the files. That working out read less than the bundle carries. It
 * made a page of every .ui file, so an app Studio had planned as Home, Sites
 * and About came back as four pages, "Main" first and Home moved to /home,
 * under a manifest whose own `pages` list, written by Studio, named the three
 * with their routes. The description the person had typed was replaced by
 * "Imported SoftN bundle for …", though the manifest carries it. And each
 * collection came back with no fields, with its records, and after Builder
 * its schema, in the file beside it. All three are what the agent is told
 * about the project at the start of every run.
 */

import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProjectContext } from '../src/lib/agent/prompt';
import { buildBundle } from '../src/lib/exportBundle';
import { openImportedInStores } from '../src/lib/importedProject';
import { readProjectArchive } from '../src/lib/projectImport';
import { findPageFile, generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import { validateProject } from '../src/lib/validator';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ProjectBrief, VFSFile } from '../src/types/studio';

const BRIEF: ProjectBrief = {
  appName: 'Field Notes',
  description: 'Notes from the field, by site.',
  target: 'web',
  pages: ['Home', 'Sites', 'About'],
  collections: ['Notes', 'Sites'],
  authNeeded: false,
  style: 'clean',
  referenceImages: [],
  logicLanguage: 'javascript',
};

const vfs = (entries: Array<{ path: string; content: string }>) =>
  new Map<string, VFSFile>(entries.map(({ path, content }) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

/** What Export bundle writes for a new app of this brief, read back as Import reads it. */
function exportedAndReadBack(): Array<{ path: string; content: string | Uint8Array }> {
  return readProjectArchive(buildBundle(vfs(scaffoldProjectFiles(BRIEF, generateBlueprintFromBrief(BRIEF)))));
}

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.getState().resetSession();
});

describe('a bundle Studio exported, imported again', () => {
  it('has the pages its manifest lists, with their routes, and not the shell as a page', () => {
    openImportedInStores('Field Notes.softn', exportedAndReadBack());
    const { blueprint, brief } = useWorkspaceStore.getState();
    expect(blueprint!.pages.map((p) => `${p.name} ${p.route}`)).toEqual(['Home /', 'Sites /sites', 'About /about']);
    expect(blueprint!.pages.map((p) => p.id)).toEqual(['home-page', 'sites-page', 'about-page']);
    expect(brief!.pages).toEqual(['Home', 'Sites', 'About']);
    expect(blueprint!.navigation.items).toEqual(['Home', 'Sites', 'About']);
    // Each is found where the Pages panel and the validator look for it.
    const files = useVFSStore.getState().files;
    expect(blueprint!.pages.map((_, i) => findPageFile(files, blueprint!.pages, i))).toEqual(['ui/pages/home.ui', 'ui/pages/sites.ui', 'ui/pages/about.ui']);
    expect(validateProject(files, blueprint).filter((e) => e.type === 'missing-page-file')).toEqual([]);
    expect(useAIStore.getState().messages[0].content).toMatch(/and mapped 3 page\(s\)/);
  });

  it('has the description the manifest carries, which is the one the person typed', () => {
    openImportedInStores('Field Notes.softn', exportedAndReadBack());
    expect(useWorkspaceStore.getState().brief!.description).toBe('Notes from the field, by site.');
    // A bundle that says nothing of itself is still described as what it is.
    openImportedInStores('pages.softn', [{ path: 'manifest.json', content: JSON.stringify({ name: 'Pages', version: '1.0.0', main: 'ui/main.ui', description: '  ' }) }, { path: 'ui/main.ui', content: '<App />' }]);
    expect(useWorkspaceStore.getState().brief!.description).toMatch(/^Imported SoftN bundle for Pages\./);
  });

  it('has its collections’ fields, read from their records', () => {
    openImportedInStores('Field Notes.softn', exportedAndReadBack());
    const { blueprint } = useWorkspaceStore.getState();
    expect(blueprint!.collections.map((c) => c.name)).toEqual(['Notes', 'Sites']);
    expect(blueprint!.collections[0].fields.map((f) => `${f.name}:${f.type}`)).toEqual(['title:string', 'status:string', 'updatedAt:date']);
  });

  it('tells the agent so at the start of a run', () => {
    openImportedInStores('Field Notes.softn', exportedAndReadBack());
    const context = buildProjectContext('edit');
    expect(context).toContain('- Description: Notes from the field, by site.');
    expect(context).toContain('- Pages: Home (/), Sites (/sites), About (/about)');
    expect(context).toContain('- Collections: Notes [title, status, updatedAt]; Sites [title, status, updatedAt]');
    expect(context).not.toMatch(/Main \(\/\)/);
  });
});

describe('a bundle from another editor', () => {
  const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'Field Notes', version: '1.0.0', main: 'ui/main.ui', ...extra });

  it('has the fields of a collection whose file carries a schema and nested records, as Builder writes it', () => {
    const xdb = JSON.stringify({
      collection: 'notes',
      schema: { alias: 'notes', fields: [{ id: 'field_title', name: 'title', type: 'string', required: true }, { id: 'f2', name: 'count', type: 'number', required: false }, { id: 'f3', name: 'newField', type: 'email', required: false }] },
      records: [{ id: '1', collection: 'notes', data: { title: 'Sample', count: 2, done: false }, created_at: '2026-10-10', updated_at: '2026-10-10', deleted: false }],
    });
    openImportedInStores('field-notes.softn', [{ path: 'manifest.json', content: manifest() }, { path: 'ui/main.ui', content: '<App />' }, { path: 'xdb/notes.xdb', content: xdb }]);
    const [notes] = useWorkspaceStore.getState().blueprint!.collections;
    // The schema's fields first, as it orders them; then what the records hold besides. A type the plan has no word for is text.
    expect(notes.fields).toEqual([
      { name: 'title', type: 'string', required: true },
      { name: 'count', type: 'number', required: false },
      { name: 'newField', type: 'string', required: false },
      { name: 'done', type: 'boolean', required: false },
    ]);
  });

  it('falls back to its .ui files as pages when the manifest lists none, or lists one that is not there or not where a page is looked for', () => {
    const files = [{ path: 'ui/main.ui', content: '<App />' }, { path: 'ui/pages/home.ui', content: '<Text>Home</Text>' }];
    const names = () => useWorkspaceStore.getState().blueprint!.pages.map((p) => p.name);
    openImportedInStores('a.softn', [{ path: 'manifest.json', content: manifest() }, ...files]);
    expect(names()).toEqual(['Main', 'Home']);
    openImportedInStores('a.softn', [{ path: 'manifest.json', content: manifest({ pages: [{ id: 'home-page', name: 'Home', path: 'ui/pages/gone.ui', route: '/' }] }) }, ...files]);
    expect(names()).toEqual(['Main', 'Home']);
    // A page listed under a name the panel would look for in another file: the list is not taken half.
    openImportedInStores('a.softn', [{ path: 'manifest.json', content: manifest({ pages: [{ id: 'x', name: 'Dashboard', path: 'ui/pages/home.ui', route: '/' }] }) }, ...files]);
    expect(names()).toEqual(['Main', 'Home']);
    openImportedInStores('a.softn', [{ path: 'manifest.json', content: manifest({ pages: 'three' }) }, ...files]);
    expect(names()).toEqual(['Main', 'Home']);
  });

  it('is not stopped by a collection file that is not JSON: it has no fields, as before', () => {
    openImportedInStores('a.softn', [{ path: 'manifest.json', content: manifest() }, { path: 'ui/main.ui', content: '<App />' }, { path: 'xdb/notes.xdb', content: '{ not json' }, { path: 'assets/bytes.xdb', content: new Uint8Array(zipSync({ a: strToU8('b') })) }]);
    expect(useWorkspaceStore.getState().blueprint!.collections.map((c) => `${c.name}:${c.fields.length}`)).toEqual(['Notes:0', 'Bytes:0']);
  });
});
