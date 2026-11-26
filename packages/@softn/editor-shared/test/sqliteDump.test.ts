/**
 * A database's SQL dump, run again, is the database it was made from.
 *
 * The dump is what "Sync seed SQL" writes into the project (and what Studio's
 * agent writes with syncSeedSql), and a database with no bytes of its own is
 * built by running that seed. The engine answers a BLOB as `{ "hex": "…" }`,
 * and the dump wrote that as text: every picture or file kept in a column came
 * back from the seed as the string `{"hex":"…"}`.
 *
 * Runs against the real XDB SQLite engine from @softn/container's build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedXdbBindings } from '@softn/container';
import { SqliteSession, type ProjectSqliteDatabase } from '../src/sqliteDatabase';

let bindings: LoadedXdbBindings;

beforeAll(async () => {
  const engines = path.resolve(__dirname, '../../container/dist/runtime/engines');
  const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(path.join(engines, 'xdb-wasm.wasm'))));
  const glue = (await import(/* @vite-ignore */ path.join(engines, 'xdb-wasm.glue.js'))) as {
    initSync: (arg: { module: WebAssembly.Module }) => void;
    WasmConnection: LoadedXdbBindings['WasmConnection'];
  };
  glue.initSync({ module });
  bindings = { WasmConnection: glue.WasmConnection, module };
});

const database: ProjectSqliteDatabase = { id: 'db:app:app.db', name: 'app', file: 'app.db', seedSqlPaths: ['seed.sql'], hasBinary: false, initialBytes: null, walBytes: null, journalBytes: null };

async function open(seed: string): Promise<SqliteSession> {
  return SqliteSession.open(database, (p) => (p === 'seed.sql' ? seed : null), { bindings });
}

describe('exportSqlDump', () => {
  it('rebuilds the same tables, rows and indexes', async () => {
    const original = await open(`
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, price REAL, picture BLOB, notes TEXT);
      CREATE INDEX items_label ON items (label);
      CREATE VIEW cheap AS SELECT label FROM items WHERE price < 5;
      INSERT INTO items (label, price, picture, notes) VALUES ('Flat white; oat', 4.5, X'00ff10', 'it''s "fine"');
      INSERT INTO items (label, price, picture, notes) VALUES ('Café — 东京 ☕', 12, NULL, NULL);
    `);
    let dump: string;
    let rows: unknown[][];
    try {
      rows = original.exec('SELECT id, label, price, hex(picture), notes FROM items ORDER BY id').rows;
      dump = original.exportSqlDump();
    } finally {
      original.close();
    }
    const rebuilt = await open(dump);
    try {
      expect(rebuilt.exec('SELECT id, label, price, hex(picture), notes FROM items ORDER BY id').rows).toEqual(rows);
      expect(rebuilt.exec('SELECT label FROM cheap').rows).toEqual([['Flat white; oat']]);
      expect(rebuilt.getTableStructure('items').indexes.map((i) => i.name)).toContain('items_label');
    } finally {
      rebuilt.close();
    }
  });
});
