/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LoadedXdbBindings } from '@softn/container';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import { executeTool, type ToolContext } from '../src/lib/agent/executeTool';
import { createStudioSqliteDatabase, detectStudioSqliteDatabases } from '../src/lib/studioSqlite';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import type { ProjectBrief } from '../src/types/studio';

let xdbBindings: LoadedXdbBindings;

async function loadTestXdbBindings(): Promise<LoadedXdbBindings> {
  const enginesDir = path.resolve(__dirname, '../../../packages/@softn/container/dist/runtime/engines');
  const wasmBytes = fs.readFileSync(path.join(enginesDir, 'xdb-wasm.wasm'));
  const module = await WebAssembly.compile(new Uint8Array(wasmBytes));
  // @ts-expect-error -- runtime glue asset has no bundled .d.ts
  const glue = (await import('../../../packages/@softn/container/dist/runtime/engines/xdb-wasm.glue.js')) as {
    initSync: (arg: { module: WebAssembly.Module }) => void;
    WasmConnection: LoadedXdbBindings['WasmConnection'];
  };
  glue.initSync({ module });
  return { WasmConnection: glue.WasmConnection, module };
}

function makeCtx(): ToolContext {
  let tx = 0;
  return {
    seen: new Map(),
    blueprint: null,
    sqliteBindings: xdbBindings,
    newTransactionId: () => `tx-${++tx}`,
    env: {
      checkApp: async () => ({ ok: true, errors: [], warnings: [], renderedHeadless: true, page: 'index.html' }),
      inspectPreview: async () => ({ ok: true, text: 'ok' }),
      runFunction: async () => ({ ok: true, text: 'ok' }),
    },
  };
}

beforeEach(async () => {
  useVFSStore.getState().reset();
  useWorkspaceStore.getState().reset();
  if (!xdbBindings) {
    xdbBindings = await loadTestXdbBindings();
  }
});

describe('Studio AI agent SQLite harness tools', () => {
  it('lists, inspects, queries, mutates, syncs seed SQL, and reverts via VFS undo', async () => {
    useVFSStore.getState().openFiles([
      {
        path: 'manifest.json',
        content: JSON.stringify(
          {
            name: 'Notes SQLite',
            version: '1.0.0',
            engine: 2,
            main: 'index.html',
            backend: { runtime: 'php', entry: 'backend/index.php', mode: 'api', routes: ['/api/'] },
            databases: [{ name: 'app', engine: 'sqlite', file: 'app.db', seedSql: 'backend/schema.sql', persist: true }],
          },
          null,
          2
        ),
      },
      {
        path: 'backend/schema.sql',
        content: `
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
INSERT INTO notes (title, done) VALUES ('Seed note', 0);
`,
      },
    ]);

    const ctx = makeCtx();

    // 1. List databases
    const listed = await executeTool({ id: '1', name: 'sqlite_list_databases', input: {} }, ctx);
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain('app (app.db');
    expect(listed.content).toContain('notes (1 row)');

    // 2. Inspect schema
    const schema = await executeTool({ id: '2', name: 'sqlite_schema', input: { table: 'notes' } }, ctx);
    expect(schema.isError).toBe(false);
    expect(schema.content).toContain('title: TEXT [NOT NULL]');
    expect(schema.content).toContain('CREATE TABLE notes');

    // 3. Read-only query succeeds; mutating query is rejected
    const qOk = await executeTool(
      { id: '3', name: 'sqlite_query', input: { sql: 'SELECT id, title, done FROM notes' } },
      ctx
    );
    expect(qOk.isError).toBe(false);
    expect(qOk.content).toContain('Seed note');

    const qDenied = await executeTool(
      { id: '4', name: 'sqlite_query', input: { sql: 'DELETE FROM notes' } },
      ctx
    );
    expect(qDenied.isError).toBe(true);
    expect(qDenied.content).toContain('read-only');

    // 4. Execute schema migration + insert + sync_seed_sql
    const mutated = await executeTool(
      {
        id: '5',
        name: 'sqlite_execute',
        input: {
          sql: `
            ALTER TABLE notes ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
            INSERT INTO notes (title, done, priority) VALUES ('Ship SQLite harness', 1, 'high');
          `,
          sync_seed_sql: true,
        },
      },
      ctx
    );
    expect(mutated.isError).toBe(false);
    expect(mutated.changed).toBe(true);
    expect(mutated.transactionId).toBe('tx-1');
    expect(mutated.content).toContain('notes (2 rows)');
    expect(mutated.content).toContain('Synced SQL dump to backend/schema.sql');

    // Binary app.db is now in VFS and backend/schema.sql reflects the new column & row
    const dbFile = useVFSStore.getState().files.get('app.db');
    expect(dbFile?.content).toBeInstanceOf(Uint8Array);
    expect((dbFile?.content as Uint8Array).byteLength).toBeGreaterThan(0);
    const syncedSql = useVFSStore.getState().files.get('backend/schema.sql')?.content;
    expect(typeof syncedSql === 'string' && syncedSql.includes('Ship SQLite harness')).toBe(true);
    expect(typeof syncedSql === 'string' && syncedSql.includes('priority')).toBe(true);

    // 5. Querying again reads the persisted binary `.db`
    const qAfter = await executeTool(
      { id: '6', name: 'sqlite_query', input: { sql: 'SELECT title, priority FROM notes ORDER BY id ASC' } },
      ctx
    );
    expect(qAfter.isError).toBe(false);
    expect(qAfter.content).toContain('Ship SQLite harness | high');

    // 6. VFS Undo cleanly reverts the AI transaction (removing app.db and restoring schema.sql)
    useVFSStore.getState().undoLast();
    expect(useVFSStore.getState().files.has('app.db')).toBe(false);
    const revertedSql = useVFSStore.getState().files.get('backend/schema.sql')?.content;
    expect(typeof revertedSql === 'string' && revertedSql.includes('Ship SQLite harness')).toBe(false);
  });

  it('auto-creates app.db and registers manifest.databases when a project has no SQLite DB yet', async () => {
    useVFSStore.getState().openFiles([
      {
        path: 'manifest.json',
        content: JSON.stringify({ name: 'Classic UI App', version: '1.0.0', main: 'index.html' }, null, 2),
      },
    ]);

    const ctx = makeCtx();
    const res = await executeTool(
      {
        id: '1',
        name: 'sqlite_execute',
        input: {
          sql: 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, label TEXT NOT NULL); INSERT INTO tasks (label) VALUES (\'First\');',
        },
      },
      ctx
    );
    expect(res.isError).toBe(false);
    expect(res.changed).toBe(true);
    expect(res.content).toContain('Created app.db');
    expect(res.content).toContain('tasks (1 row)');

    const files = useVFSStore.getState().files;
    expect(files.get('app.db')?.content).toBeInstanceOf(Uint8Array);
    const manifest = JSON.parse(String(files.get('manifest.json')?.content));
    expect(manifest.databases).toEqual([
      expect.objectContaining({ name: 'app', engine: 'sqlite', file: 'app.db', persist: true }),
    ]);
    expect(detectStudioSqliteDatabases(files)).toHaveLength(1);
  });

  // The tool wrote the manifest's new `databases` entry, and the model was taken to have read
  // the manifest it wrote, whole: a write_file of the manifest it remembered went through, and
  // the database was no longer in it. What a tool writes is seen as part of a file: the model
  // may edit it, and reads it before replacing it.
  it('does not count a manifest the tool rewrote as read whole', async () => {
    useVFSStore.getState().openFiles([{ path: 'manifest.json', content: JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'index.html' }, null, 2) }]);
    const ctx = makeCtx();
    expect((await executeTool({ id: 'r', name: 'read_file', input: { path: 'manifest.json' } }, ctx)).isError).toBe(false);
    const made = await executeTool({ id: 'x', name: 'sqlite_execute', input: { sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY)' } }, ctx);
    expect(made.changed).toBe(true);
    const replaced = await executeTool({ id: 'w', name: 'write_file', input: { path: 'manifest.json', content: JSON.stringify({ name: 'Notes', version: '1.1.0', main: 'index.html' }, null, 2) } }, ctx);
    expect(replaced.isError).toBe(true);
    expect(replaced.content).toContain('You have read only part of manifest.json');
    expect(JSON.parse(String(useVFSStore.getState().files.get('manifest.json')?.content)).databases).toHaveLength(1);
    // An exact edit of what is there now is still the model's to make.
    const edited = await executeTool({ id: 'e', name: 'edit_file', input: { path: 'manifest.json', old_string: '"version": "1.0.0"', new_string: '"version": "1.1.0"' } }, ctx);
    expect(edited.isError).toBe(false);
  });

  // The seed dump's path was taken as given: a dump asked to go to index.html, or into Studio's
  // own notes under builder/, which the agent never writes, was written there, over the file.
  it.each(['index.html', 'builder/notes.sql', 'notes.txt'])('refuses to write the seed dump to %s, and writes nothing', async (seedPath) => {
    const page = '<!doctype html><h1>Notes</h1>';
    useVFSStore.getState().openFiles([
      { path: 'manifest.json', content: JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'index.html' }, null, 2) },
      { path: 'index.html', content: page },
      { path: 'builder/notes.sql', content: '-- Studio' },
      { path: 'notes.txt', content: 'mine' },
    ]);
    const before = new Map(useVFSStore.getState().files);
    const res = await executeTool({ id: 'x', name: 'sqlite_execute', input: { sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY)', sync_seed_sql: true, seed_sql_path: seedPath } }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain(seedPath);
    expect(useVFSStore.getState().files).toEqual(before);
  });

  // The engine loads before the database is made, which the first time takes a while: the Data
  // tab's new database, and its entry in the manifest, went into whatever project was open then.
  it('makes no database in a project opened while the engine loaded', async () => {
    const second = JSON.stringify({ name: 'Second', version: '1.0.0', main: 'index.html' }, null, 2);
    useWorkspaceStore.setState({ projectId: 'first' });
    useVFSStore.getState().openFiles([{ path: 'manifest.json', content: JSON.stringify({ name: 'First', version: '1.0.0', main: 'index.html' }, null, 2) }]);
    const creating = createStudioSqliteDatabase('app', { bindings: xdbBindings });
    useWorkspaceStore.setState({ projectId: 'second' });
    useVFSStore.getState().reset();
    useVFSStore.getState().hydrateFiles([{ path: 'manifest.json', content: second }]);
    await expect(creating).rejects.toThrow(/Another project was opened/);
    expect(useVFSStore.getState().files.get('manifest.json')?.content).toBe(second);
    expect(useVFSStore.getState().files.has('app.db')).toBe(false);
  });

  it('scaffolds both .ui + custom PHP/SQLite backend AND Web Container + FormLogic tables', () => {
    const uiPhpBrief: ProjectBrief = {
      appName: 'Classic PHP Notes',
      description: 'Classic .ui frontend with PHP + SQLite backend',
      target: 'web',
      pages: ['Home'],
      collections: [],
      authNeeded: false,
      style: 'clean',
      appFormat: 'ui',
      containerBackend: 'php',
      logicLanguage: 'javascript',
      referenceImages: [],
    };
    const uiFiles = scaffoldProjectFiles(uiPhpBrief, generateBlueprintFromBrief(uiPhpBrief));
    const uiManifest = JSON.parse(uiFiles.find((f) => f.path === 'manifest.json')!.content);
    expect(uiManifest.engine).toBeUndefined();
    expect(uiManifest.backend).toMatchObject({ runtime: 'php', entry: 'backend/index.php', mode: 'api' });
    expect(uiManifest.databases).toEqual([expect.objectContaining({ name: 'app', engine: 'sqlite', file: 'app.db' })]);
    expect(uiFiles.some((f) => f.path === 'backend/index.php')).toBe(true);
    expect(uiFiles.some((f) => f.path === 'backend/schema.sql')).toBe(true);

    const webFlBrief: ProjectBrief = {
      appName: 'Container FormLogic Board',
      description: 'Web Container frontend with FormLogic private SQLite API',
      target: 'web',
      pages: ['Board'],
      collections: ['cards'],
      authNeeded: false,
      style: 'dark',
      appFormat: 'container',
      containerBackend: 'formlogic',
      logicLanguage: 'typescript',
      referenceImages: [],
    };
    const webFiles = scaffoldProjectFiles(webFlBrief, generateBlueprintFromBrief(webFlBrief));
    const webManifest = JSON.parse(webFiles.find((f) => f.path === 'manifest.json')!.content);
    expect(webManifest.engine).toBe(2);
    expect(webManifest.server?.entry).toBe('server/main.logic');
    expect(webManifest.server?.database?.kind).toBe('private-sqlite');
    expect(webFiles.some((f) => f.path === 'server/main.logic')).toBe(true);
    expect(webFiles.some((f) => f.path === 'xdb/cards.xdb')).toBe(true);
  });
});
