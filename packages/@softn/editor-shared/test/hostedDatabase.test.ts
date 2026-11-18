import { describe, expect, it } from 'vitest';
import { createTableMigration, createTableSql, migrationTableNames, nextMigrationFile, type HostedTableDesign } from '../src/hostedDatabase';

const existingSql = '-- Original migration\nCREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n';

it('appends after existing migration paths in the byte order used by the native host', () => {
  const next = (...files: string[]) => nextMigrationFile(files.map(name => 'server/migrations/' + name));
  expect(next('0009_tasks.sql', '0010_notes.sql')).toBe('server/migrations/0011.sql');
  expect(next('999.sql')).toBe('server/migrations/999_001.sql');
  expect(next('002.sql', 'init.sql')).toBe('server/migrations/init_001.sql');
  expect(next('init_009.sql')).toBe('server/migrations/init_010.sql');
});
const server = {
  entry: 'server/customer.logic', routes: [{ method: 'GET', path: '/api/custom' }],
  requires: { apiVersion: 1, capabilities: ['photos'] },
  database: { kind: 'private-sqlite', migrations: ['server/migrations/0002_notes.sql'] },
};
const files = {
  'manifest.json': JSON.stringify({ name: 'Field book', server, files: { xdb: ['xdb/items.xdb'] } }),
  'server/migrations/0002_notes.sql': existingSql,
  'server/migrations/0003_future.sql': '-- Still a draft',
};
const tasks: HostedTableDesign = { name: 'tasks', columns: [
  { name: 'order', type: 'TEXT', required: true }, { name: 'done', type: 'BOOLEAN' },
] };

describe('FormLogic table migrations', () => {
  it('appends a migration after every occupied number and retains the existing source and declarations', () => {
    const result = createTableMigration(files, tasks);
    expect(result.path).toBe('server/migrations/0004.sql');
    expect(result.sql).toBe('CREATE TABLE "tasks" (\n  "id" INTEGER PRIMARY KEY,\n  "order" TEXT NOT NULL,\n  "done" INTEGER CHECK ("done" IN (0, 1))\n);\n');
    expect(JSON.parse(result.manifest)).toEqual({
      name: 'Field book', server: { ...server, requires: { apiVersion: 1, capabilities: ['photos', 'sql'] },
        database: { kind: 'private-sqlite', migrations: [...server.database.migrations, result.path] } }, files: { xdb: ['xdb/items.xdb'] },
    });
    expect(files['server/migrations/0002_notes.sql']).toBe(existingSql);
  });

  it('refuses duplicate table/column names, malformed history and missing migrations', () => {
    expect(() => createTableMigration(files, { ...tasks, name: 'Notes' })).toThrow('already has a table');
    expect(() => createTableSql({ ...tasks, columns: [{ name: 'ID', type: 'INTEGER' }] })).toThrow('already in use');
    expect(() => createTableSql({ ...tasks, name: 'not a name' })).toThrow('letters');
    expect(() => createTableMigration({ 'manifest.json': files['manifest.json'] }, tasks)).toThrow('missing migration');
    const manifest = JSON.parse(files['manifest.json']);
    manifest.server.database.migrations = 'old.sql';
    expect(() => createTableMigration({ 'manifest.json': JSON.stringify(manifest) }, tasks)).toThrow('ordered list');
  });

  it('reads table declarations written by hand, ignoring comments and literal defaults', () => {
    const example = '-- CREATE TABLE shadow(a);\n/* CREATE TABLE more(b); */\nCREATE TABLE IF NOT EXISTS [items] (title TEXT DEFAULT \'CREATE TABLE other(x)\');\nCREATE TABLE "main"."tasks" (id INTEGER);';
    expect(migrationTableNames(example)).toEqual(['items', 'tasks']);
  });
});
